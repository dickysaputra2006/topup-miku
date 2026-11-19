const { getFoxyProducts } = require('./foxyClient');

/**
 * Hitung harga jual dari modal dan persentase margin dengan pembulatan ke atas.
 */
function calculateMarginSellingPrice(basePrice, marginPercent) {
    return Math.ceil(Number(basePrice) * (1 + (Number(marginPercent) / 100)));
}

/**
 * Hitung daftar harga katalog produk publik berdasarkan role user, flash sale,
 * harga manual, margin kustom per game, dan margin global role.
 */
function calculateCatalogProducts(products, userRoleName, globalMarginsMap, flashSaleMap) {
    return products.map(p => {
        const manualPrice = p.manual_prices ? p.manual_prices[userRoleName] : null;
        let normalPrice;
        // PRIORITAS 1: HARGA MANUAL
        if (p.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
            normalPrice = Number(manualPrice);
        } else {
            let margin = globalMarginsMap[userRoleName] || 0; // Default: margin global
            // PRIORITAS 2: MARGIN PER GAME
            if (p.use_custom_margin) {
                const customMargin = p[`${userRoleName}_margin`];
                if (customMargin !== null && customMargin !== undefined) {
                    margin = customMargin;
                }
            }
            normalPrice = Math.ceil(Number(p.base_price) * (1 + Number(margin) / 100));
        }

        let finalPrice = normalPrice;
        let originalPrice = null;
        let isFlashSale = false;

        // PRIORITAS 0: FLASH SALE (hanya jika harga flash sale valid dan lebih murah dari harga normal)
        if (flashSaleMap.has(p.id)) {
            const flashPrice = Number(flashSaleMap.get(p.id));
            if (Number.isFinite(flashPrice) && flashPrice > 0 && flashPrice < normalPrice) {
                isFlashSale = true;
                finalPrice = flashPrice;
                originalPrice = normalPrice;
            }
        }

        return {
            id: p.id,
            name: p.name,
            provider_sku: p.provider_sku,
            price: finalPrice,
            isFlashSale: isFlashSale,
            originalPrice: originalPrice
        };
    });
}

/**
 * Ambil detail game aktif beserta daftar produk dan harga jual sesuai role user.
 */
async function getGameProductsCatalog({ pool, gameId, user }) {
    let userRoleId = 1;
    let userRoleName = 'bronze';

    if (user) {
        const { rows: userRows } = await pool.query(
            'SELECT role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1',
            [user.id]
        );
        if (userRows.length > 0) {
            userRoleId = userRows[0].role_id;
            userRoleName = userRows[0].role_name.toLowerCase();
        }
    }

    const { rows: games } = await pool.query(
        "SELECT name, image_url, needs_server_id, target_id_label FROM games WHERE id = $1 AND status = 'Active'",
        [gameId]
    );
    if (games.length === 0) {
        return { notFound: true };
    }

    const { rows: products } = await pool.query(`
        SELECT p.id, p.name, p.provider_sku, p.price as base_price, 
               p.use_manual_prices, p.manual_prices,
               gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
        FROM products p
        LEFT JOIN game_margins gm ON p.game_id = gm.game_id
        WHERE p.game_id = $1 AND p.status = 'Active'
        ORDER BY p.price ASC
    `, [gameId]);

    const { rows: activeFlashSales } = await pool.query(`
        SELECT product_id, discount_price FROM flash_sales
        WHERE is_active = true
          AND NOW() BETWEEN start_at AND end_at
          AND (max_uses IS NULL OR uses_count < max_uses)
    `);
    const flashSaleMap = new Map(activeFlashSales.map(fs => [fs.product_id, Number(fs.discount_price)]));

    const { rows: globalMargins } = await pool.query('SELECT name, margin_percent FROM roles');
    const globalMarginsMap = globalMargins.reduce((acc, role) => {
        acc[role.name.toLowerCase()] = role.margin_percent;
        return acc;
    }, {});

    const finalProducts = calculateCatalogProducts(products, userRoleName, globalMarginsMap, flashSaleMap);

    return {
        notFound: false,
        body: { game: games[0], products: finalProducts }
    };
}

/**
 * Hitung harga efektif produk untuk validasi promo (manual > custom margin > global margin > flash sale).
 */
async function calculateEffectiveProductPriceForPromo(client, { product, userId, productId }) {
    const { rows: userRows } = await client.query(
        'SELECT role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1',
        [userId]
    );
    const userRoleName = (userRows.length > 0 ? userRows[0].role_name : 'bronze').toLowerCase();
    const userRoleId = userRows.length > 0 ? userRows[0].role_id : 1;

    let effectivePrice;
    const manualPrice = product.manual_prices ? product.manual_prices[userRoleName] : null;
    if (product.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
        effectivePrice = Number(manualPrice);
    } else {
        const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [userRoleId]);
        let margin = roleRows.length > 0 ? Number(roleRows[0].margin_percent) : 0;
        if (product.use_custom_margin) {
            const customMargin = product[`${userRoleName}_margin`];
            if (customMargin !== null && customMargin !== undefined) {
                margin = Number(customMargin);
            }
        }
        effectivePrice = calculateMarginSellingPrice(product.price, margin);
    }

    const { rows: fsRows } = await client.query(
        `SELECT discount_price FROM flash_sales WHERE product_id = $1 AND is_active = true AND NOW() BETWEEN start_at AND end_at AND (max_uses IS NULL OR uses_count < max_uses) LIMIT 1`,
        [productId]
    );
    if (fsRows.length > 0) {
        const flashPrice = Number(fsRows[0].discount_price);
        if (flashPrice > 0 && flashPrice < effectivePrice) {
            effectivePrice = flashPrice;
        }
    }

    return effectivePrice;
}

