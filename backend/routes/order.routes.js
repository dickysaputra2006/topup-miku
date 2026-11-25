const express = require('express');
const { logSafeError } = require('../utils/logger');
const { normalizeString } = require('../utils/strings');
const { parseOptionalIdempotencyKeyHeader } = require('../utils/validation');
const { getBodyObject, requirePositiveInt } = require('../utils/schemaValidators');
const {
    getSafeOrderErrorMessage,
    executeWebOrder,
} = require('../services/orderService');

/**
 * Daftarkan route transaksi Web Order (POST /api/order).
 */
module.exports = function createOrderRoutes(deps) {
    const { pool, protect } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createOrderRoutes requires a valid pool');
    }
    if (typeof protect !== 'function') {
        throw new TypeError('createOrderRoutes requires a protect middleware');
    }

    const router = express.Router();

    router.post('/api/order', protect, async (req, res) => {
        try {
            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const idempotencyKey = parseOptionalIdempotencyKeyHeader(req);
            const prodRes = requirePositiveInt(body.productId, 'Produk');
            if (prodRes.error) return res.status(400).json({ message: 'Produk dan ID Game wajib diisi.' });
            const productId = prodRes.value;
            const targetGameId = normalizeString(body.targetGameId, 80);
            const targetServerId = normalizeString(body.targetServerId, 80);
            const promoCode = body.promoCode ? String(body.promoCode).trim().toUpperCase() : null;
            const userId = req.user.id;

            const result = await executeWebOrder({
                pool,
                userId,
                productId,
                targetGameId,
                targetServerId,
                promoCode,
                idempotencyKey,
            });
            return res.status(result.statusCode).json(result.body);
        } catch (error) {
            logSafeError("Order error:", error);
            const statusCode = error && [400, 409, 429].includes(error.statusCode) ? error.statusCode : 400;
            res.status(statusCode).json({ message: getSafeOrderErrorMessage(error, 'Gagal memproses transaksi.') });
        }
    });

    return router;
};
