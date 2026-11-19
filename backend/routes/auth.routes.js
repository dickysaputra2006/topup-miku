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

const BCRYPT_SALT_ROUNDS = 12;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 menit
const GENERIC_FORGOT_PASSWORD_MESSAGE = 'Jika email Anda terdaftar, Anda akan menerima link reset password.';

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
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const fullName = normalizeString(body.fullName, 255);
            const username = normalizeString(body.username, 80);
            const email = normalizeString(body.email, 255).toLowerCase();
            // Phase 2B: accept countryCode + nomorWa separately
            const countryCode = normalizeString(body.countryCode || '+62', 5);
            const rawNomorWa = normalizeString(body.nomorWa, 30);
            const password = typeof body.password === 'string' ? body.password : '';

            // --- Basic presence checks ---
            if (!fullName) return res.status(400).json({ message: 'Nama lengkap wajib diisi.' });
            if (!username) return res.status(400).json({ message: 'Username wajib diisi.' });
            if (!email) return res.status(400).json({ message: 'Email wajib diisi.' });
            if (!rawNomorWa) return res.status(400).json({ message: 'Nomor WhatsApp wajib diisi.' });
            if (!password) return res.status(400).json({ message: 'Password wajib diisi.' });

            // --- Field validation ---
            if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username)) {
                return res.status(400).json({ message: 'Username hanya boleh berisi huruf, angka, titik, strip, dan underscore (3-80 karakter).' });
            }
            if (!isValidEmail(email)) {
                return res.status(400).json({ message: 'Format email tidak valid.' });
            }
            if (!isValidPassword(password)) {
                return res.status(400).json({ message: 'Password minimal 8 karakter dan maksimal 128 karakter.' });
            }

            // --- Phone normalization (Phase 2B) ---
            if (!/^\+[0-9]{1,3}$/.test(countryCode.trim())) {
                return res.status(400).json({ message: 'Kode negara tidak valid. Contoh: +62' });
            }
            const normalizedPhone = normalizePhone(countryCode, rawNomorWa);
            if (!normalizedPhone) {
                return res.status(400).json({ message: 'Nomor WhatsApp tidak valid. Masukkan nomor lokal tanpa angka 0 di depan. Contoh: 81234567890' });
            }

            // --- Pre-check duplicates (user-friendly, specific messages) ---
            const dupCheck = await pool.query(
                'SELECT username, email, nomor_wa FROM users WHERE username = $1 OR email = $2 OR (nomor_wa = $3 AND nomor_wa IS NOT NULL AND nomor_wa <> \'\')',
                [username, email, normalizedPhone]
            );
            for (const row of dupCheck.rows) {
                if (row.username === username) {
                    return res.status(409).json({ message: 'Username sudah digunakan. Silakan pilih username lain.' });
                }
                if (row.email === email) {
                    return res.status(409).json({ message: 'Email sudah terdaftar. Silakan gunakan email lain atau login.' });
                }
                if (row.nomor_wa === normalizedPhone) {
                    return res.status(409).json({ message: 'Nomor WhatsApp sudah terdaftar. Gunakan nomor lain atau hubungi admin.' });
                }
            }

            const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
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
                if (detail.includes('username')) return res.status(409).json({ message: 'Username sudah digunakan.' });
                if (detail.includes('email')) return res.status(409).json({ message: 'Email sudah terdaftar.' });
                if (detail.includes('nomor_wa')) return res.status(409).json({ message: 'Nomor WhatsApp sudah terdaftar.' });
                return res.status(409).json({ message: 'Data yang Anda masukkan sudah digunakan. Periksa kembali username, email, atau nomor WhatsApp.' });
            }
            logSafeError('Error during registration:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.post('/api/auth/login', async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const username = normalizeString(body.username, 255);
            const password = typeof body.password === 'string' ? body.password : '';
            if (!username || !password) {
                return res.status(400).json({ message: 'Input tidak boleh kosong.' });
            }
            const sql = 'SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = $1 OR LOWER(u.email) = LOWER($2)';
            const { rows } = await pool.query(sql, [username, username]);
            if (rows.length === 0) {
                return res.status(401).json({ message: 'Username atau password salah.' });
            }
            const user = rows[0];
            const isPasswordMatch = await bcrypt.compare(password, user.password);
            if (!isPasswordMatch) {
                return res.status(401).json({ message: 'Username atau password salah.' });
            }
            const tokenVersion = user.token_version !== undefined && user.token_version !== null
                ? Number(user.token_version)
                : 1;
            const token = jwt.sign(
                { id: user.id, username: user.username, role: user.role_name, tokenVersion },
                JWT_SECRET,
                { expiresIn: '1d' }
            );
            res.status(200).json({ message: 'Login berhasil!', token });
        } catch (error) {
            logSafeError('Error during login:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    router.post('/api/auth/forgot-password', async (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const email = normalizeString(body.email, 255).toLowerCase();
        if (!email) {
            return res.status(400).json({ message: 'Alamat email wajib diisi.' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ message: 'Format email tidak valid.' });
        }

        const client = await pool.connect();
        let inTransaction = false;
        let resetTokenPlain = null;
        try {
            const { rows: users } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
            if (users.length === 0) {
                // Respons generik agar tidak membocorkan apakah email terdaftar
                return res.json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
            }

            const token = crypto.randomBytes(32).toString('hex');
            const tokenHash = hashResetToken(token);
            const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);

            await client.query('BEGIN');
            inTransaction = true;
            await client.query('DELETE FROM password_resets WHERE email = $1', [email]);
            await client.query(
                'INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)',
                [email, tokenHash, expires]
            );
            await client.query('COMMIT');
            inTransaction = false;
            resetTokenPlain = token;
        } catch (error) {
            if (inTransaction) {
                await client.query('ROLLBACK').catch(() => {});
            }
            logSafeError('Error saat proses lupa password:', error);
            return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        } finally {
            client.release();
        }

        if (resetTokenPlain) {
            try {
                await sendPasswordResetEmail(email, resetTokenPlain);
            } catch (mailError) {
                // Jangan bocorkan kegagalan pengiriman email sebagai sinyal eksistensi akun
                logSafeError('Error saat mengirim email reset password:', mailError);
            }
        }

        return res.json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
    });

    router.post('/api/auth/reset-password', async (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

        if (!token || !newPassword) {
            return res.status(400).json({ message: 'Token dan password baru wajib diisi.' });
        }
        if (!/^[a-f0-9]{64}$/i.test(token)) {
            return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
        }
        if (!isValidPassword(newPassword)) {
            return res.status(400).json({ message: 'Password minimal 8 karakter dan maksimal 128 karakter.' });
        }

        const client = await pool.connect();
        let inTransaction = false;
        try {
            await client.query('BEGIN');
            inTransaction = true;
            const tokenHash = hashResetToken(token);

            // Kunci baris token dengan FOR UPDATE untuk konsumsi atomik sekali pakai
            const { rows: resets } = await client.query(
                'SELECT id, email, expires_at, (expires_at > NOW()) AS is_valid FROM password_resets WHERE token = $1 FOR UPDATE',
                [tokenHash]
            );

            const resetRow = resets && resets[0];
            const expiresMs = resetRow && resetRow.expires_at ? new Date(resetRow.expires_at).getTime() : NaN;
            const hasNotExpired = Boolean(resetRow)
                && resetRow.is_valid !== false
                && (resetRow.is_valid === true || (Number.isFinite(expiresMs) && expiresMs > Date.now()))
                && (!Number.isFinite(expiresMs) || expiresMs > Date.now());

            if (!resetRow || !hasNotExpired) {
                await client.query('DELETE FROM password_resets WHERE token = $1', [tokenHash]);
                await client.query('COMMIT');
                inTransaction = false;
                return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
            }

            const userEmail = resetRow.email;
            const consumeRes = await client.query(
                'DELETE FROM password_resets WHERE email = $1 RETURNING id',
                [userEmail]
            );
            if (consumeRes && typeof consumeRes.rowCount === 'number' && consumeRes.rowCount === 0) {
                await client.query('COMMIT');
                inTransaction = false;
                return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
            }

            const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
            await client.query(
                'UPDATE users SET password = $1, token_version = COALESCE(token_version, 1) + 1 WHERE LOWER(email) = LOWER($2)',
                [hashedPassword, userEmail]
            );

            await client.query('COMMIT');
            inTransaction = false;

            return res.json({ message: 'Password berhasil direset! Silakan login dengan password baru Anda.' });
        } catch (error) {
            if (inTransaction) {
                await client.query('ROLLBACK').catch(() => {});
            }
            logSafeError('Error saat reset password:', error);
            return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        } finally {
            client.release();
        }
    });

    return router;
};
