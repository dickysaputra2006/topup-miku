const express = require('express');
const { logSafeError } = require('../../utils/logger');
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
            const { gameId } = req.params;
            const { rows } = await pool.query('SELECT * FROM game_margins WHERE game_id = $1', [gameId]);
            if (rows.length > 0) {
                res.json(rows[0]);
            } else {
                // Jika belum ada pengaturan, kirim data default
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
            const { gameId } = req.params;
            const { use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin } = req.body;

            const existingRes = await pool.query('SELECT use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin FROM game_margins WHERE game_id = $1 LIMIT 1', [gameId])
                .catch(() => ({ rows: [] }));
            const beforeMargin = existingRes && existingRes.rows && existingRes.rows[0] ? existingRes.rows[0] : null;

            // Query UPSERT: Insert jika belum ada, Update jika sudah ada
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
            
            await pool.query(sql, [gameId, use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin]);
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.game_margins.update',
                targetType: 'game_margins',
                targetId: String(gameId),
                beforeData: beforeMargin,
                afterData: { use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin },
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
            const { productId } = req.params;
            const { rows } = await pool.query(
                'SELECT use_manual_prices, manual_prices FROM products WHERE id = $1',
                [productId]
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
            const { productId } = req.params;
            const { use_manual_prices, manual_prices } = req.body;

            const existingRes = await pool.query('SELECT use_manual_prices, manual_prices FROM products WHERE id = $1 LIMIT 1', [productId])
                .catch(() => ({ rows: [] }));
            const beforeManual = existingRes && existingRes.rows && existingRes.rows[0] ? existingRes.rows[0] : null;

            const sql = `
                UPDATE products 
                SET use_manual_prices = $1, manual_prices = $2
                WHERE id = $3
            `;
            
            await pool.query(sql, [use_manual_prices, manual_prices, productId]);
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.product_manual_prices.update',
                targetType: 'product',
                targetId: String(productId),
                beforeData: beforeManual,
                afterData: { use_manual_prices, manual_prices },
            });
            res.json({ message: 'Pengaturan harga manual berhasil disimpan.' });

        } catch (error) {
            logSafeError('Error saving manual prices:', error);
            res.status(500).json({ message: 'Gagal menyimpan data harga manual.' });
        }
    });

    return router;
};
