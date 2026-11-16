const cors = require('cors');
const { ALLOWED_ORIGINS } = require('../config/env');

/**
 * Pasang header keamanan HTTP standar pada setiap respons.
 */
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https:; img-src 'self' data: https:;");
    next();
}

const corsMiddleware = cors({
    origin(origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin tidak diizinkan oleh CORS.'));
    }
});

module.exports = {
    securityHeaders,
    corsMiddleware,
};
