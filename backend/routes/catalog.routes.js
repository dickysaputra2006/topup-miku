const express = require('express');
const { logSafeError } = require('../utils/logger');
const { validateGameId } = require('../utils/validators/cek-id-game.js');
const { checkAllMobapayPromosML, checkMobapayMlbbEligibility } = require('../utils/validators/stalk-ml-promo.js');
const { cekPromoMcggMobapay } = require('../utils/validators/stalk-mcgg.js');
const {
    getGameProductsCatalog,
    validatePromoCodeForProduct,
} = require('../services/priceService');

/**
 * Daftarkan route katalog publik berharga dinamis, validasi ID game/promo, dan validasi kode promo.
 */
module.exports = function createCatalogRoutes(deps) {
    const { pool, protect, softProtect } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createCatalogRoutes requires a valid pool');
    }
    if (typeof protect !== 'function') {
        throw new TypeError('createCatalogRoutes requires a protect middleware');
    }
    if (typeof softProtect !== 'function') {
        throw new TypeError('createCatalogRoutes requires a softProtect middleware');
    }

    const router = express.Router();

    // Endpoint pre-validasi di halaman produk
    // Phase 5C-2A HOTFIX: dispatch ke Mobapay eligibility engine jika validatornya bukan PGS
    router.post('/api/products/:productId/validate', async (req, res) => {
        const { productId } = req.params;
        const { userId, zoneId } = req.body;
        if (!userId) return res.status(400).json({ success: false, message: 'User ID wajib diisi.' });
        try {
            // HOTFIX: needs_server_id is on the games table, not products.
            // Use a LEFT JOIN so we never query a non-existent column on products.
            const { rows } = await pool.query(
                `SELECT
                    p.id,
                    p.name,
                    p.validation_config,
                    p.game_id,
                    COALESCE(g.needs_server_id, false) AS needs_server_id
                 FROM products p
                 LEFT JOIN games g ON g.id = p.game_id
                 WHERE p.id = $1`,
                [productId]
            );
            if (rows.length === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
            const config = rows[0].validation_config;

            // Tidak ada config atau config tidak aktif → tidak perlu validasi
            if (!config || config.enabled !== true || !config.validator) {
                return res.json({ success: true, message: 'Produk ini tidak memerlukan validasi.' });
            }

            const validatorName = String(config.validator).trim();
            const effectiveZoneId = rows[0].needs_server_id ? (zoneId || null) : null;

            // === Phase 5C-2A: Mobapay MLBB Eligibility ===
            if (validatorName === 'mobapay-mlbb-eligibility') {
                let mobapayResult;
                try {
                    mobapayResult = await checkMobapayMlbbEligibility(
                        userId,
                        effectiveZoneId,
                        config.checks || [],
                        config.rules || {},
                        { country: config.country || 'ID', timeout: 10000 }
                    );
                } catch (mobErr) {
                    // Network/API fatal — kembalikan pesan aman
                    console.warn('[pre-validate] Mobapay network error:', mobErr && mobErr.message);
                    return res.status(503).json({
                        success: false,
                        message: 'Pengecekan promo sedang tidak tersedia, coba lagi nanti.'
                    });
                }

                if (!mobapayResult.success) {
                    const safeMsg = typeof mobapayResult.message === 'string' && mobapayResult.message.length > 0
                        ? mobapayResult.message
                        : 'Produk tidak tersedia untuk ID ini.';
                    return res.status(400).json({ success: false, message: safeMsg });
                }

                // Sukses — kembalikan pesan aman; frontend akan tampilkan di blok "tidak memerlukan validasi"
                return res.json({
                    success: true,
                    message: 'ID valid dan produk tersedia untuk ID ini.',
                    data: { mobapay: true }
                });
            }

            // === PGS Validator (existing behaviour) ===
            const result = await validateGameId(validatorName, userId, effectiveZoneId, config.rules || {});
            if (result.success) res.json(result);
            else res.status(400).json({ success: false, message: result.message });

        } catch (error) {
            logSafeError('[pre-validate] Error:', error);
            res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
        }
    });

    // Endpoint baru untuk halaman validasi (yang menampilkan promo)
    router.post('/api/full-validate', async (req, res) => {
        const { gameCode, userId, zoneId, rules } = req.body;

        if (!gameCode || !userId) {
            return res.status(400).json({ success: false, message: 'Parameter tidak lengkap.' });
        }

        try {
            let result;

            // --- INI ADALAH LOGIKA YANG SEHARUSNYA ---
            if (gameCode.includes('magic-chess-go-go')) {
                // Logika khusus untuk Magic Chess
                const mcggResult = await cekPromoMcggMobapay(userId, zoneId);
                if (mcggResult.success) {
                    result = { 
                        success: true, 
                        data: { 
                            username: mcggResult.nickname, 
                            promo: { doubleDiamond: { items: mcggResult.promoProducts } } 
                        } 
                    };
                } else {
                    result = mcggResult; // Kembalikan hasil errornya
                }

            } else {
                // Logika untuk semua game lain (termasuk Mobile Legends)
                const pgsResult = await validateGameId(gameCode, userId, zoneId, rules || {});
                if (!pgsResult.success) {
                    return res.status(400).json({ success: false, message: pgsResult.message });
                }
                
                result = pgsResult;

                // Jika ini ML, tambahkan data promo
                if (gameCode.includes('mobile-legends-region')) {
                    const mobapayResult = await checkAllMobapayPromosML(userId, zoneId);
                    result.data.promo = mobapayResult.data;
                }
            }
            // --- AKHIR DARI LOGIKA YANG SEHARUSNYA ---

            res.json(result);

        } catch (error) {
            console.error(`Error validasi lengkap untuk ${gameCode}:`, error);
            res.status(500).json({ success: false, message: 'Terjadi kesalahan internal.' });
        }
    });

    router.get('/api/games/:gameId/products', softProtect, async (req, res) => {
        try {
            const { gameId } = req.params;
            const result = await getGameProductsCatalog({ pool, gameId, user: req.user });
            if (result.notFound) return res.status(404).json({ message: 'Game tidak ditemukan.' });
            res.json(result.body);
        } catch (error) {
            console.error("Gagal mengambil produk game (public):", error);
            res.status(500).json({ message: 'Server error saat mengambil data produk.' });
        }
    });

    router.post('/api/promos/validate', protect, async (req, res) => {
        const { promo_code, product_id, target_game_id } = req.body;
        const client_user_id = req.user.id;

        if (!promo_code || !product_id || !target_game_id) {
            return res.status(400).json({ valid: false, message: 'Informasi promo, produk, dan ID game dibutuhkan.' });
        }

        try {
            const result = await validatePromoCodeForProduct({
                pool,
                userId: client_user_id,
                promoCode: promo_code,
                productId: product_id,
                targetGameId: target_game_id,
            });
            return res.status(result.statusCode).json(result.body);
        } catch (error) {
            console.error('Error saat validasi promo:', error);
            res.status(500).json({ valid: false, message: 'Terjadi kesalahan di server.' });
        }
    });

    return router;
};
