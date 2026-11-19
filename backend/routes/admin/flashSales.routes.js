const express = require('express');
const { logSafeError } = require('../../utils/logger');
const {
    getBodyObject,
    requirePositiveInt,
    optionalPositiveInt,
    requireBoundedNumber,
    requireValidDate,
} = require('../../utils/schemaValidators');

const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

/**
 * Daftarkan route admin untuk manajemen flash sale.
 */
module.exports = function createAdminFlashSalesRoutes(deps) {
    const {
        pool,
        protectAdmin,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminFlashSalesRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminFlashSalesRoutes requires a protectAdmin middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminFlashSalesRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    // Endpoint untuk melihat semua item flash sale di admin panel
    router.get('/api/admin/flash-sales', protectAdmin, async (req, res) => {
        try {
            const sql = `
                SELECT 
                    fs.*,
                    p.name as product_name,
                    g.name as game_name
                FROM flash_sales fs
                JOIN products p ON fs.product_id = p.id
                JOIN games g ON p.game_id = g.id
                ORDER BY fs.created_at DESC;
            `;
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            logSafeError('Gagal mengambil data flash sale:', error);
            res.status(500).json({ message: 'Gagal mengambil data flash sale.' });
        }
    });

    // Endpoint untuk menambah produk ke flash sale
    router.post('/api/admin/flash-sales', protectAdmin, async (req, res) => {
        try {
            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const productRes = requirePositiveInt(body.product_id, 'product_id');
            if (productRes.error) return res.status(400).json({ message: productRes.error });

            const priceRes = requireBoundedNumber(body.discount_price, 'Harga flash sale', { min: 1, max: 100000000 });
            if (priceRes.error) return res.status(400).json({ message: priceRes.error });

            const startRes = requireValidDate(body.start_at, 'Waktu mulai flash sale');
            if (startRes.error) return res.status(400).json({ message: startRes.error });

            const endRes = requireValidDate(body.end_at, 'Waktu selesai flash sale');
            if (endRes.error) return res.status(400).json({ message: endRes.error });

            if (endRes.value.getTime() <= startRes.value.getTime()) {
                return res.status(400).json({ message: 'Waktu selesai flash sale harus setelah waktu mulai.' });
            }

            const maxUsesRes = optionalPositiveInt(body.max_uses, 'Maksimal kuota flash sale', { min: 1, max: 1000000 });
            if (maxUsesRes.error) return res.status(400).json({ message: maxUsesRes.error });

            const allowBelowCost = body.allow_below_cost === true;
            const { rows: productRows } = await pool.query(
                'SELECT id, price FROM products WHERE id = $1 LIMIT 1',
                [productRes.value]
            );
            if (!productRows || productRows.length === 0) {
                return res.status(404).json({ message: 'Produk tidak ditemukan.' });
            }
            const baseCost = Number(productRows[0].price);
            if (!allowBelowCost && Number.isFinite(baseCost) && priceRes.value < baseCost) {
                return res.status(400).json({
                    message: 'Harga flash sale tidak boleh lebih rendah dari harga modal produk.'
                });
            }

            let rules = null;
            if (body.max_discount_amount !== undefined && body.max_discount_amount !== null && String(body.max_discount_amount).trim() !== '') {
                const maxDiscRes = requireBoundedNumber(body.max_discount_amount, 'max_discount_amount', { min: 1, max: 100000000 });
                if (maxDiscRes.error) return res.status(400).json({ message: maxDiscRes.error });
                rules = { max_discount_amount: maxDiscRes.value };
            }

            const sql = `
                INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, rules, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *;
            `;
            const { rows } = await pool.query(sql, [
                productRes.value,
                priceRes.value,
                startRes.value,
                endRes.value,
                maxUsesRes.value,
                rules,
            ]);
            const createdFs = rows[0];
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.flash_sale.create',
                targetType: 'flash_sale',
                targetId: createdFs && createdFs.id != null ? String(createdFs.id) : String(productRes.value),
                afterData: {
                    product_id: productRes.value,
                    discount_price: priceRes.value,
                    start_at: startRes.value,
                    end_at: endRes.value,
                    max_uses: maxUsesRes.value,
                    allow_below_cost: allowBelowCost,
                },
            });
            res.status(201).json(createdFs);
        } catch (error) {
            logSafeError('Error saat menambah flash sale:', error);
            res.status(500).json({ message: 'Gagal menambah item flash sale.' });
        }
    });

    // Endpoint untuk menghapus item dari flash sale
    router.delete('/api/admin/flash-sales/:id', protectAdmin, async (req, res) => {
        try {
            const idRes = requirePositiveInt(req.params.id, 'ID flash sale');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            await pool.query('DELETE FROM flash_sales WHERE id = $1', [idRes.value]);
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.flash_sale.delete',
                targetType: 'flash_sale',
                targetId: String(idRes.value),
                afterData: { deleted: true },
            });
            res.status(200).json({ message: 'Item flash sale berhasil dihapus.' });
        } catch (error) {
            logSafeError('Gagal menghapus item flash sale:', error);
            res.status(500).json({ message: 'Gagal menghapus item flash sale.' });
        }
    });

    return router;
};
