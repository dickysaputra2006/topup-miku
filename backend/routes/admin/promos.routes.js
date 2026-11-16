const express = require('express');

/**
 * Daftarkan route admin untuk manajemen kode promo.
 */
module.exports = function createAdminPromosRoutes(deps) {
    const { pool, protectAdmin } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminPromosRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminPromosRoutes requires a protectAdmin middleware');
    }

    const router = express.Router();

    router.post('/api/admin/promos', protectAdmin, async (req, res) => {
        const { code, description, type, value, expires_at, rules, max_uses } = req.body;
        try {
            const sql = `INSERT INTO promo_codes (code, description, type, value, expires_at, rules, max_uses) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
            const { rows } = await pool.query(sql, [code.toUpperCase(), description, type, value, expires_at, rules, max_uses]);
            res.status(201).json(rows[0]);
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ message: 'Kode promo sudah ada.' });
            console.error("Gagal membuat kode promo:", error);
            res.status(500).json({ message: 'Gagal membuat kode promo.' });
        }
    });

    // Endpoint untuk melihat semua kode promo
    router.get('/api/admin/promos', protectAdmin, async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
            res.json(rows);
        } catch (error) {
            res.status(500).json({ message: 'Gagal mengambil data promo.' });
        }
    });

    // Endpoint untuk menonaktifkan/mengaktifkan promo
    router.put('/api/admin/promos/:id/toggle', protectAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { is_active } = req.body;
            const sql = 'UPDATE promo_codes SET is_active = $1 WHERE id = $2 RETURNING *';
            const { rows } = await pool.query(sql, [is_active, id]);
            if (rows.length === 0) return res.status(404).json({ message: 'Kode promo tidak ditemukan.' });
            res.json(rows[0]);
        } catch (error) {
            res.status(500).json({ message: 'Gagal mengubah status promo.' });
        }
    });

    return router;
};
