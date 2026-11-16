const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { JWT_SECRET } = require('../config/env');
const { sendPasswordResetEmail } = require('../utils/mailer');
const { logSafeError } = require('../utils/logger');
const { normalizeString, normalizePhone } = require('../utils/strings');
const { hashResetToken } = require('../utils/crypto');
const { isValidEmail, isValidPassword } = require('../utils/validation');

/**
 * Daftarkan route autentikasi (register, login, forgot-password, reset-password).
 */
module.exports = function createAuthRoutes(deps) {
    const { pool } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAuthRoutes requires a valid pool');
    }

    const router = express.Router();

    router.post('/api/auth/register', async (req, res) => {
        try {
            const fullName  = normalizeString(req.body.fullName, 255);
            const username  = normalizeString(req.body.username, 80);
            const email     = normalizeString(req.body.email, 255).toLowerCase();
            // Phase 2B: accept countryCode + nomorWa separately
            const countryCode  = normalizeString(req.body.countryCode || '+62', 5);
            const rawNomorWa   = normalizeString(req.body.nomorWa, 30);
            const { password } = req.body;

            // --- Basic presence checks ---
            if (!fullName)    return res.status(400).json({ message: 'Nama lengkap wajib diisi.' });
            if (!username)    return res.status(400).json({ message: 'Username wajib diisi.' });
            if (!email)       return res.status(400).json({ message: 'Email wajib diisi.' });
            if (!rawNomorWa)  return res.status(400).json({ message: 'Nomor WhatsApp wajib diisi.' });
            if (!password)    return res.status(400).json({ message: 'Password wajib diisi.' });

            // --- Field validation ---
            if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username))
                return res.status(400).json({ message: 'Username hanya boleh berisi huruf, angka, titik, strip, dan underscore (3-80 karakter).' });
            if (!isValidEmail(email))
                return res.status(400).json({ message: 'Format email tidak valid.' });
            if (!isValidPassword(password))
                return res.status(400).json({ message: 'Password minimal 8 karakter dan maksimal 128 karakter.' });

            // --- Phone normalization (Phase 2B) ---
            if (!/^\+[0-9]{1,3}$/.test(countryCode.trim()))
                return res.status(400).json({ message: 'Kode negara tidak valid. Contoh: +62' });
            const normalizedPhone = normalizePhone(countryCode, rawNomorWa);
            if (!normalizedPhone)
                return res.status(400).json({ message: 'Nomor WhatsApp tidak valid. Masukkan nomor lokal tanpa angka 0 di depan. Contoh: 81234567890' });

            // --- Pre-check duplicates (user-friendly, specific messages) ---
            const dupCheck = await pool.query(
                'SELECT username, email, nomor_wa FROM users WHERE username = $1 OR email = $2 OR (nomor_wa = $3 AND nomor_wa IS NOT NULL AND nomor_wa <> \'\')',
                [username, email, normalizedPhone]
            );
            for (const row of dupCheck.rows) {
                if (row.username === username)
                    return res.status(409).json({ message: 'Username sudah digunakan. Silakan pilih username lain.' });
                if (row.email === email)
                    return res.status(409).json({ message: 'Email sudah terdaftar. Silakan gunakan email lain atau login.' });
                if (row.nomor_wa === normalizedPhone)
                    return res.status(409).json({ message: 'Nomor WhatsApp sudah terdaftar. Gunakan nomor lain atau hubungi admin.' });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const { rows: bronzeRole } = await pool.query("SELECT id FROM roles WHERE name = 'BRONZE'");
            let defaultRoleId = 1;
            if (bronzeRole.length > 0) defaultRoleId = bronzeRole[0].id;

            const sql = 'INSERT INTO users (full_name, username, email, nomor_wa, password, role_id) VALUES ($1, $2, $3, $4, $5, $6)';
            await pool.query(sql, [fullName, username, email, normalizedPhone, hashedPassword, defaultRoleId]);
            res.status(201).json({ message: 'Registrasi berhasil! Silakan login.' });
        } catch (error) {
            // Fallback for race condition on unique constraint
            if (error.code === '23505') {
                const detail = error.detail || '';
                if (detail.includes('username'))  return res.status(409).json({ message: 'Username sudah digunakan.' });
                if (detail.includes('email'))     return res.status(409).json({ message: 'Email sudah terdaftar.' });
                if (detail.includes('nomor_wa'))  return res.status(409).json({ message: 'Nomor WhatsApp sudah terdaftar.' });
                return res.status(409).json({ message: 'Data yang Anda masukkan sudah digunakan. Periksa kembali username, email, atau nomor WhatsApp.' });
            }
            logSafeError('Error during registration:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.post('/api/auth/login', async (req, res) => {
        try {
            const username = normalizeString(req.body.username, 255);
            const { password } = req.body;
            if (!username || !password) return res.status(400).json({ message: 'Input tidak boleh kosong.' });
            const sql = 'SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = $1 OR u.email = $2';
            const { rows } = await pool.query(sql, [username, username]);
            if (rows.length === 0) return res.status(401).json({ message: 'Username atau password salah.' });
            const user = rows[0];
            const isPasswordMatch = await bcrypt.compare(password, user.password);
            if (!isPasswordMatch) return res.status(401).json({ message: 'Username atau password salah.' });
            const token = jwt.sign({ id: user.id, username: user.username, role: user.role_name }, JWT_SECRET, { expiresIn: '1d' });
            res.status(200).json({ message: 'Login berhasil!', token });
        } catch (error) {
            logSafeError('Error during login:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.post('/api/auth/forgot-password', async (req, res) => {
        const email = normalizeString(req.body.email, 255).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: 'Alamat email wajib diisi.' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ message: 'Format email tidak valid.' });
        }

        const client = await pool.connect();
        try {
            // Cek apakah email terdaftar
            const { rows: users } = await client.query('SELECT * FROM users WHERE email = $1', [email]);
            if (users.length === 0) {
                // Kirim respons sukses palsu untuk keamanan, agar orang tidak bisa menebak email terdaftar
                return res.json({ message: 'Jika email Anda terdaftar, Anda akan menerima link reset password.' });
            }

            // Buat token reset yang aman
            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashResetToken(token);
            const expires = new Date(Date.now() + 3600000); // Token berlaku selama 1 jam

            // Simpan token ke database
            await client.query(
                'INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)',
                [email, tokenHash, expires]
            );

            // Kirim email menggunakan fungsi dari mailer.js
            await sendPasswordResetEmail(email, token);

            res.json({ message: 'Jika email Anda terdaftar, Anda akan menerima link reset password.' });

        } catch (error) {
            logSafeError('Error saat proses lupa password:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        } finally {
            client.release();
        }
    });

    router.post('/api/auth/reset-password', async (req, res) => {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ message: 'Token dan password baru wajib diisi.' });
        }
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
            return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
        }
        if (!isValidPassword(newPassword)) {
            return res.status(400).json({ message: 'Password minimal 8 karakter dan maksimal 128 karakter.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN'); // Mulai transaksi untuk keamanan data
            const tokenHash = hashResetToken(token);

            // 1. Cari token di database dan pastikan belum kadaluarsa
            const { rows: resets } = await client.query(
                'SELECT * FROM password_resets WHERE token IN ($1, $2) AND expires_at > NOW()',
                [tokenHash, token]
            );

            if (resets.length === 0) {
                // Hapus token yang mungkin sudah kadaluarsa untuk kebersihan
                await client.query('DELETE FROM password_resets WHERE token IN ($1, $2)', [tokenHash, token]);
                await client.query('COMMIT'); // Simpan perubahan penghapusan
                return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
            }

            const userEmail = resets[0].email;

            // 2. Hash password baru
            const hashedPassword = await bcrypt.hash(newPassword, 10);

            // 3. Update password di tabel users
            await client.query(
                'UPDATE users SET password = $1 WHERE email = $2',
                [hashedPassword, userEmail]
            );

            // 4. Hapus semua token reset untuk email tersebut agar tidak bisa dipakai lagi
            await client.query('DELETE FROM password_resets WHERE email = $1', [userEmail]);

            await client.query('COMMIT'); // Selesaikan transaksi jika semua berhasil

            res.json({ message: 'Password berhasil direset! Silakan login dengan password baru Anda.' });

        } catch (error) {
            await client.query('ROLLBACK'); // Batalkan semua perubahan jika ada error di tengah jalan
            logSafeError('Error saat reset password:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        } finally {
            client.release();
        }
    });

    return router;
};
