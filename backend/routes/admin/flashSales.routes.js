const express = require('express');

/**
 * Daftarkan route admin untuk manajemen flash sale.
 */
module.exports = function createAdminFlashSalesRoutes(deps) {
    const { pool, protectAdmin } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminFlashSalesRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminFlashSalesRoutes requires a protectAdmin middleware');
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
            res.status(500).json({ message: 'Gagal mengambil data flash sale.' });
        }
    });

    // Endpoint untuk menambah produk ke flash sale
    router.post('/api/admin/flash-sales', protectAdmin, async (req, res) => {
        const { product_id, discount_price, start_at, end_at, max_uses, max_discount_amount } = req.body;
        const rules = max_discount_amount ? { max_discount_amount: parseFloat(max_discount_amount) } : null;

        try {
            // PERBAIKAN: Menambahkan kolom 'is_active' dan memberinya nilai 'true'
            const sql = `
                INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, rules, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *;
            `;
            
            const { rows } = await pool.query(sql, [product_id, discount_price, start_at, end_at, max_uses, rules]);
            res.status(201).json(rows[0]);

        } catch (error) {
            // Menambahkan log error agar lebih mudah dilacak jika ada masalah lain
            console.error("Error saat menambah flash sale:", error); 
            res.status(500).json({ message: 'Gagal menambah item flash sale.' });
        }
    });

    // Endpoint untuk menghapus item dari flash sale
    router.delete('/api/admin/flash-sales/:id', protectAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            await pool.query('DELETE FROM flash_sales WHERE id = $1', [id]);
            res.status(200).json({ message: 'Item flash sale berhasil dihapus.' });
        } catch (error) {
            res.status(500).json({ message: 'Gagal menghapus item flash sale.' });
        }
    });

    return router;
};
