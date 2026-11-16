const axios = require('axios');
const {
    pool,
    FOXY_BASE_URL,
    PROVIDER_TIMEOUT_MS,
    foxyApiHeaders,
    safeAxiosError,
    safeErrorDetail,
} = require('./pendingTransactions');

// ============================================================
// === FUNGSI: SINKRONISASI PRODUK ===
// ============================================================
async function syncProductsWithFoxy() {
    console.log('[cron][sync] Starting smart product sync...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const axiosConfig = {
            headers: foxyApiHeaders,
            timeout: PROVIDER_TIMEOUT_MS
        };

        // 1. Ambil semua produk dari Foxy
        let providerProducts;
        try {
            const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, axiosConfig);
            providerProducts = response.data.data;
        } catch (foxyError) {
            // Safe log — tidak cetak headers atau body HTML Cloudflare
            const safeErr = safeAxiosError(foxyError, 'Foxy');
            if (safeErr.isCloudflareChallenge) {
                console.warn('[cron][sync] Foxy API blocked by Cloudflare challenge. Sync skipped. Check VPS IP whitelist with Foxy support.');
            } else {
                console.error('[cron][sync] Failed to fetch Foxy products:', safeErr);
            }
            await client.query('ROLLBACK');
            throw foxyError;
        }

        if (!Array.isArray(providerProducts)) {
            throw new Error('[cron][sync] Foxy API response format invalid — expected array.');
        }

        const providerSkus = new Set(providerProducts.map(p => p.product_code));

        // 2. Ambil semua produk, game, dan kategori dari DB
        const { rows: localProducts } = await client.query('SELECT id, provider_sku, price, status FROM products');
        const { rows: localGames } = await client.query('SELECT id, name FROM games');
        const localGameMap = new Map(localGames.map(g => [g.name.toLowerCase(), g.id]));
        const { rows: localCategories } = await client.query('SELECT id, game_id, name FROM product_categories');
        const localCategoryMap = new Map(localCategories.map(c => [`${c.game_id}:${c.name.toLowerCase()}`, c.id]));

        const productBatch = {
            gameIds: [],
            categoryIds: [],
            names: [],
            skus: [],
            prices: []
        };

        // 3. Loop produk dari Foxy untuk kumpulkan data batch
        for (const product of providerProducts) {
            const gameName = product.category_title;
            const categoryName = product.category_type;
            const productName = product.product_name;
            const productCode = product.product_code;
            const basePriceFoxy = product.product_price;

            if (!gameName || !productName || !productCode || basePriceFoxy === undefined) continue;

            let gameId = localGameMap.get(gameName.toLowerCase());
            if (!gameId) {
                const { rows: newGame } = await client.query(
                    'INSERT INTO games (name, category, image_url, status) VALUES ($1, $2, $3, $4) RETURNING id',
                    [gameName, categoryName, 'https://via.placeholder.com/200', 'Active']
                );
                gameId = newGame[0].id;
                localGameMap.set(gameName.toLowerCase(), gameId);
            }

            const categoryKey = `${gameId}:${categoryName.toLowerCase()}`;
            let categoryId = localCategoryMap.get(categoryKey);
            if (!categoryId) {
                const { rows: newCat } = await client.query(
                    'INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id',
                    [gameId, categoryName]
                );
                categoryId = newCat[0].id;
                localCategoryMap.set(categoryKey, categoryId);
            }

            productBatch.gameIds.push(gameId);
            productBatch.categoryIds.push(categoryId);
            productBatch.names.push(productName);
            productBatch.skus.push(productCode);
            productBatch.prices.push(basePriceFoxy);
        }

        // 4. Jalankan UPSERT batch
        // CATATAN PENTING: DO UPDATE tidak mengubah status.
        // Admin bisa set produk Inactive manual — sync Foxy tidak boleh menimpa kembali ke Active.
        // Status hanya di-set saat INSERT baru (default 'Active').
        if (productBatch.skus.length > 0) {
            await client.query(`
                INSERT INTO products (game_id, category_id, name, provider_sku, price, status)
                SELECT * FROM unnest($1::int[], $2::int[], $3::varchar[], $4::varchar[], $5::decimal[], $6::varchar[])
                ON CONFLICT (provider_sku) DO UPDATE SET
                    game_id = EXCLUDED.game_id,
                    category_id = EXCLUDED.category_id,
                    name = EXCLUDED.name,
                    price = EXCLUDED.price,
                    updated_at = NOW()
            `, [
                productBatch.gameIds,
                productBatch.categoryIds,
                productBatch.names,
                productBatch.skus,
                productBatch.prices,
                productBatch.skus.map(() => 'Active')  // Hanya untuk INSERT baru
            ]);
            console.log(`[cron][sync] Upserted ${productBatch.skus.length} product(s).`);
        }

        // 5. Nonaktifkan produk lokal yang tidak ada di Foxy
        const deactivateIds = localProducts
            .filter(lp => lp.status === 'Active' && !providerSkus.has(lp.provider_sku))
            .map(lp => lp.id);

        if (deactivateIds.length > 0) {
            await client.query(
                'UPDATE products SET status = $1, updated_at = NOW() WHERE id = ANY($2::int[])',
                ['Inactive', deactivateIds]
            );
            console.log(`[cron][sync] Deactivated ${deactivateIds.length} product(s) no longer at provider.`);
        }

        await client.query('COMMIT');
        console.log('[cron][sync] Smart product sync finished successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        // Hindari double-log jika sudah di-log di atas (Cloudflare case)
        if (!error._cronLogged) {
            console.error('[cron][sync] Product sync failed:', safeErrorDetail(error));
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    syncProductsWithFoxy,
    pool,
};
