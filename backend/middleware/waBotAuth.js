const crypto = require('crypto');

/**
 * Middleware: requireWaBotAdminToken
 *
 * Memeriksa header Authorization: Bearer <WA_BOT_ADMIN_TOKEN>.
 * - Jika env WA_BOT_ADMIN_TOKEN tidak dikonfigurasi -> 503 (aman, tidak bocor info).
 * - Jika token tidak ada -> 401.
 * - Jika token salah -> 403 (constant-time compare untuk mencegah timing attack).
 * - Token tidak pernah dilog; env dibaca setiap request.
 */
function requireWaBotAdminToken(req, res, next) {
    const configuredToken = process.env.WA_BOT_ADMIN_TOKEN;

    // Jika env belum dikonfigurasi atau kurang dari 32 karakter, endpoint tidak bisa dipakai (fail-safe)
    if (!configuredToken || configuredToken.trim().length < 32) {
        return res.status(503).json({ message: 'Bot admin token belum dikonfigurasi dengan aman (minimal 32 karakter).' });
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Token bot diperlukan.' });
    }

    const providedToken = authHeader.slice(7); // strip "Bearer "

    // Constant-time compare — cegah timing attack
    const configBuf = Buffer.from(configuredToken);
    const providedBuf = Buffer.from(providedToken);

    // Panjang berbeda = langsung tolak (setelah alloc buffer kosong untuk timing)
    const lenOk = configBuf.length === providedBuf.length;
    // timingSafeEqual butuh panjang sama, pakai dummy jika beda panjang
    const cmpBuf = lenOk ? providedBuf : Buffer.alloc(configBuf.length);
    let tokensMatch = false;
    try {
        tokensMatch = crypto.timingSafeEqual(configBuf, cmpBuf);
    } catch (_) {
        tokensMatch = false;
    }

    if (!lenOk || !tokensMatch) {
        return res.status(403).json({ message: 'Token bot tidak valid.' });
    }

    next();
}

module.exports = {
    requireWaBotAdminToken,
};
