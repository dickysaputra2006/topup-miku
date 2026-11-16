const crypto = require('crypto');
const { isLoopbackIp, isIpInAllowList } = require('../utils/networkSecurity');
const { normalizeString } = require('../utils/strings');
const { hashApiKey, timingSafeStringEqual } = require('../utils/crypto');
const { isValidApiKey } = require('../utils/validation');
const { logSafeError } = require('../utils/logger');

/**
 * Bangun middleware autentikasi & IP whitelist H2H memakai instance pool yang diberikan.
 */
function createH2HAuthMiddleware({ pool }) {
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createH2HAuthMiddleware requires a valid pool');
    }

    const protectH2H = async (req, res, next) => {
        const apiKey = normalizeString(req.headers['x-api-key'], 128);
        if (!apiKey) {
            return res.status(401).json({ success: false, message: 'API Key tidak ditemukan di header X-API-Key.' });
        }
        if (!isValidApiKey(apiKey)) {
            return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
        }
        try {
            const keyHash = hashApiKey(apiKey);
            const sql = `
                SELECT u.id, u.username, u.balance, u.api_key, u.api_key_hash, u.api_key_prefix,
                       u.role_id, u.h2h_callback_url, r.name as role_name 
                FROM users u 
                JOIN roles r ON u.role_id = r.id 
                WHERE u.api_key_hash = $2 OR u.api_key = $1`;
            const { rows } = await pool.query(sql, [apiKey, keyHash]);

            if (rows.length === 0) {
                return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
            }

            const matchedUser = rows[0];
            const hasHash = typeof matchedUser.api_key_hash === 'string' && matchedUser.api_key_hash.length > 0;
            const hasPlain = typeof matchedUser.api_key === 'string' && matchedUser.api_key.length > 0;

            if (hasHash) {
                if (!timingSafeStringEqual(matchedUser.api_key_hash, keyHash)) {
                    return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
                }
            } else if (hasPlain) {
                if (!timingSafeStringEqual(matchedUser.api_key, apiKey)) {
                    return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
                }
                // Transisi lazy migration SEC-004 + SEC-007: hash & prefix disimpan, plaintext dihapus,
                // dan h2h_webhook_secret disiapkan bila reseller lama belum memilikinya.
                const keyPrefix = apiKey.slice(0, 8);
                const candidateWebhookSecret = crypto.randomBytes(32).toString('hex');
                try {
                    await pool.query(
                        `UPDATE users
                         SET api_key_hash = $1,
                             api_key_prefix = $2,
                             api_key = NULL,
                             h2h_webhook_secret = COALESCE(NULLIF(h2h_webhook_secret, ''), $4)
                         WHERE id = $3 AND (api_key_hash IS NULL OR api_key IS NOT NULL OR h2h_webhook_secret IS NULL OR h2h_webhook_secret = '')`,
                        [keyHash, keyPrefix, matchedUser.id, candidateWebhookSecret]
                    );
                } catch (_migErr) {
                    // Jangan blokir request valid bila update lazy migration gagal sementara
                }
            } else {
                return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
            }

            const { api_key: _plainKey, api_key_hash: _storedHash, ...safeUser } = matchedUser;
            req.user = safeUser;
            next();
        } catch (error) {
            logSafeError('H2H Auth Error:', error);
            res.status(500).json({ success: false, message: 'Server error saat validasi API Key.' });
        }
    };

    const protectH2HIp = async (req, res, next) => {
        const requestIp = req.ip;
        const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

        if (!isProduction && isLoopbackIp(requestIp)) {
            return next();
        }

        const apiKey = normalizeString(req.headers['x-api-key'], 128);
        if (!apiKey || !isValidApiKey(apiKey)) {
            return next();
        }

        try {
            const keyHash = hashApiKey(apiKey);
            const { rows } = await pool.query(
                'SELECT id, whitelisted_ips, api_key, api_key_hash FROM users WHERE api_key_hash = $2 OR api_key = $1',
                [apiKey, keyHash]
            );

            if (rows.length > 0) {
                const user = rows[0];
                const hasHash = typeof user.api_key_hash === 'string' && user.api_key_hash.length > 0;
                const hasPlain = typeof user.api_key === 'string' && user.api_key.length > 0;
                if (hasHash && !timingSafeStringEqual(user.api_key_hash, keyHash)) {
                    return next();
                }
                if (!hasHash && hasPlain && !timingSafeStringEqual(user.api_key, apiKey)) {
                    return next();
                }

                const allowedIps = user.whitelisted_ips || [];
                if (Array.isArray(allowedIps) && allowedIps.length > 0 && !isIpInAllowList(requestIp, allowedIps)) {
                    console.warn(`[IP Whitelist] Akses DITOLAK untuk IP: ${requestIp} (userId=${user.id || 'unknown'})`);
                    return res.status(403).json({ success: false, message: 'Alamat IP Anda tidak diizinkan.' });
                }
            }
            next();
        } catch (error) {
            logSafeError('Error di middleware IP Whitelist:', error);
            res.status(500).json({ success: false, message: 'Server error saat validasi IP.' });
        }
    };

    return {
        protectH2H,
        protectH2HIp,
    };
}

module.exports = { createH2HAuthMiddleware };
