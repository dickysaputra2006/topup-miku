const express = require('express');
const { FOXY_API_KEY } = require('../../config/env');
const { logSafeError } = require('../../utils/logger');
const {
    getBodyObject,
    requireString,
    requirePositiveInt,
    requireBoundedNumber,
    requireEnum,
} = require('../../utils/schemaValidators');
const { syncProductsWithFoxy } = require('../../jobs/productSync');
const { invalidateFoxyProductCache } = require('../../services/foxyClient');

/**
 * Validasi dan sanitasi objek validation_config sebelum disimpan ke DB.
 * @param {*} validation_config - Input dari request body
 * @returns {{ error: string } | { safe: object|null }} error string jika tidak valid, atau safe config
 */
function sanitizeValidationConfig(validation_config) {
    // null / undefined → simpan null (hapus config)
    if (validation_config === null || validation_config === undefined) {
        return { safe: null };
    }
    if (typeof validation_config !== 'object' || Array.isArray(validation_config)) {
        return { error: 'validation_config harus berupa object atau null.' };
    }
    if (validation_config.enabled === true) {
        const validator = validation_config.validator;
        if (!validator || typeof validator !== 'string' || !validator.trim()) {
            return { error: 'validator wajib diisi jika enabled=true.' };
        }
        if (!/^[a-zA-Z0-9_\-]{1,80}$/.test(validator.trim())) {
            return { error: 'validator hanya boleh berisi huruf, angka, dash, underscore (maks. 80 karakter).' };
        }

        // === Validasi khusus Mobapay Eligibility ===
        if (validator.trim() === 'mobapay-mlbb-eligibility') {
            // country: opsional, jika ada harus 2–5 huruf
            if (validation_config.country !== undefined && validation_config.country !== null) {
                if (typeof validation_config.country !== 'string' || !/^[A-Za-z]{2,5}$/.test(validation_config.country)) {
                    return { error: 'country harus string kode negara 2–5 huruf (contoh: ID).' };
                }
            }
            // checks: opsional array string
            const VALID_MOBAPAY_CHECKS = ['wdp_available', 'double_diamond', 'weekly_elite', 'monthly_epic', 'payment_channel', 'region_id'];
            if (validation_config.checks !== undefined && validation_config.checks !== null) {
                if (!Array.isArray(validation_config.checks)) {
                    return { error: 'checks harus berupa array string.' };
                }
                for (const c of validation_config.checks) {
                    if (typeof c !== 'string' || !VALID_MOBAPAY_CHECKS.includes(c)) {
                        return { error: `checks mengandung nilai tidak valid: "${c}". Nilai yang diizinkan: ${VALID_MOBAPAY_CHECKS.join(', ')}.` };
                    }
                }
                // double_diamond wajib ada rules.target
                if (validation_config.checks.includes('double_diamond')) {
                    const target = validation_config.rules && validation_config.rules.target;
                    const VALID_DD = ['50+50', '150+150', '250+250', '500+500'];
                    if (!target || !VALID_DD.includes(target)) {
                        return { error: `double_diamond memerlukan rules.target yang valid. Nilai yang diizinkan: ${VALID_DD.join(', ')}.` };
                    }
                }
            }
            // rules.allowedPaymentCountries: jika ada harus array string country code
            if (validation_config.rules && validation_config.rules.allowedPaymentCountries !== undefined) {
                const apc = validation_config.rules.allowedPaymentCountries;
                if (!Array.isArray(apc)) {
                    return { error: 'rules.allowedPaymentCountries harus berupa array string.' };
                }
                for (const cc of apc) {
                    if (typeof cc !== 'string' || !/^[A-Za-z]{2,5}$/.test(cc)) {
                        return { error: `rules.allowedPaymentCountries mengandung nilai tidak valid: "${cc}".` };
                    }
                }
            }
        } else {
            // === Validasi PGS / validator lain (existing behavior) ===
            if (validation_config.rules !== undefined && validation_config.rules !== null) {
                if (typeof validation_config.rules !== 'object' || Array.isArray(validation_config.rules)) {
                    return { error: 'rules harus berupa object.' };
                }
                const safeRegion = /^[a-zA-Z0-9_\-]{1,10}$/;
                for (const field of ['allowedRegions', 'disallowedRegions']) {
                    const val = validation_config.rules[field];
                    if (val !== undefined && val !== null) {
                        if (!Array.isArray(val)) {
                            return { error: `rules.${field} harus berupa array string.` };
                        }
                        for (const region of val) {
                            if (typeof region !== 'string' || !safeRegion.test(region)) {
                                return { error: `rules.${field} mengandung nilai tidak valid: "${region}".` };
                            }
                        }
                    }
                }
            }
        }
    }
    // enabled=false atau tidak ada enabled: simpan apa adanya
    return { safe: validation_config };
}

