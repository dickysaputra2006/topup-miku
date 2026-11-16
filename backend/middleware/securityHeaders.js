const cors = require('cors');
const { ALLOWED_ORIGINS } = require('../config/env');

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

/**
 * Pasang header keamanan HTTP ketat yang selaras dengan aset statis frontend
 * serta HSTS kondisional di produksi atau request HTTPS.
 */
function securityHeaders(req, res, next) {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

    const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const forwardedProto = String((req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase();
    const isHttpsRequest = Boolean(req.secure) || forwardedProto.split(',')[0].trim() === 'https';
    if (isProduction || isHttpsRequest) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
}

const corsMiddleware = cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        const allowList = Array.isArray(ALLOWED_ORIGINS)
            ? ALLOWED_ORIGINS.filter(item => typeof item === 'string' && item.trim() && item.trim() !== '*')
            : [];
        if (allowList.includes(origin)) {
            return callback(null, true);
        }
        const corsErr = new Error('Origin tidak diizinkan oleh CORS.');
        corsErr.statusCode = 403;
        corsErr.isCorsError = true;
        return callback(corsErr);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Idempotency-Key', 'X-Callback-Token'],
});

module.exports = {
    CONTENT_SECURITY_POLICY,
    securityHeaders,
    corsMiddleware,
};
