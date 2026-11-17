require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const REQUIRED_ENV = ['JWT_SECRET'];
const RECOMMENDED_RUNTIME_ENV = ['DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_PORT', 'FOXY_API_KEY'];
// Optional local/dev integrations: FOXY_BASE_URL, CORS_ORIGINS, APP_BASE_URL, BREVO_API_KEY, PGS_KEY, PGS_API_KEY.
const DEFAULT_ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'https://mikutopup.my.id'
];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const FOXY_API_KEY = process.env.FOXY_API_KEY;
const FOXY_CALLBACK_URL = process.env.FOXY_CALLBACK_URL || 'https://mikutopup.my.id/api/foxy/callback';

/**
 * Validasi environment variables wajib & opsional saat startup server.
 */
function validateEnvironment({ strict = false } = {}) {
    const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const requiredVars = isProduction
        ? [...REQUIRED_ENV, 'FOXY_CALLBACK_SECRET']
        : REQUIRED_ENV;
    const missingRequired = requiredVars.filter(name => !(process.env[name] || '').trim());
    const missingRecommended = RECOMMENDED_RUNTIME_ENV.filter(name => !process.env[name]);

    if (missingRequired.length > 0) {
        const message = `Missing required environment variables: ${missingRequired.join(', ')}`;
        if (strict) throw new Error(message);
        console.warn(`[env] ${message}`);
    }

    if (!isProduction && !(process.env.FOXY_CALLBACK_SECRET || '').trim() &&
        String(process.env.ALLOW_INSECURE_CALLBACK || '').toLowerCase() !== 'true') {
        console.warn('[env] FOXY_CALLBACK_SECRET is not set. /api/foxy/callback will reject callbacks (403) unless ALLOW_INSECURE_CALLBACK=true in non-production.');
    }

    if (missingRecommended.length > 0) {
        console.warn(`[env] Missing runtime environment variables: ${missingRecommended.join(', ')}`);
    }

    if (!process.env.FOXY_CALLBACK_URL) {
        console.warn('[env] FOXY_CALLBACK_URL is not set. Using default: https://mikutopup.my.id/api/foxy/callback');
    }

    const rawFoxyBaseUrl = (process.env.FOXY_BASE_URL || '').trim();
    if (rawFoxyBaseUrl) {
        let parsedFoxyUrl = null;
        try {
            parsedFoxyUrl = new URL(rawFoxyBaseUrl);
        } catch {
            parsedFoxyUrl = null;
        }
        if (!parsedFoxyUrl || !['http:', 'https:'].includes(parsedFoxyUrl.protocol)) {
            const message = 'FOXY_BASE_URL must be a valid http:// or https:// URL.';
            if (strict) throw new Error(message);
            console.warn(`[env] ${message}`);
        }
    }
}

module.exports = {
    PORT,
    JWT_SECRET,
    REQUIRED_ENV,
    RECOMMENDED_RUNTIME_ENV,
    DEFAULT_ALLOWED_ORIGINS,
    ALLOWED_ORIGINS,
    FOXY_API_KEY,
    FOXY_CALLBACK_URL,
    validateEnvironment,
};
