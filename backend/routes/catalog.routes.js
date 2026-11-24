const express = require('express');
const { logSafeError } = require('../utils/logger');
const { sanitizePublicErrorMessage } = require('../utils/strings');
const {
    getBodyObject,
    requirePlainObject,
    requireString,
    optionalTrimmedString,
    requirePositiveInt,
} = require('../utils/schemaValidators');
const { validateGameId } = require('../utils/validators/cek-id-game.js');
const { checkAllMobapayPromosML, checkMobapayMlbbEligibility } = require('../utils/validators/stalk-ml-promo.js');
const { cekPromoMcggMobapay } = require('../utils/validators/stalk-mcgg.js');
const {
    getGameProductsCatalog,
    validatePromoCodeForProduct,
} = require('../services/priceService');

function validateFullValidateRules(rawRules) {
    if (rawRules === undefined || rawRules === null) {
        return { value: {} };
    }
    const objRes = requirePlainObject(rawRules, 'rules');
    if (objRes.error) return objRes;

    const clean = {};
    const safeRegion = /^[a-zA-Z0-9_-]{1,10}$/;
    for (const field of ['allowedRegions', 'disallowedRegions']) {
        const rawList = rawRules[field];
        if (rawList === undefined || rawList === null) continue;
        if (!Array.isArray(rawList) || rawList.length > 50) {
            return { error: `rules.${field} harus berupa array maksimal 50 region.` };
        }
        const safeList = [];
        for (const region of rawList) {
            if (typeof region !== 'string' || !safeRegion.test(region.trim())) {
                return { error: `rules.${field} mengandung kode region tidak valid.` };
            }
            safeList.push(region.trim());
        }
        clean[field] = safeList;
    }
    return { value: clean };
}

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
        const productIdRes = requirePositiveInt(req.params.productId, 'ID produk');
        if (productIdRes.error) {
            return res.status(400).json({ success: false, message: productIdRes.error });
        }

        const bodyRes = getBodyObject(req);
        if (bodyRes.error) {
            return res.status(400).json({ success: false, message: bodyRes.error });
        }
        const body = bodyRes.value;

        const userIdRes = requireString(body.userId, 'User ID', { min: 1, max: 64 });
        if (userIdRes.error) {
            return res.status(400).json({ success: false, message: body.userId ? userIdRes.error : 'User ID wajib diisi.' });
        }

        const zoneIdRes = optionalTrimmedString(body.zoneId, 'Zone ID', { max: 64, allowNewlines: false });
        if (zoneIdRes.error) {
            return res.status(400).json({ success: false, message: zoneIdRes.error });
        }

        const productId = productIdRes.value;
        const userId = userIdRes.value;
        const zoneId = zoneIdRes.value;

        try {
            // HOTFIX: needs_server_id is on the games table, not products.
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

            // Tidak ada config atau config tidak aktif -> tidak perlu validasi
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
                    logSafeError('[pre-validate] Mobapay network error:', mobErr);
                    return res.status(503).json({
                        success: false,
                        message: 'Pengecekan promo sedang tidak tersedia, coba lagi nanti.'
                    });
                }

                if (!mobapayResult.success) {
                    const safeMsg = sanitizePublicErrorMessage(mobapayResult.message, 'Produk tidak tersedia untuk ID ini.');
                    return res.status(400).json({ success: false, message: safeMsg });
                }

                return res.json({
                    success: true,
                    message: 'ID valid dan produk tersedia untuk ID ini.',
                    data: { mobapay: true }
                });
            }

            // === PGS Validator (existing behaviour) ===
            const result = await validateGameId(validatorName, userId, effectiveZoneId, config.rules || {});
            if (result.success) res.json(result);
            else res.status(400).json({
                success: false,
                message: sanitizePublicErrorMessage(result.message, 'Validasi ID game gagal.')
            });
        } catch (error) {
            logSafeError('[pre-validate] Error:', error);
            res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
        }
    });

    // Endpoint baru untuk halaman validasi (yang menampilkan promo)
    router.post('/api/full-validate', async (req, res) => {
        const bodyRes = getBodyObject(req);
        if (bodyRes.error) {
            return res.status(400).json({ success: false, message: bodyRes.error });
        }
        const body = bodyRes.value;

        const gameCodeRes = requireString(body.gameCode, 'Kode game', {
            min: 1,
            max: 100,
            pattern: /^[a-zA-Z0-9_.\- ]{1,100}$/,
            patternMessage: 'Format kode game tidak valid.',
        });
        if (gameCodeRes.error) {
            return res.status(400).json({
                success: false,
                message: !body.gameCode ? 'Parameter tidak lengkap.' : gameCodeRes.error,
            });
        }

        const userIdRes = requireString(body.userId, 'User ID', { min: 1, max: 64 });
        if (userIdRes.error) {
            return res.status(400).json({
                success: false,
                message: !body.userId ? 'Parameter tidak lengkap.' : userIdRes.error,
            });
        }

        const zoneIdRes = optionalTrimmedString(body.zoneId, 'Zone ID', { max: 64, allowNewlines: false });
        if (zoneIdRes.error) {
            return res.status(400).json({ success: false, message: zoneIdRes.error });
        }

        const rulesRes = validateFullValidateRules(body.rules);
        if (rulesRes.error) {
            return res.status(400).json({ success: false, message: rulesRes.error });
        }

        const gameCode = gameCodeRes.value;
        const userId = userIdRes.value;
        const zoneId = zoneIdRes.value;
        const rules = rulesRes.value;

        try {
            let result;
            if (gameCode.includes('magic-chess-go-go')) {
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
                    result = {
                        success: false,
                        message: sanitizePublicErrorMessage(mcggResult.message, 'Gagal memvalidasi ID game.')
                    };
                }
            } else {
                const pgsResult = await validateGameId(gameCode, userId, zoneId, rules);
                if (!pgsResult.success) {
                    return res.status(400).json({
                        success: false,
                        message: sanitizePublicErrorMessage(pgsResult.message, 'Gagal memvalidasi ID game.')
                    });
                }

                result = pgsResult;
                if (gameCode.includes('mobile-legends-region')) {
                    const mobapayResult = await checkAllMobapayPromosML(userId, zoneId);
                    result.data.promo = mobapayResult.data;
                }
            }

            res.json(result);
        } catch (error) {
            logSafeError(`Error validasi lengkap untuk ${gameCode}:`, error);
            res.status(500).json({ success: false, message: 'Terjadi kesalahan internal.' });
        }
    });

    router.get('/api/games/:gameId/products', softProtect, async (req, res) => {
        try {
            const gameIdRes = requirePositiveInt(req.params.gameId, 'Game ID');
            if (gameIdRes.error) return res.status(400).json({ message: gameIdRes.error });

            const result = await getGameProductsCatalog({ pool, gameId: gameIdRes.value, user: req.user });
            if (result.notFound) return res.status(404).json({ message: 'Game tidak ditemukan.' });
            res.json(result.body);
        } catch (error) {
            logSafeError('Gagal mengambil produk game (public):', error);
            res.status(500).json({ message: 'Server error saat mengambil data produk.' });
        }
    });

    router.post('/api/promos/validate', protect, async (req, res) => {
        const bodyRes = getBodyObject(req);
        if (bodyRes.error) {
            return res.status(400).json({ valid: false, message: bodyRes.error });
        }
        const body = bodyRes.value;

        const promoCodeRes = requireString(body.promo_code, 'Kode promo', {
            min: 1,
            max: 50,
            uppercase: true,
        });
        if (promoCodeRes.error) {
            return res.status(400).json({
                valid: false,
                message: !body.promo_code ? 'Informasi promo, produk, dan ID game dibutuhkan.' : promoCodeRes.error,
            });
        }

        const productIdRes = requirePositiveInt(body.product_id, 'ID produk');
        if (productIdRes.error) {
            return res.status(400).json({
                valid: false,
                message: !body.product_id ? 'Informasi promo, produk, dan ID game dibutuhkan.' : productIdRes.error,
            });
        }

        const targetGameIdRes = requireString(body.target_game_id, 'ID game target', { min: 1, max: 80 });
        if (targetGameIdRes.error) {
            return res.status(400).json({
                valid: false,
                message: !body.target_game_id ? 'Informasi promo, produk, dan ID game dibutuhkan.' : targetGameIdRes.error,
            });
        }

        const client_user_id = req.user.id;
        try {
            const result = await validatePromoCodeForProduct({
                pool,
                userId: client_user_id,
                promoCode: promoCodeRes.value,
                productId: productIdRes.value,
                targetGameId: targetGameIdRes.value,
            });
            return res.status(result.statusCode).json(result.body);
        } catch (error) {
            logSafeError('Error saat validasi promo:', error);
            res.status(500).json({ valid: false, message: 'Terjadi kesalahan di server.' });
        }
    });

    return router;
};