/**
 * Hitung nilai diskon promo dan harga akhir (minimal Rp 1).
 */
function calculatePromoDiscount(effectivePrice, promo, rules = {}) {
    let discount = 0;
    if (promo.type === 'percentage') {
        discount = Math.floor(effectivePrice * Number(promo.value) / 100);
        if (rules.max_discount_amount && Number(rules.max_discount_amount) > 0 && discount > Number(rules.max_discount_amount)) {
            discount = Math.floor(Number(rules.max_discount_amount));
        }
    } else if (promo.type === 'fixed') {
        discount = Math.floor(Number(promo.value));
    }
    if (discount >= effectivePrice) {
        discount = effectivePrice - 1;
    }
    if (discount < 0) discount = 0;
    return {
        discount,
        finalPrice: effectivePrice - discount
    };
}

/**
 * Ambil modal produk real-time dari Foxy dengan fallback ke modal lokal DB bila Foxy gagal diakses.
 */
async function fetchProviderCostWithFallback(providerSku, fallbackCost) {
    let providerCost = Number(fallbackCost) || 0;
    try {
        const providerProducts = await getFoxyProducts();
        const currentFoxyProduct = providerProducts
            ? providerProducts.find(p => p.product_code === providerSku)
            : null;
        if (currentFoxyProduct && Number.isFinite(Number(currentFoxyProduct.product_price))) {
            providerCost = Number(currentFoxyProduct.product_price);
        }
    } catch (_foxyErr) {
        // Fallback ke product.price lokal jika Foxy tidak dapat diakses saat validasi promo
    }
    return providerCost;
}

/**
 * Validasi kode promo terhadap aturan kuota, harga efektif, diskon, dan guard modal provider (SEC-003).
 */
async function validatePromoCodeForProduct({ pool, userId, promoCode, productId, targetGameId }) {
    const client = await pool.connect();
    try {
        const promoRes = await client.query('SELECT * FROM promo_codes WHERE code = $1 AND is_active = true', [promoCode.toUpperCase()]);
        if (promoRes.rows.length === 0) {
            return { statusCode: 404, body: { valid: false, message: 'Kode promo tidak ditemukan atau tidak aktif.' } };
        }
        const promo = promoRes.rows[0];
        const rules = promo.rules || {};

        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
            return { statusCode: 400, body: { valid: false, message: 'Kode promo sudah kedaluwarsa.' } };
        }
        if (promo.max_uses && promo.uses_count >= promo.max_uses) {
            return { statusCode: 400, body: { valid: false, message: 'Kuota penggunaan promo ini sudah habis.' } };
        }

        if (rules.max_uses_per_user) {
            const usageRes = await client.query(
                'SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND (user_id = $2 OR customer_game_id = $3)',
                [promo.id, userId, targetGameId]
            );
            const userUsageCount = parseInt(usageRes.rows[0].count, 10);
            if (userUsageCount >= Number(rules.max_uses_per_user)) {
                return { statusCode: 400, body: { valid: false, message: `Anda sudah mencapai batas maksimal penggunaan kode ini (${rules.max_uses_per_user}x).` } };
            }
        }

        const productRes = await client.query(`
            SELECT p.*, g.id as game_id,
                   p.use_manual_prices, p.manual_prices,
                   gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
            FROM products p
            JOIN games g ON p.game_id = g.id
            LEFT JOIN game_margins gm ON p.game_id = gm.game_id
            WHERE p.id = $1 AND p.status = 'Active' AND g.status = 'Active'
        `, [productId]);
        if (productRes.rows.length === 0) {
            return { statusCode: 404, body: { valid: false, message: 'Produk tidak ditemukan.' } };
        }
        const product = productRes.rows[0];

        const effectivePrice = await calculateEffectiveProductPriceForPromo(client, { product, userId, productId });

        if (rules.min_price && effectivePrice < rules.min_price) {
            return { statusCode: 400, body: { valid: false, message: `Promo ini hanya berlaku untuk pembelian minimal Rp ${rules.min_price}.` } };
        }
        if (rules.allowed_game_ids && !rules.allowed_game_ids.includes(product.game_id)) {
            return { statusCode: 400, body: { valid: false, message: 'Promo ini tidak berlaku untuk game ini.' } };
        }
        if (rules.allowed_product_ids && !rules.allowed_product_ids.includes(product.id)) {
            return { statusCode: 400, body: { valid: false, message: 'Promo ini tidak berlaku untuk produk ini.' } };
        }

        const { discount, finalPrice } = calculatePromoDiscount(effectivePrice, promo, rules);
        const providerCost = await fetchProviderCostWithFallback(product.provider_sku, product.price);

        if (finalPrice < providerCost) {
            return {
                statusCode: 400,
                body: {
                    valid: false,
                    message: 'Kode promo tidak dapat digunakan karena membuat harga akhir di bawah harga modal produk.'
                }
            };
        }

        return {
            statusCode: 200,
            body: {
                valid: true,
                message: 'Kode promo berhasil digunakan!',
                promo_code: promo.code,
                discount: discount,
                original_price: effectivePrice,
                final_price: finalPrice
            }
        };
    } finally {
        client.release();
    }
}

module.exports = {
    calculateMarginSellingPrice,
    calculateCatalogProducts,
    getGameProductsCatalog,
    calculateEffectiveProductPriceForPromo,
    calculatePromoDiscount,
    fetchProviderCostWithFallback,
    validatePromoCodeForProduct,
};
