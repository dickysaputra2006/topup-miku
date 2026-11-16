const express = require('express');
const bcrypt = require('bcryptjs');
const { logSafeError } = require('../utils/logger');
const { normalizeString, normalizeProfilePhone } = require('../utils/strings');
const { isValidEmail, isValidInvoiceId } = require('../utils/validation');

/**
 * Daftarkan route pengguna: profil, kata sandi, saldo, transaksi, dan notifikasi.
 */
module.exports = function createUserRoutes(deps) {
    const { pool, protect } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createUserRoutes requires a valid pool');
    }
    if (typeof protect !== 'function') {
        throw new TypeError('createUserRoutes requires a protect middleware');
    }

    const router = express.Router();

    router.get('/api/user/profile', protect, async (req, res) => {
        try {
            const sql = 'SELECT u.id, u.full_name, u.username, u.email, u.nomor_wa, u.balance, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1';
            const { rows } = await pool.query(sql, [req.user.id]);
            if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
            res.json(rows[0]);
        } catch (error) {
            console.error('Error fetching user profile:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.put('/api/user/profile', protect, async (req, res) => {
        try {
            const fullName = normalizeString(req.body.fullName, 255);
            const email = normalizeString(req.body.email, 255).toLowerCase();
            const rawNomorWa = normalizeString(req.body.nomorWa, 30);
            const rawCountryCode = req.body.countryCode !== undefined ? normalizeString(req.body.countryCode, 5) : '';

            if (!fullName || !email || !rawNomorWa) {
                return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
            }
            if (!isValidEmail(email)) {
                return res.status(400).json({ message: 'Format email tidak valid.' });
            }

            const normalizedPhone = normalizeProfilePhone(rawNomorWa, rawCountryCode);
            if (!normalizedPhone) {
                return res.status(400).json({ message: 'Nomor WhatsApp tidak valid. Gunakan format +628xxx atau 08xxx.' });
            }

            const sql = 'UPDATE users SET full_name = $1, email = $2, nomor_wa = $3 WHERE id = $4';
            await pool.query(sql, [fullName, email, normalizedPhone, req.user.id]);
            res.json({ message: 'Profil berhasil diperbarui.' });
        } catch (error) {
            if (error.code === '23505') {
                const constraint = String(error.constraint || '').toLowerCase();
                const detail = String(error.detail || '').toLowerCase();
                if (constraint.includes('nomor_wa') || detail.includes('nomor_wa')) {
                    return res.status(409).json({ message: 'Nomor WhatsApp sudah digunakan oleh akun lain.' });
                }
                if (constraint.includes('email') || detail.includes('email')) {
                    return res.status(409).json({ message: 'Email sudah digunakan oleh akun lain.' });
                }
                return res.status(409).json({ message: 'Email atau nomor WhatsApp sudah digunakan oleh akun lain.' });
            }
            logSafeError('Error updating user profile:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.put('/api/user/password', protect, async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body;
            if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
            const sqlSelect = 'SELECT password FROM users WHERE id = $1';
            const { rows } = await pool.query(sqlSelect, [req.user.id]);
            const user = rows[0];
            const isPasswordMatch = await bcrypt.compare(currentPassword, user.password);
            if (!isPasswordMatch) return res.status(401).json({ message: 'Password saat ini salah.' });
            const hashedNewPassword = await bcrypt.hash(newPassword, 10);
            const sqlUpdate = 'UPDATE users SET password = $1 WHERE id = $2';
            await pool.query(sqlUpdate, [hashedNewPassword, req.user.id]);
            res.json({ message: 'Password berhasil diubah.' });
        } catch (error) {
            console.error('Error changing password:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.get('/api/user/balance-history', protect, async (req, res) => {
        try {
            // PostgreSQL: Menggunakan created_at sebagai timestamp
            const sql = `SELECT amount, type, description, reference_id, created_at FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC`;
            const { rows } = await pool.query(sql, [req.user.id]);
            res.json(rows);
        } catch (error) {
            console.error('Error fetching balance history:', error);
            res.status(500).json({ message: 'Server error saat mengambil riwayat saldo.' });
        }
    });

    router.get('/api/user/transactions', protect, async (req, res) => {
        try {
            const userId = req.user.id;
            const sql = `
                SELECT 
                    t.invoice_id, 
                    t.target_game_id,              t.price, 
                    t.status, 
                    t.created_at, 
                    p.name as product_name
                FROM transactions t
                JOIN products p ON t.product_id = p.id
                WHERE t.user_id = $1
                ORDER BY t.created_at DESC
            `;
            const { rows } = await pool.query(sql, [userId]);
            res.json(rows);
        } catch (error) {
            console.error("Gagal mengambil riwayat transaksi pengguna:", error);
            res.status(500).json({ message: 'Server error saat mengambil riwayat transaksi pengguna.' });
        }
    });

    router.get('/api/user/transaction/:invoiceId', protect, async (req, res) => {
        try {
            const rawInvoiceId = String(req.params.invoiceId || '').trim();
            if (!isValidInvoiceId(rawInvoiceId)) {
                return res.status(400).json({ message: 'Format invoice tidak valid.' });
            }
            const invoiceId = rawInvoiceId;
            const userId = req.user.id;

            // Query ini menggabungkan 3 tabel untuk mendapatkan semua detail
            const sql = `
                SELECT
                    t.invoice_id,
                    t.status,
                    t.created_at,
                    t.price,
                    t.target_game_id,
                    t.provider_sn,
                    p.name as product_name,
                    g.category as game_category,
                    g.name as game_name
                FROM transactions t
                JOIN products p ON t.product_id = p.id
                JOIN games g ON p.game_id = g.id
                WHERE t.invoice_id = $1 AND t.user_id = $2
            `;
            const { rows } = await pool.query(sql, [invoiceId, userId]);

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Transaksi tidak ditemukan atau bukan milik Anda.' });
            }

            res.json(rows[0]);
        } catch (error) {
            console.error("Gagal mengambil detail transaksi:", error);
            res.status(500).json({ message: 'Server error saat mengambil detail transaksi.' });
        }
    });

    router.get('/api/user/transaction-summary', protect, async (req, res) => {
        try {
            const userId = req.user.id;
            const sql = `
                SELECT 
                    COALESCE(SUM(CASE WHEN status = 'Success' THEN 1 ELSE 0 END), 0) AS berhasil,
                    COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending,
                    COALESCE(SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END), 0) AS gagal,
                    COALESCE(SUM(CASE WHEN status = 'Partial Refund' THEN 1 ELSE 0 END), 0) AS review
                FROM transactions 
                WHERE user_id = $1;
            `;
            const { rows } = await pool.query(sql, [userId]);
            res.json(rows[0]);
        } catch (error) {
            console.error("Gagal mengambil ringkasan transaksi:", error);
            res.status(500).json({ message: 'Server error saat mengambil ringkasan transaksi.' });
        }
    });

    // Endpoint untuk mengambil notifikasi pengguna
    router.get('/api/user/notifications', protect, async (req, res) => {
        try {
            const { rows } = await pool.query(
                'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', 
                [req.user.id]
            );
            res.json(rows);
        } catch (error) {
            res.status(500).json({ message: 'Gagal mengambil notifikasi.' });
        }
    });

    // Endpoint untuk menghitung notifikasi yang belum dibaca
    router.get('/api/user/notifications/unread-count', protect, async (req, res) => {
        try {
            const { rows } = await pool.query(
                'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false', 
                [req.user.id]
            );
            res.json({ count: parseInt(rows[0].count, 10) });
        } catch (error) {
            res.status(500).json({ message: 'Gagal menghitung notifikasi.' });
        }
    });

    // Endpoint untuk menandai semua notifikasi sebagai sudah dibaca
    router.post('/api/user/notifications/mark-as-read', protect, async (req, res) => {
        try {
            await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
            res.status(200).json({ message: 'Semua notifikasi ditandai terbaca.' });
        } catch (error) {
            res.status(500).json({ message: 'Gagal menandai notifikasi.' });
        }
    });

    return router;
};
