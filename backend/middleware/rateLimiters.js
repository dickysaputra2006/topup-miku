const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

/**
 * Bangun seluruh rate limiter aplikasi beserta fungsi pemasangannya pada app.
 */
function createRateLimiters({ normalizeString, hashApiKey }) {
    if (typeof normalizeString !== 'function') {
        throw new TypeError('createRateLimiters requires a normalizeString function');
    }
    if (typeof hashApiKey !== 'function') {
        throw new TypeError('createRateLimiters requires a hashApiKey function');
    }

    // Aturan ketat untuk endpoint login, lupa password, dan bot admin
    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 menit
        max: 30, // Batasi setiap IP maksimal 30 request per 15 menit
        message: 'Terlalu banyak percobaan login dari IP ini, silakan coba lagi setelah 15 menit.',
        standardHeaders: true,
        legacyHeaders: false,
    });

    const registerLimiter = rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 5,
        message: 'Terlalu banyak percobaan registrasi dari IP ini, silakan coba lagi nanti.',
        standardHeaders: true,
        legacyHeaders: false,
    });

    const checkoutLimiter = rateLimit({
        windowMs: 5 * 60 * 1000,
        max: 30,
        message: 'Terlalu banyak percobaan checkout, silakan coba lagi nanti.',
        standardHeaders: true,
        legacyHeaders: false,
    });

    const h2hLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        keyGenerator: (req) => {
            const rawApiKey = normalizeString(req.headers['x-api-key'], 128);
            if (rawApiKey) {
                return `h2h-key:${hashApiKey(rawApiKey)}`;
            }
            return `h2h-ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`;
        },
        message: { success: false, message: 'Terlalu banyak permintaan H2H, silakan coba lagi nanti.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    const h2hUserLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        keyGenerator: (req) => {
            if (req.user && req.user.id !== undefined && req.user.id !== null) {
                return `h2h-user:${req.user.id}`;
            }
            return `h2h-ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`;
        },
        message: { success: false, message: 'Terlalu banyak permintaan H2H, silakan coba lagi nanti.' },
        standardHeaders: true,
        legacyHeaders: false,
    });

    // Aturan umum untuk endpoint API lainnya yang butuh login
    const apiLimiter = rateLimit({
        windowMs: 5 * 60 * 1000, // 5 menit
        max: 300, // Batasi setiap IP 100 request per 5 menit
        message: 'Terlalu banyak permintaan ke API dari IP ini, silakan coba lagi nanti.',
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Pasang rate limiter ke endpoint sesuai urutan pemasangan di server.js.
     */
    function applyRateLimiters(app) {
        // Terapkan limiter ke endpoint yang relevan
        app.use('/api/auth/login', authLimiter);
        app.use('/api/auth/register', registerLimiter);
        app.use('/api/auth/forgot-password', authLimiter);
        app.use('/api/auth/reset-password', authLimiter);

        app.use('/api/user', apiLimiter);
        app.use('/api/deposit', apiLimiter);
        app.use('/api/payment-methods', apiLimiter);
        app.use('/api/bot', authLimiter);
        app.use('/api/foxy/callback', apiLimiter);
        app.use('/api/order', checkoutLimiter);
        app.use('/api/order', apiLimiter);
        app.use('/h2h', h2hLimiter);
        app.use('/h2h', apiLimiter);
        app.use('/api/full-validate', apiLimiter);
        app.use('/api/products', apiLimiter);
    }

    return {
        authLimiter,
        registerLimiter,
        checkoutLimiter,
        h2hLimiter,
        h2hUserLimiter,
        apiLimiter,
        applyRateLimiters,
    };
}

module.exports = { createRateLimiters };
