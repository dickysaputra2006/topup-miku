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

    const protect = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Akses ditolak, tidak ada token.' });
        try {
            const token = authHeader.split(' ')[1];
            req.user = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
            next();
        } catch (error) {
            res.status(401).json({ message: 'Token tidak valid.' });
        }
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