/**
 * Daftarkan route admin untuk manajemen produk, status produk, dan pengaturan validasi produk.
 */
module.exports = function createAdminProductsRoutes(deps) {
    const { pool, protectAdmin } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminProductsRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminProductsRoutes requires a protectAdmin middleware');
    }

    const router = express.Router();

    router.get('/api/admin/products', protectAdmin, async (req, res) => {
        try {
             const sqlProducts = `SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, p.status, p.validation_config, g.name as game_name 
                                 FROM products p JOIN games g ON p.game_id = g.id 
                                 ORDER BY g.name ASC, p.price ASC, p.name ASC`; 
            const { rows: products } = await pool.query(sqlProducts);

            // Ambil semua margin role
            const sqlRoles = `SELECT id, name, margin_percent FROM roles ORDER BY id ASC`;
            const { rows: roles } = await pool.query(sqlRoles);

            const roleMargins = {};
            roles.forEach(role => {
                roleMargins[role.id] = parseFloat(role.margin_percent);
            });

            const productsWithRolePrices = products.map(product => {
                const productWithPrices = { ...product };
                roles.forEach(role => {
                    const margin = roleMargins[role.id] || 0;
                    const sellingPrice = product.price * (1 + (margin / 100));
                    productWithPrices[`price_${role.name.toLowerCase()}`] = Math.ceil(sellingPrice);
                });
                return productWithPrices;
            });

            res.json(productsWithRolePrices);
        } catch (error) {
            logSafeError('Error fetching admin products with role prices:', error);
            res.status(500).json({ message: 'Server error saat mengambil data produk dengan harga role.' });
        }
    });

    router.post('/api/admin/products', protectAdmin, async (req, res) => {
        try {
            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const gameIdRes = requirePositiveInt(body.game_id, 'game_id');
            if (gameIdRes.error) return res.status(400).json({ message: gameIdRes.error });

            const categoryIdRes = requirePositiveInt(body.category_id, 'category_id');
            if (categoryIdRes.error) return res.status(400).json({ message: categoryIdRes.error });

            const nameRes = requireString(body.name, 'Nama produk', { min: 1, max: 200 });
            if (nameRes.error) return res.status(400).json({ message: nameRes.error });

            const skuRes = requireString(body.provider_sku, 'SKU provider', {
                min: 1,
                max: 100,
                pattern: /^[A-Za-z0-9_.\-:]{1,100}$/,
            });
            if (skuRes.error) return res.status(400).json({ message: skuRes.error });

            const priceRes = requireBoundedNumber(body.price, 'Harga produk', { min: 1, max: 100000000 });
            if (priceRes.error) return res.status(400).json({ message: priceRes.error });

            const sql = 'INSERT INTO products (game_id, category_id, name, provider_sku, price, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_sku) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, game_id = EXCLUDED.game_id, category_id = EXCLUDED.category_id, status = EXCLUDED.status';
            await pool.query(sql, [gameIdRes.value, categoryIdRes.value, nameRes.value, skuRes.value, priceRes.value, 'Active']);
            res.status(201).json({ message: `Produk ${nameRes.value} berhasil ditambahkan.` });
        } catch (error) {
            logSafeError('Error adding product:', error);
            if (error.code === '23505') return res.status(409).json({ message: 'SKU Provider sudah ada.' });
            res.status(500).json({ message: 'Server error saat menambah produk.' });
        }
    });

    router.put('/api/admin/products/:id/status', protectAdmin, async (req, res) => {
        try {
            const idRes = requirePositiveInt(req.params.id, 'ID produk');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });

            const statusRes = requireEnum(bodyRes.value.status, 'Status', ['Active', 'Inactive']);
            if (statusRes.error) {
                return res.status(400).json({ message: "Status tidak valid. Gunakan 'Active' atau 'Inactive'." });
            }

            const { rowCount } = await pool.query(
                'UPDATE products SET status = $1 WHERE id = $2',
                [statusRes.value, idRes.value]
            );

            if (rowCount === 0) {
                return res.status(404).json({ message: 'Produk tidak ditemukan.' });
            }

            res.json({ message: `Status produk berhasil diubah menjadi ${statusRes.value}.` });

        } catch (error) {
            logSafeError('Error updating product status:', error);
            res.status(500).json({ message: 'Gagal memperbarui status produk.' });
        }
    });

    router.put('/api/admin/products/:id/validation', protectAdmin, async (req, res) => {
        try {
            const idRes = requirePositiveInt(req.params.id, 'ID produk');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const { validation_config } = bodyRes.value;

            const { error, safe: safeConfig } = sanitizeValidationConfig(validation_config);
            if (error) return res.status(400).json({ message: error });

            const { rowCount } = await pool.query(
                'UPDATE products SET validation_config = $1 WHERE id = $2',
                [safeConfig, idRes.value]
            );
            if (rowCount === 0) return res.status(404).json({ message: 'Produk tidak ditemukan.' });
            res.json({ message: 'Pengaturan validasi produk berhasil diperbarui.' });
        } catch (error) {
            logSafeError('Error updating product validation:', error);
            res.status(500).json({ message: 'Gagal memperbarui pengaturan validasi.' });
        }
    });

    router.put('/api/admin/products/bulk-validation', protectAdmin, async (req, res) => {
        try {
            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const { productIds, validation_config } = bodyRes.value;

            if (!Array.isArray(productIds) || productIds.length === 0) {
                return res.status(400).json({ message: 'productIds harus berupa array dan tidak boleh kosong.' });
            }
            if (productIds.length > 500) {
                return res.status(400).json({ message: 'Maksimal 500 produk dalam satu batch.' });
            }
            const safeIds = [];
            for (const rawId of productIds) {
                const itemRes = requirePositiveInt(rawId, 'productId');
                if (itemRes.error) {
                    return res.status(400).json({ message: 'Setiap productId harus berupa angka positif.' });
                }
                safeIds.push(itemRes.value);
            }

            const { error, safe: safeConfig } = sanitizeValidationConfig(validation_config);
            if (error) return res.status(400).json({ message: error });

            const { rowCount } = await pool.query(
                'UPDATE products SET validation_config = $1 WHERE id = ANY($2::int[])',
                [safeConfig, safeIds]
            );
            res.json({ message: `Pengaturan validasi berhasil diperbarui untuk ${rowCount} produk.` });
        } catch (error) {
            logSafeError('Error updating bulk product validation:', error);
            res.status(500).json({ message: 'Gagal memperbarui pengaturan validasi massal.' });
        }
    });

    router.post('/api/admin/sync-products', protectAdmin, async (req, res) => {
        try {
            const activeFoxyKey = process.env.FOXY_API_KEY !== undefined ? process.env.FOXY_API_KEY : FOXY_API_KEY;
            if (!activeFoxyKey || !String(activeFoxyKey).trim()) {
                return res.status(400).json({
                    message: 'FOXY_API_KEY belum diatur di file .env. Isi API key Foxy atau gunakan data seeder lokal untuk pengujian.'
                });
            }

            const rawMargin = req.body ? req.body.margin_percent : undefined;
            let effectiveMargin = null;

            if (rawMargin !== undefined && rawMargin !== null && String(rawMargin).trim() !== '') {
                const marginRes = requireBoundedNumber(rawMargin, 'Persentase margin', { min: 0, max: 500 });
                if (marginRes.error) {
                    return res.status(400).json({ message: 'Persentase margin tidak valid.' });
                }
                effectiveMargin = marginRes.value;
            } else {
                const { rows: roleRows } = await pool.query(
                    "SELECT margin_percent FROM roles WHERE LOWER(name) = 'bronze' ORDER BY id ASC LIMIT 1"
                );
                effectiveMargin = roleRows.length > 0 && roleRows[0].margin_percent !== null
                    ? Number(roleRows[0].margin_percent)
                    : 10;
            }

            await syncProductsWithFoxy(effectiveMargin);
            invalidateFoxyProductCache();

            res.json({ message: `Sinkronisasi produk berhasil dipicu dengan margin ${effectiveMargin}%.` });
        } catch (error) {
            logSafeError('Manual sync trigger error:', error);
            res.status(500).json({ message: 'Gagal memicu sinkronisasi manual. Cek log server.' });
        }
    });

    return router;
};
