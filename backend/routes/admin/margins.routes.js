const express = require('express');
const { logSafeError } = require('../../utils/logger');
const {
    getBodyObject,
    requirePositiveInt,
    requireBoundedNumber,
    requireBoolean,
    validateManualPricesMap,
} = require('../../utils/schemaValidators');
const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

/**
 * Daftarkan route admin untuk pengaturan margin kustom game dan harga manual produk.
 */
module.exports = function createAdminMarginsRoutes(deps) {
    const {
        pool,
        protectAdmin,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminMarginsRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminMarginsRoutes requires a protectAdmin middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminMarginsRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    // Mengambil pengaturan margin khusus untuk sebuah game
    router.get('/api/admin/games/:gameId/margins', protectAdmin, async (req, res) => {
        try {
            const gameIdRes = requirePositiveInt(req.params.gameId, 'Game ID');
            if (gameIdRes.error) return res.status(400).json({ message: gameIdRes.error });

            const { rows } = await pool.query('SELECT * FROM game_margins WHERE game_id = $1', [gameIdRes.value]);
            if (rows.length > 0) {
                res.json(rows[0]);
            } else {
                res.json({ use_custom_margin: false });
            }
        } catch (error) {
            logSafeError('Error fetching game margins:', error);
            res.status(500).json({ message: 'Gagal mengambil data margin game.' });
        }
    });

    // Menyimpan atau memperbarui pengaturan margin khusus untuk sebuah game
    router.post('/api/admin/games/:gameId/margins', protectAdmin, async (req, res) => {
        try {
            const gameIdRes = requirePositiveInt(req.params.gameId, 'Game ID');
            if (gameIdRes.error) return res.status(400).json({ message: gameIdRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const useCustomRes = requireBoolean(body.use_custom_margin, 'use_custom_margin');
            if (useCustomRes.error) return res.status(400).json({ message: useCustomRes.error });

            const marginFields = ['bronze_margin', 'silver_margin', 'gold_margin', 'partner_margin'];
            const validatedMargins = {};
            for (const field of marginFields) {
                const rawVal = body[field];
                if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') {
                    if (useCustomRes.value) {
                        return res.status(400).json({ message: `${field} wajib diisi jika margin kustom aktif.` });
                    }
                    validatedMargins[field] = null;
                    continue;
                }
                const numRes = requireBoundedNumber(rawVal, field, { min: 0, max: 500 });
                if (numRes.error) return res.status(400).json({ message: numRes.error });
                validatedMargins[field] = numRes.value;
            }

            const existingRes = await pool.query(
                'SELECT use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin FROM game_margins WHERE game_id = $1 LIMIT 1',
                [gameIdRes.value]
            ).catch(() => ({ rows: [] }));
            const beforeMargin = existingRes && existingRes.rows && existingRes.rows[0] ? existingRes.rows[0] : null;

            const sql = `
                INSERT INTO game_margins (game_id, use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (game_id)
                DO UPDATE SET
                    use_custom_margin = EXCLUDED.use_custom_margin,
                    bronze_margin = EXCLUDED.bronze_margin,
                    silver_margin = EXCLUDED.silver_margin,
                    gold_margin = EXCLUDED.gold_margin,
                    partner_margin = EXCLUDED.partner_margin,
                    updated_at = NOW()
            `;

            await pool.query(sql, [
                gameIdRes.value,
                useCustomRes.value,
                validatedMargins.bronze_margin,
                validatedMargins.silver_margin,
                validatedMargins.gold_margin,
                validatedMargins.partner_margin,
            ]);
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.game_margins.update',
                targetType: 'game_margins',
                targetId: String(gameIdRes.value),
                beforeData: beforeMargin,
                afterData: {
                    use_custom_margin: useCustomRes.value,
                    ...validatedMargins,
                },
            });
            res.json({ message: 'Pengaturan margin untuk game ini berhasil disimpan.' });
        } catch (error) {
            logSafeError('Error saving game margins:', error);
            res.status(500).json({ message: 'Gagal menyimpan data margin game.' });
        }
    });

    // Mengambil pengaturan harga manual untuk sebuah produk
    router.get('/api/admin/products/:productId/manual-prices', protectAdmin, async (req, res) => {
        try {
            const productIdRes = requirePositiveInt(req.params.productId, 'Product ID');
            if (productIdRes.error) return res.status(400).json({ message: productIdRes.error });

            const { rows } = await pool.query(
                'SELECT use_manual_prices, manual_prices FROM products WHERE id = $1',
                [productIdRes.value]
            );
            if (rows.length > 0) {
                res.json({
                    use_manual_prices: rows[0].use_manual_prices || false,
                    manual_prices: rows[0].manual_prices || {}
                });
            } else {
                res.status(404).json({ message: 'Produk tidak ditemukan.' });
            }
        } catch (error) {
            logSafeError('Error fetching manual prices:', error);
            res.status(500).json({ message: 'Gagal mengambil data harga manual.' });
        }
    });

    // Menyimpan atau memperbarui pengaturan harga manual untuk sebuah produk
    router.post('/api/admin/products/:productId/manual-prices', protectAdmin, async (req, res) => {
        try {
            const productIdRes = requirePositiveInt(req.params.productId, 'Product ID');
            if (productIdRes.error) return res.status(400).json({ message: productIdRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const useManualRes = requireBoolean(body.use_manual_prices, 'use_manual_prices');
            if (useManualRes.error) return res.status(400).json({ message: useManualRes.error });

            const pricesRes = validateManualPricesMap(body.manual_prices, { required: useManualRes.value });
            if (pricesRes.error) return res.status(400).json({ message: pricesRes.error });

            const existingRes = await pool.query(
                'SELECT use_manual_prices, manual_prices FROM products WHERE id = $1 LIMIT 1',
                [productIdRes.value]
            ).catch(() => ({ rows: [] }));
            const beforeManual = existingRes && existingRes.rows && existingRes.rows[0] ? existingRes.rows[0] : null;

            const sql = `
                UPDATE products 
                SET use_manual_prices = $1, manual_prices = $2
                WHERE id = $3
            `;

            await pool.query(sql, [useManualRes.value, pricesRes.value, productIdRes.value]);
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.product_manual_prices.update',
                targetType: 'product',
                targetId: String(productIdRes.value),
                beforeData: beforeManual,
                afterData: { use_manual_prices: useManualRes.value, manual_prices: pricesRes.value },
            });
            res.json({ message: 'Pengaturan harga manual berhasil disimpan.' });
        } catch (error) {
            logSafeError('Error saving manual prices:', error);
            res.status(500).json({ message: 'Gagal menyimpan data harga manual.' });
        }
    });

    return router;
};
