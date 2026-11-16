const express = require('express');
const crypto = require('crypto');
const { logSafeError } = require('../utils/logger');
const { normalizeString } = require('../utils/strings');
const { hashApiKey } = require('../utils/crypto');
const { isValidIpOrCidr } = require('../utils/networkSecurity');

/**
 * Daftarkan route manajemen API key, webhook secret, dan IP whitelist H2H pengguna.
 */
module.exports = function createUserApiKeyRoutes(deps) {
    const { pool, protect } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createUserApiKeyRoutes requires a valid pool');
    }
    if (typeof protect !== 'function') {
        throw new TypeError('createUserApiKeyRoutes requires a protect middleware');
    }

    const router = express.Router();

    async function handleGenerateOrRegenerateApiKey(req, res) {
        try {
            const newApiKey = crypto.randomBytes(32).toString('hex');
            const apiKeyHash = hashApiKey(newApiKey);
            const apiKeyPrefix = newApiKey.slice(0, 8);
            const candidateWebhookSecret = crypto.randomBytes(32).toString('hex');

            const result = await pool.query(
                `UPDATE users
                 SET api_key = NULL,
                     api_key_hash = $1,
                     api_key_prefix = $2,
                     h2h_webhook_secret = COALESCE(h2h_webhook_secret, $3)
                 WHERE id = $4
                 RETURNING api_key_prefix, (h2h_webhook_secret = $3) AS webhook_secret_created`,
                [apiKeyHash, apiKeyPrefix, candidateWebhookSecret, req.user.id]
            );
            const updatedRow = result && result.rows && result.rows[0];
            const responseBody = {
                message: 'API Key baru berhasil dibuat! Harap simpan di tempat aman. Key ini hanya ditampilkan sekali.',
                apiKey: newApiKey,
                prefix: (updatedRow && updatedRow.api_key_prefix) || apiKeyPrefix,
                hasApiKey: true,
                status: 'active'
            };
            if (updatedRow && updatedRow.webhook_secret_created === true) {
                responseBody.webhookSecret = candidateWebhookSecret;
            }
            res.json(responseBody);
        } catch (error) {
            logSafeError('Error generating API key:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    }

    async function handleRevokeApiKey(req, res) {
        try {
            await pool.query(
                'UPDATE users SET api_key = NULL, api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1',
                [req.user.id]
            );
            res.json({
                message: 'API Key berhasil dicabut.',
                hasApiKey: false,
                status: 'inactive',
                prefix: null
            });
        } catch (error) {
            logSafeError('Error revoking API key:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    }

    router.post('/api/user/generate-apikey', protect, handleGenerateOrRegenerateApiKey);
    router.post('/api/user/apikey/regenerate', protect, handleGenerateOrRegenerateApiKey);

    router.get('/api/user/apikey', protect, async (req, res) => {
        try {
            const sql = 'SELECT api_key_prefix, api_key_hash, api_key FROM users WHERE id = $1';
            const { rows } = await pool.query(sql, [req.user.id]);
            if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
            const row = rows[0];
            const hasApiKey = Boolean(row.api_key_hash || row.api_key);
            const prefix = hasApiKey
                ? (row.api_key_prefix || (row.api_key ? String(row.api_key).slice(0, 8) : null))
                : null;
            res.json({
                hasApiKey,
                status: hasApiKey ? 'active' : 'inactive',
                prefix
            });
        } catch (error) {
            logSafeError('Error fetching API key status:', error);
            res.status(500).json({ message: 'Server error saat mengambil status API key.' });
        }
    });

    router.delete('/api/user/apikey', protect, handleRevokeApiKey);
    router.post('/api/user/apikey/revoke', protect, handleRevokeApiKey);

    router.get('/api/user/webhook-secret', protect, async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT h2h_webhook_secret FROM users WHERE id = $1', [req.user.id]);
            if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
            const secret = rows[0].h2h_webhook_secret;
            const hasWebhookSecret = typeof secret === 'string' && secret.length > 0;
            res.json({
                hasWebhookSecret,
                status: hasWebhookSecret ? 'active' : 'inactive',
                prefix: hasWebhookSecret ? secret.slice(0, 8) : null
            });
        } catch (error) {
            logSafeError('Error fetching webhook secret status:', error);
            res.status(500).json({ message: 'Server error saat mengambil status webhook secret.' });
        }
    });

    router.post('/api/user/webhook-secret/rotate', protect, async (req, res) => {
        try {
            const newSecret = crypto.randomBytes(32).toString('hex');
            await pool.query('UPDATE users SET h2h_webhook_secret = $1 WHERE id = $2', [newSecret, req.user.id]);
            res.json({
                message: 'Webhook secret baru berhasil dibuat! Harap simpan di tempat aman. Secret ini hanya ditampilkan sekali.',
                webhookSecret: newSecret,
                prefix: newSecret.slice(0, 8),
                hasWebhookSecret: true,
                status: 'active'
            });
        } catch (error) {
            logSafeError('Error rotating webhook secret:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }
    });

    // Endpoint untuk menambahkan IP yang di-whitelist
    router.get('/api/user/whitelisted-ips', protect, async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT whitelisted_ips FROM users WHERE id = $1', [req.user.id]);
            if (rows.length === 0) {
                return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
            }
            // Kirim array IP, atau array kosong jika belum ada
            res.json(rows[0].whitelisted_ips || []);
        } catch (error) {
            console.error('Error fetching whitelisted IPs:', error);
            res.status(500).json({ message: 'Gagal mengambil data IP.' });
        }
    });

    // Memperbarui daftar IP yang di-whitelist oleh pengguna
    router.put('/api/user/whitelisted-ips', protect, async (req, res) => {
        try {
            const { ips } = req.body;
            // Validasi sederhana: pastikan data yang dikirim adalah array
            if (!Array.isArray(ips)) {
                return res.status(400).json({ message: 'Format data tidak valid, harus berupa array.' });
            }
            if (ips.length > 20) {
                return res.status(400).json({ message: 'Maksimal 20 IP whitelist.' });
            }
            const cleanedIps = [...new Set(ips.map(ip => normalizeString(ip, 64)).filter(Boolean))];
            if (!cleanedIps.every(isValidIpOrCidr)) {
                return res.status(400).json({ message: 'Daftar IP mengandung format yang tidak valid.' });
            }
            await pool.query('UPDATE users SET whitelisted_ips = $1 WHERE id = $2', [cleanedIps, req.user.id]);
            res.json({ message: 'Daftar IP berhasil diperbarui.' });
        } catch (error) {
            console.error('Error updating whitelisted IPs:', error);
            res.status(500).json({ message: 'Gagal memperbarui daftar IP.' });
        }
    });

    return router;
};
