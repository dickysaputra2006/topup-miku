const express = require('express');
const { logSafeError } = require('../utils/logger');
const { normalizeString } = require('../utils/strings');
const { parseOptionalRefId } = require('../utils/validation');
const { validateWebhookUrl } = require('../utils/webhookClient.js');
const {
    getSafeOrderErrorMessage,
    executeH2HOrder,
} = require('../services/orderService');

/**
 * Daftarkan seluruh route reseller H2H (/h2h/order, /h2h/products, /h2h/profile/callback, /h2h/profile).
 */
module.exports = function createH2HRoutes(deps) {
    const {
        pool,
        protectH2HIp,
        protectH2H,
        h2hUserLimiter,
    } = deps || {};

    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createH2HRoutes requires a valid pool');
    }
    if (typeof protectH2HIp !== 'function') {
        throw new TypeError('createH2HRoutes requires a protectH2HIp middleware');
    }
    if (typeof protectH2H !== 'function') {
        throw new TypeError('createH2HRoutes requires a protectH2H middleware');
    }
    if (typeof h2hUserLimiter !== 'function') {
        throw new TypeError('createH2HRoutes requires an h2hUserLimiter middleware');
    }

    const router = express.Router();

    router.post('/h2h/order', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
        try {
            const refId = parseOptionalRefId(req.body.ref_id);
            const productId = Number(req.body.productId);
            const targetGameId = normalizeString(req.body.targetGameId, 80);
            const targetServerId = normalizeString(req.body.targetServerId, 80);
            const h2hUser = req.user; // User didapat dari middleware protectH2H

            const result = await executeH2HOrder({
                pool,
                h2hUser,
                productId,
                targetGameId,
                targetServerId,
                refId,
            });
            return res.status(result.statusCode).json(result.body);
        } catch (error) {
            logSafeError("H2H Order error:", error);
            const statusCode = error && [400, 409, 429].includes(error.statusCode) ? error.statusCode : 400;
            res.status(statusCode).json({ success: false, message: getSafeOrderErrorMessage(error, 'Gagal memproses transaksi H2H.') });
        }
    });

    router.get('/h2h/products', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
        try {
            const h2hPartner = req.user;
            const partnerRoleName = h2hPartner.role_name.toLowerCase();

            const { rows: globalRoleRows } = await pool.query('SELECT margin_percent FROM roles WHERE id = $1', [h2hPartner.role_id]);
            const globalMargin = globalRoleRows[0].margin_percent;

            // 1. Ambil semua item flash sale yang sedang aktif & masih punya kuota
            const { rows: activeFlashSales } = await pool.query(`
                SELECT product_id, discount_price FROM flash_sales
                WHERE is_active = true
                  AND NOW() BETWEEN start_at AND end_at
                  AND (max_uses IS NULL OR uses_count < max_uses)
            `);
            // 2. Buat Peta (Map) untuk pencarian cepat
            const flashSaleMap = new Map(activeFlashSales.map(fs => [fs.product_id, Number(fs.discount_price)]));

            const productQuery = `
                SELECT p.id, p.name as product_name, p.provider_sku, p.price as base_price, g.name as game_name,
                       p.use_manual_prices, p.manual_prices,
                       gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM products p
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE p.status = 'Active' AND g.status = 'Active'
                ORDER BY g.name, p.price
            `;
            const { rows: allActiveProducts } = await pool.query(productQuery);

            const partnerProductList = allActiveProducts.map(product => {
                const manualPrice = product.manual_prices ? product.manual_prices[partnerRoleName] : null;
                let normalPrice;

                // PRIORITAS 1: HARGA MANUAL
                if (product.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
                    normalPrice = Number(manualPrice);
                } else {
                    // PRIORITAS 2 & 3: MARGIN
                    let margin = globalMargin;
                    if (product.use_custom_margin) {
                        const customMargin = product[`${partnerRoleName}_margin`];
                        if (customMargin !== null && customMargin !== undefined) {
                            margin = customMargin;
                        }
                    }
                    normalPrice = Math.ceil(Number(product.base_price) * (1 + (Number(margin) / 100)));
                }

                let finalPrice = normalPrice;
                let originalPrice = null;
                let isFlashSale = false;

                // PRIORITAS 0: FLASH SALE (hanya jika aktif, ada kuota, dan lebih murah dari harga normal)
                if (flashSaleMap.has(product.id)) {
                    const flashPrice = Number(flashSaleMap.get(product.id));
                    if (Number.isFinite(flashPrice) && flashPrice > 0 && flashPrice < normalPrice) {
                        isFlashSale = true;
                        finalPrice = flashPrice;
                        originalPrice = normalPrice;
                    }
                }

                return {
                    productId: product.id,
                    game_name: product.game_name,
                    product_name: product.product_name,
                    sku: product.provider_sku,
                    price: finalPrice,
                    isFlashSale: isFlashSale, // Info tambahan untuk partner
                    originalPrice: originalPrice // Info tambahan untuk partner
                };
            });

            res.json({
                success: true,
                message: 'Daftar produk berhasil diambil.',
                data: partnerProductList
            });

        } catch (error) {
            logSafeError('H2H Get Products Error:', error);
            res.status(500).json({ success: false, message: 'Gagal mengambil daftar produk H2H.' });
        }
    });

    router.put('/h2h/profile/callback', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
        try {
            const callback_url = normalizeString(req.body.callback_url, 2048);
            if (!callback_url) {
                return res.status(400).json({ success: false, message: 'URL callback tidak valid.' });
            }
            try {
                await validateWebhookUrl(callback_url);
            } catch (_ssrfErr) {
                return res.status(400).json({ success: false, message: 'URL callback tidak valid.' });
            }

            await pool.query('UPDATE users SET h2h_callback_url = $1 WHERE id = $2', [callback_url, req.user.id]);

            res.json({ success: true, message: 'Callback URL berhasil diperbarui.' });
        } catch (error) {
            logSafeError('H2H Update Callback Error:', error);
            res.status(500).json({ success: false, message: 'Gagal memperbarui callback URL.' });
        }
    });

    router.get('/h2h/profile', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
        const profileData = {
            username: req.user.username,
            balance: req.user.balance,
            role: req.user.role_name
        };

        res.json({
            success: true,
            message: 'Profil berhasil diambil.',
            data: profileData
        });
    });

    return router;
};
