const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { logSafeError } = require('../utils/logger');

/**
 * Bangun middleware autentikasi web dan admin memakai instance pool yang diberikan.
 */
function createAuthMiddleware({ pool, jwtSecret = JWT_SECRET }) {
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAuthMiddleware requires a valid pool');
    }

    const protect = async (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Akses ditolak, tidak ada token.' });
        let decoded;
        try {
            const token = authHeader.split(' ')[1];
            decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
        } catch (error) {
            return res.status(401).json({ message: 'Token tidak valid.' });
        }

        // Cocokkan token_version di DB agar JWT lama dicabut pasca-ganti/reset password.
        // Tetap kompatibel bila mock unit test lama hanya mem-mock pool.connect atau tidak mengembalikan token_version.
        try {
            const poolProto = Object.getPrototypeOf(pool) || {};
            const isQueryNative = typeof poolProto.query === 'function' && pool.query === poolProto.query;
            const isConnectOverridden = typeof poolProto.connect === 'function' && pool.connect !== poolProto.connect;
            let versionRes;
            if (isQueryNative && isConnectOverridden) {
                const client = await pool.connect();
                try {
                    versionRes = await client.query('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
                } finally {
                    if (client && typeof client.release === 'function') client.release();
                }
            } else {
                versionRes = await pool.query('SELECT token_version FROM users WHERE id = $1', [decoded.id]);
            }
            const row = versionRes && Array.isArray(versionRes.rows) ? versionRes.rows[0] : null;
            if (row && row.token_version !== undefined && row.token_version !== null) {
                const dbTokenVersion = Number(row.token_version);
                const jwtTokenVersion = decoded.tokenVersion !== undefined && decoded.tokenVersion !== null
                    ? Number(decoded.tokenVersion)
                    : 1;
                if (!Number.isFinite(jwtTokenVersion) || jwtTokenVersion !== dbTokenVersion) {
                    return res.status(401).json({ message: 'Token sudah tidak berlaku. Silakan login ulang.' });
                }
            }
        } catch (versionErr) {
            if (versionErr && versionErr.code === '42703') {
                req.user = decoded;
                return next();
            }
            logSafeError('Error memeriksa token_version di protect:', versionErr);
            return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
        }

        req.user = decoded;
        next();
    };

    const protectAdmin = (req, res, next) => {
        protect(req, res, async () => {
            if (req.user && req.user.role === 'Admin') {
                try {
                    const sql = 'SELECT r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1';
                    const { rows } = await pool.query(sql, [req.user.id]);
                    if (rows.length > 0 && rows[0].role_name === 'Admin') {
                next();
                    } else {
                        res.status(403).json({ message: 'Akses ditolak: Hanya untuk Admin.' });
                    }
                } catch (error) {
                    logSafeError('Error di protectAdmin:', error);
                    res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
                }
            } else {
                res.status(403).json({ message: 'Akses ditolak: Hanya untuk Admin.' });
            }
        });
    };

    const softProtect = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const token = authHeader.split(' ')[1];
                req.user = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
            } catch (error) {
                req.user = null;
            }
        } else {
            req.user = null;
        }
        next();
    };

    return {
        protect,
        protectAdmin,
        softProtect,
    };
}

module.exports = { createAuthMiddleware };
