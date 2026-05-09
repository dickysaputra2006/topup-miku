require('dotenv').config();
const rateLimit = require('express-rate-limit');
const express = require('express');
const fs = require('fs').promises;
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const net = require('net');
const { sendPasswordResetEmail } = require('./utils/mailer.js');
const { syncProductsWithFoxy } = require('./utils/cronUtils.js');
const { validateGameId } = require('./utils/validators/cek-id-game.js');
const { checkAllMobapayPromosML } = require('./utils/validators/stalk-ml-promo.js');
const { cekPromoMcggMobapay } = require('./utils/validators/stalk-mcgg.js');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // untuk mendapatkan IP asli di belakang proxy
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const REQUIRED_ENV = ['JWT_SECRET'];
const RECOMMENDED_RUNTIME_ENV = ['DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_PORT', 'FOXY_API_KEY'];
// Optional local/dev integrations: CORS_ORIGINS, APP_BASE_URL, BREVO_API_KEY, PGS_KEY, PGS_API_KEY.
const BOT_PRODUCT_BLACKLIST = ['FXGT', 'Via Login', 'Gifts'];
const MAX_BODY_SIZE = '100kb';
const DUPLICATE_ORDER_WINDOW_SECONDS = 15;
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

function validateEnvironment({ strict = false } = {}) {
    const missingRequired = REQUIRED_ENV.filter(name => !process.env[name]);
    const missingRecommended = RECOMMENDED_RUNTIME_ENV.filter(name => !process.env[name]);

    if (missingRequired.length > 0) {
        const message = `Missing required environment variables: ${missingRequired.join(', ')}`;
        if (strict) throw new Error(message);
        console.warn(`[env] ${message}`);
    }

    if (missingRecommended.length > 0) {
        console.warn(`[env] Missing runtime environment variables: ${missingRecommended.join(', ')}`);
    }

    if (!process.env.FOXY_CALLBACK_URL) {
        console.warn('[env] FOXY_CALLBACK_URL is not set. Using default: https://mikutopup.my.id/api/foxy/callback');
    }
}

function safeErrorDetail(error) {
    if (!error) return { message: 'Unknown error' };
    const detail = {};
    if (error.code) detail.code = error.code;
    if (error.response && error.response.status) detail.status = error.response.status;
    if (error.message) detail.message = String(error.message).replace(/(api[_-]?key|authorization|password|token|secret)=?[^\s,]*/gi, '$1=[REDACTED]');
    return detail;
}

function logSafeError(label, error) {
    console.error(label, safeErrorDetail(error));
}

/**
 * Safe summary of Axios/provider error. Never prints Authorization, config.headers,
 * request._header, or full response body. Detects Cloudflare challenge.
 */
function safeAxiosError(error, providerName) {
    const name = providerName || 'Provider';
    if (!error) return { provider: name, message: 'Unknown error' };
    const safe = { provider: name };
    if (error.message) {
        safe.message = String(error.message)
            .replace(/(api[_-]?key|authorization|password|token|secret)=?[^\s,]*/gi, '$1=[REDACTED]');
    }
    if (error.response) {
        safe.status = error.response.status;
        safe.statusText = error.response.statusText;
        if (error.response.config) {
            safe.method = error.response.config.method ? error.response.config.method.toUpperCase() : undefined;
            safe.url = error.response.config.url;
        }
        const cfHeader = error.response.headers && error.response.headers['cf-mitigated'];
        const bodyStr = typeof error.response.data === 'string' ? error.response.data : '';
        const isCloudflare = error.response.status === 403 &&
            (cfHeader === 'challenge' || bodyStr.includes('Just a moment'));
        safe.isCloudflareChallenge = isCloudflare;
        safe.responseContentType = error.response.headers && error.response.headers['content-type'];
        if (isCloudflare) safe.note = 'Provider blocked request with Cloudflare challenge';
    } else if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
        safe.note = 'Request timed out';
    } else if (error.code) {
        safe.code = error.code;
    }
    return safe;
}

function normalizeString(value, maxLength = 255) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255;
}

function isValidPassword(password) {
    return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

/**
 * Normalize a WhatsApp number to E.164 format.
 * Accepts: countryCode (e.g. '+62') + localNumber (e.g. '81234567890' or '081234567890').
 * Returns the normalized string (e.g. '+6281234567890') or null if invalid.
 *
 * Rules:
 *   - Strip spaces, dashes, parentheses from localNumber
 *   - Strip a leading '0' from localNumber (common Indonesian format: 081xxx -> 81xxx)
 *   - Concatenate countryCode + stripped localNumber
 *   - Final result must match E.164 pattern: +[1-3 digit country][6-12 digit local]
 */
function normalizePhone(countryCode, localNumber) {
    if (typeof countryCode !== 'string' || typeof localNumber !== 'string') return null;
    // Sanitize country code: must start with '+' followed by 1-3 digits
    const cc = countryCode.trim().replace(/\s+/g, '');
    if (!/^\+[0-9]{1,3}$/.test(cc)) return null;
    // Sanitize local number: strip formatting chars
    let local = localNumber.trim().replace(/[\s\-().]/g, '');
    // Strip leading '0' (e.g. 0812 -> 812)
    if (local.startsWith('0')) local = local.slice(1);
    // Only digits allowed in local part
    if (!/^[0-9]+$/.test(local)) return null;
    // Reasonable length: 6-12 digits for local part
    if (local.length < 6 || local.length > 12) return null;
    return cc + local;
}

function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function isValidApiKey(apiKey) {
    return typeof apiKey === 'string' && /^[a-f0-9]{48}$/i.test(apiKey);
}

function isValidIpOrCidr(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    const [ip, prefix] = trimmed.split('/');
    if (!net.isIP(ip)) return false;
    if (prefix === undefined) return true;
    if (!/^\d{1,3}$/.test(prefix)) return false;
    const prefixNumber = Number(prefix);
    return net.isIP(ip) === 4 ? prefixNumber >= 0 && prefixNumber <= 32 : prefixNumber >= 0 && prefixNumber <= 128;
}

function isPrivateHostname(hostname) {
    const lower = hostname.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.local')) return true;
    if (net.isIP(lower) === 4) {
        const parts = lower.split('.').map(Number);
        return parts[0] === 10 ||
            parts[0] === 127 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 169 && parts[1] === 254);
    }
    if (net.isIP(lower) === 6) {
        return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
    }
    return false;
}

function isValidHttpsCallbackUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !isPrivateHostname(parsed.hostname);
    } catch (error) {
        return false;
    }
}

function isValidPriceAmount(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 && numberValue <= 100000000;
}

function getSafeOrderErrorMessage(error, fallback) {
    const message = error && error.message ? error.message : '';
    const allowedMessages = [
        'Produk dan ID Game wajib diisi.',
        'productId dan targetGameId wajib diisi.',
        'Produk tidak valid atau tidak aktif.',
        'Terjadi perubahan harga',
        'Harga produk sedang diperbarui',
        'Produk sedang tidak tersedia',
        'Server ID wajib diisi',
        'Saldo Anda tidak mencukupi.',
        'Saldo H2H Anda tidak mencukupi.',
        'Harga produk tidak valid.',
        'Pesanan serupa masih pending',
        'Gagal mengirim pesanan ke provider.',
        'Kode promo tidak ditemukan',
        'Kode promo sudah kedaluwarsa.',
        'Kuota penggunaan promo',
        'Anda sudah mencapai batas maksimal',
        'Promo ini hanya berlaku',
        'Promo ini tidak berlaku',
        'Nilai diskon promo tidak valid.'
    ];
    return allowedMessages.some(allowed => message.startsWith(allowed)) ? message : fallback;
}

async function findRecentPendingDuplicate(client, userId, productId, targetGameId) {
    const { rows } = await client.query(
        `SELECT invoice_id
         FROM transactions
         WHERE user_id = $1
           AND product_id = $2
           AND target_game_id = $3
           AND status = 'Pending'
           AND created_at > NOW() - ($4::int * INTERVAL '1 second')
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, productId, targetGameId, DUPLICATE_ORDER_WINDOW_SECONDS]
    );
    return rows[0] || null;
}

// === KONFIGURASI FOXY API ===
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY;
const FOXY_CALLBACK_URL = process.env.FOXY_CALLBACK_URL || 'https://mikutopup.my.id/api/foxy/callback';
const PROVIDER_TIMEOUT_MS = 15000; // 15 detik untuk semua request ke provider

let foxyProductCache = null;
let foxyCacheTimestamp = null;
const FOXY_CACHE_TTL = 5 * 60 * 1000; // 5 menit

async function getFoxyProducts() {
    const now = Date.now();
    if (foxyProductCache && foxyCacheTimestamp && (now - foxyCacheTimestamp < FOXY_CACHE_TTL)) {
        return foxyProductCache;
    }

    const foxyConfig = {
        headers: {
            'Authorization': FOXY_API_KEY,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/108.0.0.0 Safari/537.36',
            'Referer': 'https://www.foxygamestore.com/'
        },
        timeout: PROVIDER_TIMEOUT_MS
    };

    try {
        const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, foxyConfig);
        foxyProductCache = response.data.data;
        foxyCacheTimestamp = now;
        return foxyProductCache;
    } catch (err) {
        // Safe log — tidak print headers atau Authorization
        const safeErr = safeAxiosError(err, 'Foxy');
        if (safeErr.isCloudflareChallenge) {
            console.warn('[getFoxyProducts] Blocked by Cloudflare challenge. VPS IP may need whitelisting.');
        } else {
            console.error('[getFoxyProducts] Failed to fetch products:', safeErr);
        }
        throw err;
    }
}

// Middleware (HARUS DI ATAS SEMUA RUTE)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' https:; img-src 'self' data: https:;");
    next();
});
app.use(cors({
    origin(origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error('Origin tidak diizinkan oleh CORS.'));
    }
}));
app.use(express.json({ limit: MAX_BODY_SIZE }));
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

app.get('/healthz', (req, res) => {
    res.json({ ok: true, service: 'topup-miku' });
});

const dbSslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';

const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT || 5432)
};

if (dbSslEnabled) {
    dbConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(dbConfig);

pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Jakarta'");
});

// Aturan ketat untuk endpoint login & lupa password
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 10, // Batasi setiap IP hanya 10 request per 15 menit
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

// Terapkan limiter ke endpoint yang relevan
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

app.use('/api/user', apiLimiter);
app.use('/api/order', checkoutLimiter);
app.use('/api/order', apiLimiter);
app.use('/h2h', h2hLimiter);
app.use('/h2h', apiLimiter); 
app.use('/api/full-validate', apiLimiter);
app.use('/api/products', apiLimiter);


// === AUTH ENDPOINTS ===
app.post('/api/auth/register', async (req, res) => {
    try {
        const fullName  = normalizeString(req.body.fullName, 255);
        const username  = normalizeString(req.body.username, 80);
        const email     = normalizeString(req.body.email, 255).toLowerCase();
        // Phase 2B: accept countryCode + nomorWa separately
        const countryCode  = normalizeString(req.body.countryCode || '+62', 5);
        const rawNomorWa   = normalizeString(req.body.nomorWa, 30);
        const { password } = req.body;

        // --- Basic presence checks ---
        if (!fullName)    return res.status(400).json({ message: 'Nama lengkap wajib diisi.' });
        if (!username)    return res.status(400).json({ message: 'Username wajib diisi.' });
        if (!email)       return res.status(400).json({ message: 'Email wajib diisi.' });
        if (!rawNomorWa)  return res.status(400).json({ message: 'Nomor WhatsApp wajib diisi.' });
        if (!password)    return res.status(400).json({ message: 'Password wajib diisi.' });

        // --- Field validation ---
        if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username))
            return res.status(400).json({ message: 'Username hanya boleh berisi huruf, angka, titik, strip, dan underscore (3-80 karakter).' });
        if (!isValidEmail(email))
            return res.status(400).json({ message: 'Format email tidak valid.' });
        if (!isValidPassword(password))
            return res.status(400).json({ message: 'Password minimal 8 karakter dan maksimal 128 karakter.' });

        // --- Phone normalization (Phase 2B) ---
        if (!/^\+[0-9]{1,3}$/.test(countryCode.trim()))
            return res.status(400).json({ message: 'Kode negara tidak valid. Contoh: +62' });
        const normalizedPhone = normalizePhone(countryCode, rawNomorWa);
        if (!normalizedPhone)
            return res.status(400).json({ message: 'Nomor WhatsApp tidak valid. Masukkan nomor lokal tanpa angka 0 di depan. Contoh: 81234567890' });

        // --- Pre-check duplicates (user-friendly, specific messages) ---
        const dupCheck = await pool.query(
            'SELECT username, email, nomor_wa FROM users WHERE username = $1 OR email = $2 OR (nomor_wa = $3 AND nomor_wa IS NOT NULL AND nomor_wa <> \'\')',
            [username, email, normalizedPhone]
        );
        for (const row of dupCheck.rows) {
            if (row.username === username)
                return res.status(409).json({ message: 'Username sudah digunakan. Silakan pilih username lain.' });
            if (row.email === email)
                return res.status(409).json({ message: 'Email sudah terdaftar. Silakan gunakan email lain atau login.' });
            if (row.nomor_wa === normalizedPhone)
                return res.status(409).json({ message: 'Nomor WhatsApp sudah terdaftar. Gunakan nomor lain atau hubungi admin.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
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
            if (detail.includes('username'))  return res.status(409).json({ message: 'Username sudah digunakan.' });
            if (detail.includes('email'))     return res.status(409).json({ message: 'Email sudah terdaftar.' });
            if (detail.includes('nomor_wa'))  return res.status(409).json({ message: 'Nomor WhatsApp sudah terdaftar.' });
            return res.status(409).json({ message: 'Data yang Anda masukkan sudah digunakan. Periksa kembali username, email, atau nomor WhatsApp.' });
        }
        logSafeError('Error during registration:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const username = normalizeString(req.body.username, 255);
        const { password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Input tidak boleh kosong.' });
        const sql = 'SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = $1 OR u.email = $2';
        const { rows } = await pool.query(sql, [username, username]);
        if (rows.length === 0) return res.status(401).json({ message: 'Username atau password salah.' });
        const user = rows[0];
        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) return res.status(401).json({ message: 'Username atau password salah.' });
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role_name }, JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ message: 'Login berhasil!', token });
    } catch (error) {
        logSafeError('Error during login:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const email = normalizeString(req.body.email, 255).toLowerCase();
    if (!email) {
        return res.status(400).json({ message: 'Alamat email wajib diisi.' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ message: 'Format email tidak valid.' });
    }

    const client = await pool.connect();
    try {
        // Cek apakah email terdaftar
        const { rows: users } = await client.query('SELECT * FROM users WHERE email = $1', [email]);
        if (users.length === 0) {
            // Kirim respons sukses palsu untuk keamanan, agar orang tidak bisa menebak email terdaftar
            return res.json({ message: 'Jika email Anda terdaftar, Anda akan menerima link reset password.' });
        }

        // Buat token reset yang aman
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashResetToken(token);
        const expires = new Date(Date.now() + 3600000); // Token berlaku selama 1 jam

        // Simpan token ke database
        await client.query(
            'INSERT INTO password_resets (email, token, expires_at) VALUES ($1, $2, $3)',
            [email, tokenHash, expires]
        );

        // Kirim email menggunakan fungsi dari mailer.js
        await sendPasswordResetEmail(email, token);

        res.json({ message: 'Jika email Anda terdaftar, Anda akan menerima link reset password.' });

    } catch (error) {
        logSafeError('Error saat proses lupa password:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    } finally {
        client.release();
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ message: 'Token dan password baru wajib diisi.' });
    }
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
        return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
    }
    if (!isValidPassword(newPassword)) {
        return res.status(400).json({ message: 'Password minimal 8 karakter dan maksimal 128 karakter.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Mulai transaksi untuk keamanan data
        const tokenHash = hashResetToken(token);

        // 1. Cari token di database dan pastikan belum kadaluarsa
        const { rows: resets } = await client.query(
            'SELECT * FROM password_resets WHERE token IN ($1, $2) AND expires_at > NOW()',
            [tokenHash, token]
        );

        if (resets.length === 0) {
            // Hapus token yang mungkin sudah kadaluarsa untuk kebersihan
            await client.query('DELETE FROM password_resets WHERE token IN ($1, $2)', [tokenHash, token]);
            await client.query('COMMIT'); // Simpan perubahan penghapusan
            return res.status(400).json({ message: 'Token tidak valid atau sudah kadaluarsa.' });
        }

        const userEmail = resets[0].email;

        // 2. Hash password baru
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // 3. Update password di tabel users
        await client.query(
            'UPDATE users SET password = $1 WHERE email = $2',
            [hashedPassword, userEmail]
        );

        // 4. Hapus semua token reset untuk email tersebut agar tidak bisa dipakai lagi
        await client.query('DELETE FROM password_resets WHERE email = $1', [userEmail]);

        await client.query('COMMIT'); // Selesaikan transaksi jika semua berhasil

        res.json({ message: 'Password berhasil direset! Silakan login dengan password baru Anda.' });

    } catch (error) {
        await client.query('ROLLBACK'); // Batalkan semua perubahan jika ada error di tengah jalan
        logSafeError('Error saat reset password:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    } finally {
        client.release();
    }
});

// === MIDDLEWARE ===
const protect = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Akses ditolak, tidak ada token.' });
    try {
        const token = authHeader.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET);
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
            req.user = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            req.user = null;
        }
    } else {
        req.user = null;
    }
    next();
};

const protectH2H = async (req, res, next) => {
    const apiKey = normalizeString(req.headers['x-api-key'], 128);
    if (!apiKey) {
        return res.status(401).json({ success: false, message: 'API Key tidak ditemukan di header X-API-Key.' });
    }
    if (!isValidApiKey(apiKey)) {
        return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
    }
    try {
        
        const sql = `
            SELECT u.id, u.username, u.balance, u.api_key, u.role_id, u.h2h_callback_url, r.name as role_name 
            FROM users u 
            JOIN roles r ON u.role_id = r.id 
            WHERE u.api_key = $1`;
        const { rows } = await pool.query(sql, [apiKey]);

        if (rows.length === 0) {
            return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
        }
        req.user = rows[0];
        next();
    } catch (error) {
        logSafeError('H2H Auth Error:', error);
        res.status(500).json({ success: false, message: 'Server error saat validasi API Key.' });
    }
};

const protectH2HIp = async (req, res, next) => {
    const requestIp = req.ip;
    
    if (requestIp === '::1' || requestIp === '127.0.0.1') {
        return next();
    }

    const apiKey = normalizeString(req.headers['x-api-key'], 128);
    if (!apiKey) {
        return next();
    }
    if (!isValidApiKey(apiKey)) {
        return next();
    }

    try {
        // --- LOGIKA BARU UNTUK MENDAPATKAN IP ASLI ---
        // req.ip sudah cukup pintar jika 'trust proxy' diaktifkan.
        // Kita tambahkan console.log untuk debugging.
        const requestIp = req.ip;
        console.log(`[IP Whitelist] Mengecek permintaan dari IP: ${requestIp}`);
        // --- AKHIR LOGIKA BARU ---

        const { rows } = await pool.query('SELECT whitelisted_ips FROM users WHERE api_key = $1', [apiKey]);

        if (rows.length > 0) {
            const user = rows[0];
            const allowedIps = user.whitelisted_ips || [];

            if (Array.isArray(allowedIps) && allowedIps.length > 0) {
                if (!allowedIps.includes(requestIp)) {
                    console.warn(`[IP Whitelist] Akses DITOLAK untuk IP: ${requestIp} (API Key: ...${apiKey.slice(-4)})`);
                    return res.status(403).json({ success: false, message: 'Alamat IP Anda tidak diizinkan.' });
                }
            }
        }
        next();
    } catch (error) {
        console.error('Error di middleware IP Whitelist:', error);
        res.status(500).json({ success: false, message: 'Server error saat validasi IP.' });
    }
};

async function createNotification(userId, message, link = null) {
    try {
        const sql = 'INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)';
        await pool.query(sql, [userId, message, link]);
        console.log(`Notifikasi dibuat untuk user ${userId}: "${message}"`);
    } catch (error) {
        console.error(`Gagal membuat notifikasi untuk user ${userId}:`, error);
    }
}



// === USER ENDPOINTS ===
app.get('/api/user/profile', protect, async (req, res) => {
    try {
        const sql = 'SELECT u.id, u.full_name, u.username, u.email, u.nomor_wa, u.balance, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1';
        const { rows } = await pool.query(sql, [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.put('/api/user/profile', protect, async (req, res) => {
    try {
        const { fullName, email, nomorWa } = req.body;
        if (!fullName || !email || !nomorWa) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const sql = 'UPDATE users SET full_name = $1, email = $2, nomor_wa = $3 WHERE id = $4';
        await pool.query(sql, [fullName, email, nomorWa, req.user.id]);
        res.json({ message: 'Profil berhasil diperbarui.' });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Email sudah digunakan oleh akun lain.' });
        console.error('Error updating user profile:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.put('/api/user/password', protect, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const sqlSelect = 'SELECT password FROM users WHERE id = $1';
        const { rows } = await pool.query(sqlSelect, [req.user.id]);
        const user = rows[0];
        const isPasswordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isPasswordMatch) return res.status(401).json({ message: 'Password saat ini salah.' });
        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        const sqlUpdate = 'UPDATE users SET password = $1 WHERE id = $2';
        await pool.query(sqlUpdate, [hashedNewPassword, req.user.id]);
        res.json({ message: 'Password berhasil diubah.' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/api/user/balance-history', protect, async (req, res) => {
    try {
        // PostgreSQL: Menggunakan created_at sebagai timestamp
        const sql = `SELECT amount, type, description, reference_id, created_at FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC`;
        const { rows } = await pool.query(sql, [req.user.id]);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching balance history:', error);
        res.status(500).json({ message: 'Server error saat mengambil riwayat saldo.' });
    }
});
app.post('/api/user/generate-apikey', protect, async (req, res) => {
    try {
        const newApiKey = crypto.randomBytes(24).toString('hex');
        await pool.query('UPDATE users SET api_key = $1 WHERE id = $2', [newApiKey, req.user.id]);
        res.json({ message: 'API Key baru berhasil dibuat! Harap simpan di tempat aman.', apiKey: newApiKey });
    } catch (error) {
        console.error('Error generating API key:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/api/user/apikey', protect, async (req, res) => {
    try {
        const sql = 'SELECT api_key FROM users WHERE id = $1';
        const { rows } = await pool.query(sql, [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
        res.json({ apiKey: rows[0].api_key });
    } catch (error) {
        console.error('Error fetching API key:', error);
        res.status(500).json({ message: 'Server error saat mengambil API key.' });
    }
});
app.get('/api/user/transactions', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const sql = `
            SELECT 
                t.invoice_id, 
                t.target_game_id,              t.price, 
                t.status, 
                t.created_at, 
                p.name as product_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            WHERE t.user_id = $1
            ORDER BY t.created_at DESC
        `;
        const { rows } = await pool.query(sql, [userId]);
        res.json(rows);
    } catch (error) {
        console.error("Gagal mengambil riwayat transaksi pengguna:", error);
        res.status(500).json({ message: 'Server error saat mengambil riwayat transaksi pengguna.' });
    }
});
app.get('/api/user/transaction/:invoiceId', protect, async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const userId = req.user.id;

        // Query ini menggabungkan 3 tabel untuk mendapatkan semua detail
        const sql = `
            SELECT
                t.invoice_id,
                t.status,
                t.created_at,
                t.price,
                t.target_game_id,
                t.provider_sn,
                p.name as product_name,
                g.category as game_category,
                g.name as game_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN games g ON p.game_id = g.id
            WHERE t.invoice_id = $1 AND t.user_id = $2
        `;
        const { rows } = await pool.query(sql, [invoiceId, userId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Transaksi tidak ditemukan atau bukan milik Anda.' });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error("Gagal mengambil detail transaksi:", error);
        res.status(500).json({ message: 'Server error saat mengambil detail transaksi.' });
    }
});
app.get('/api/user/transaction-summary', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const sql = `
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'Success' THEN 1 ELSE 0 END), 0) AS berhasil,
                COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END), 0) AS gagal,
                COALESCE(SUM(CASE WHEN status = 'Partial Refund' THEN 1 ELSE 0 END), 0) AS review
            FROM transactions 
            WHERE user_id = $1;
        `;
        const { rows } = await pool.query(sql, [userId]);
        res.json(rows[0]);
    } catch (error) {
        console.error("Gagal mengambil ringkasan transaksi:", error);
        res.status(500).json({ message: 'Server error saat mengambil ringkasan transaksi.' });
    }
});
// Endpoint untuk mengambil notifikasi pengguna
app.get('/api/user/notifications', protect, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', 
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil notifikasi.' });
    }
});

// Endpoint untuk menghitung notifikasi yang belum dibaca
app.get('/api/user/notifications/unread-count', protect, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false', 
            [req.user.id]
        );
        res.json({ count: parseInt(rows[0].count, 10) });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menghitung notifikasi.' });
    }
});

// Endpoint untuk menandai semua notifikasi sebagai sudah dibaca
app.post('/api/user/notifications/mark-as-read', protect, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
        res.status(200).json({ message: 'Semua notifikasi ditandai terbaca.' });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menandai notifikasi.' });
    }
});

// Endpoint untuk menambahkan IP yang di-whitelist
app.get('/api/user/whitelisted-ips', protect, async (req, res) => {
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
app.put('/api/user/whitelisted-ips', protect, async (req, res) => {
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

// === DEPOSIT ENDPOINTS ===
app.post('/api/deposit/request', protect, async (req, res) => {
    // Validasi amount dulu sebelum ambil koneksi DB
    const { amount } = req.body;
    const userId = req.user.id;
    if (!Number.isFinite(Number(amount)) || Number(amount) < 10000 || Number(amount) > 100000000) {
        return res.status(400).json({ message: 'Jumlah deposit tidak valid. Minimum Rp 10.000, maksimum Rp 100.000.000.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const uniqueCode = Math.floor(Math.random() * 900) + 100;
        const totalAmount = parseInt(amount) + uniqueCode;
        const sql = 'INSERT INTO deposits (user_id, amount, unique_code, status) VALUES ($1, $2, $3, $4) RETURNING id, created_at';
        const { rows } = await client.query(sql, [userId, totalAmount, uniqueCode, 'Pending']);
        const depositId = rows[0].id;
        const createdAt = rows[0].created_at;
        await client.query('COMMIT');
        const amountFormatted = new Intl.NumberFormat('id-ID').format(totalAmount);
        res.status(201).json({
            message: 'Permintaan deposit berhasil dibuat. Saldo akan masuk setelah admin memverifikasi pembayaran.',
            deposit: {
                id: depositId,
                amount: totalAmount,
                unique_code: uniqueCode,
                status: 'Pending',
                created_at: createdAt,
                paymentInstructions: `Transfer sejumlah <strong>Rp ${amountFormatted}</strong> (termasuk kode unik <strong>${uniqueCode}</strong>) ke metode pembayaran yang diinformasikan admin MIKU Store. Sertakan nomor deposit <strong>#${depositId}</strong> di keterangan transfer.`
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating deposit request:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server saat membuat permintaan deposit.' });
    } finally {
        client.release();
    }
});

// GET riwayat deposit user sendiri (max 20 terbaru)
app.get('/api/user/deposits', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const sql = `SELECT id, amount, unique_code, status, created_at
                     FROM deposits
                     WHERE user_id = $1
                     ORDER BY created_at DESC
                     LIMIT 20`;
        const { rows } = await pool.query(sql, [userId]);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching user deposits:', error);
        res.status(500).json({ message: 'Gagal mengambil riwayat deposit.' });
    }
});

// === ADMIN ENDPOINTS ===
app.get('/api/admin/deposits/pending', protectAdmin, async (req, res) => {
    try {
        const sql = `SELECT d.id, u.username, d.amount, d.created_at FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'Pending' ORDER BY d.created_at ASC`;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching pending deposits:', error);
        res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
    }
});
app.post('/api/admin/deposits/approve', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { depositId } = req.body;
        if (!depositId) throw new Error('Deposit ID tidak boleh kosong.');
        // PostgreSQL: FOR UPDATE kunci baris yang sedang diproses
        const { rows } = await client.query('SELECT * FROM deposits WHERE id = $1 AND status = \'Pending\' FOR UPDATE', [depositId]);
        if (rows.length === 0) throw new Error('Deposit tidak ditemukan atau sudah diproses.');
        const deposit = rows[0];
        await client.query('UPDATE deposits SET status = \'Success\' WHERE id = $1', [depositId]);
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [deposit.amount, deposit.user_id]);
        const historyDesc = `Deposit #${deposit.id} disetujui`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [deposit.user_id, deposit.amount, 'Deposit', historyDesc, `DEPOSIT-${deposit.id}`]);
        await client.query('COMMIT');
        await createNotification(deposit.user_id, `Deposit sebesar Rp ${deposit.amount.toLocaleString('id-ID')} telah disetujui dan masuk ke saldo.`);
        res.json({ message: `Deposit #${depositId} berhasil disetujui.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving deposit:', error);
        res.status(500).json({ message: 'Gagal menyetujui deposit.' });
    } finally {
        client.release();
    }
});
app.post('/api/admin/balance/add', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { username, amount, description } = req.body;
        if (!username || !amount || !description || isNaN(amount) || amount <= 0) throw new Error('Input tidak valid.');
        const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
        if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = rows[0];
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [parseInt(amount), user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [user.id, parseInt(amount), 'Deposit', description, `ADMIN_ADD-${Date.now()}`]);
        await client.query('COMMIT');
        res.json({ message: `Saldo sebesar ${amount} berhasil ditambahkan ke akun ${username}.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding balance manually:', error);
        res.status(500).json({ message: 'Gagal menambah saldo.' });
    } finally {
        client.release();
    }
});
app.post('/api/admin/balance/reduce', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { username, amount, description } = req.body;
        if (!username || !amount || !description || isNaN(amount) || amount <= 0) throw new Error('Input tidak valid.');
        const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
        if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = rows[0];
        if (user.balance < amount) throw new Error('Saldo pengguna tidak mencukupi untuk dikurangi.');
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [user.id, -amount, 'Refund', description, `ADMIN_REDUCE-${Date.now()}`]);
        await client.query('COMMIT');
        res.json({ message: `Saldo akun ${username} berhasil dikurangi sebesar ${amount}.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reducing balance manually:', error);
        res.status(500).json({ message: 'Gagal mengurangi saldo.' });
    } finally {
        client.release();
    }
});
app.get('/api/admin/roles', protectAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM roles ORDER BY id ASC');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching roles:', error);
        res.status(500).json({ message: 'Gagal mengambil data roles.' });
    }
});
app.put('/api/admin/roles', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const margins = req.body;
        if (!Array.isArray(margins)) throw new Error('Format data tidak valid.');
        if (margins.length > 0) {
            await client.query(`
                UPDATE roles AS r
                SET margin_percent = d.margin::numeric
                FROM jsonb_to_recordset($1::jsonb) AS d(id int, margin numeric)
                WHERE r.id = d.id
            `, [JSON.stringify(margins)]);
        }
        await client.query('COMMIT');
        res.json({ message: 'Margin berhasil diperbarui.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating roles margin:', error);
        res.status(500).json({ message: 'Gagal memperbarui margin.' });
    } finally {
        client.release();
    }
});
app.get('/api/admin/games', protectAdmin, async (req, res) => {
    try {
        const sql = "SELECT * FROM games ORDER BY name ASC";
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching admin games:', error);
        res.status(500).json({ message: 'Server error saat mengambil data game.' });
    }
});
app.get('/api/admin/products', protectAdmin, async (req, res) => {
    try {
         const sqlProducts = `SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, p.status, g.name as game_name 
                             FROM products p JOIN games g ON p.game_id = g.id 
                             ORDER BY g.name ASC, p.price ASC, p.name ASC`; 
        const { rows: products } = await pool.query(sqlProducts);

        // Ambil semua margin role
        const sqlRoles = `SELECT id, name, margin_percent FROM roles ORDER BY id ASC`;
        const { rows: roles } = await pool.query(sqlRoles);

        const roleMargins = {};
        roles.forEach(role => {
            roleMargins[role.id] = parseFloat(role.margin_percent);
        });

        const productsWithRolePrices = products.map(product => {
            const productWithPrices = { ...product };
            roles.forEach(role => {
                const margin = roleMargins[role.id] || 0;
                const sellingPrice = product.price * (1 + (margin / 100));
                productWithPrices[`price_${role.name.toLowerCase()}`] = Math.ceil(sellingPrice);
            });
            return productWithPrices;
        });

        res.json(productsWithRolePrices);
    } catch (error) {
        console.error('Error fetching admin products with role prices:', error);
        res.status(500).json({ message: 'Server error saat mengambil data produk dengan harga role.' });
    }
});
app.post('/api/admin/games', protectAdmin, async (req, res) => {
    try {
        const { name, category, imageUrl } = req.body;
        if (!name || !category || !imageUrl) return res.status(400).json({ message: 'Semua kolom wajib diisi.' });
        const sql = 'INSERT INTO games (name, category, image_url, status, needs_server_id) VALUES ($1, $2, $3, $4, $5)'; // Tambah status & needs_server_id
        await pool.query(sql, [name, category, imageUrl, 'Active', false]); // Default nilai
        res.status(201).json({ message: `Game ${name} berhasil ditambahkan.` });
    } catch (error) {
        console.error('Error adding game:', error);
        if (error.code === '23505') return res.status(409).json({ message: 'Game dengan nama ini sudah ada.' });
        res.status(500).json({ message: 'Server error saat menambah game.' });
    }
});
app.post('/api/admin/products', protectAdmin, async (req, res) => {
    try {
        const { game_id, name, provider_sku, price, category_id } = req.body;
        if (!game_id || !name || !provider_sku || !price || !category_id) return res.status(400).json({ message: 'Semua kolom wajib diisi.' });
        // PostgreSQL: Menggunakan ON CONFLICT DO UPDATE
        const sql = 'INSERT INTO products (game_id, category_id, name, provider_sku, price, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_sku) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, game_id = EXCLUDED.game_id, category_id = EXCLUDED.category_id, status = EXCLUDED.status';
        await pool.query(sql, [game_id, category_id, name, provider_sku, price, 'Active']); // Default status
        res.status(201).json({ message: `Produk ${name} berhasil ditambahkan.` });
    } catch (error) {
        console.error('Error adding product:', error);
        if (error.code === '23505') return res.status(409).json({ message: 'SKU Provider sudah ada.' });
        res.status(500).json({ message: 'Server error saat menambah produk.' });
    }
});
app.post('/api/admin/sync-products', protectAdmin, async (req, res) => {
    try {
        const { margin_percent } = req.body; // Menerima margin dari frontend
        if (margin_percent === undefined || isNaN(margin_percent)) {
            return res.status(400).json({ message: 'Persentase margin tidak valid.' });
        }
        
        // Panggil fungsi sinkronisasi dari utilitas, teruskan margin
        // Catatan: Fungsi syncProductsWithFoxy di utilitas perlu menerima margin_percent
        await syncProductsWithFoxy(margin_percent); 
        
        res.json({ message: `Sinkronisasi produk berhasil dipicu dengan margin ${margin_percent}%.` });
    } catch (error) {
        console.error('Manual sync trigger error:', error);
        res.status(500).json({ message: 'Gagal memicu sinkronisasi manual. Cek log server.' });
    }
});
app.get('/api/admin/transactions', protectAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT t.invoice_id, t.user_id, t.target_game_id, t.price, t.status, t.created_at, p.name as product_name, u.username as user_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
        `;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error("Gagal mengambil riwayat transaksi admin:", error);
        res.status(500).json({ message: 'Server error saat mengambil riwayat transaksi.' });
    }
});

// Admin manual resolve: mark berhasil, refund/gagalkan, atau keep_review
app.put('/api/admin/transactions/:invoiceId/resolve', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const invoiceId = normalizeString(req.params.invoiceId, 100);
        const action = normalizeString(req.body.action || '', 20);

        if (!['success', 'refund', 'keep_review'].includes(action)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Aksi tidak valid. Gunakan: success, refund, keep_review.' });
        }

        // Lock baris untuk hindari race condition
        const { rows } = await client.query(
            'SELECT * FROM transactions WHERE invoice_id = $1 FOR UPDATE',
            [invoiceId]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
        }
        const tx = rows[0];

        // Hanya boleh resolve dari status non-final
        if (!['Pending', 'Partial Refund'].includes(tx.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                message: `Transaksi sudah berstatus "${tx.status}". Tidak bisa diubah lagi.`
            });
        }

        // action success/refund hanya boleh dari Partial Refund (bukan dari Pending biasa)
        if ((action === 'success' || action === 'refund') && tx.status !== 'Partial Refund') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                message: `Aksi "${action}" hanya diizinkan untuk transaksi berstatus "Partial Refund". Status saat ini: "${tx.status}".`
            });
        }

        if (action === 'success') {
            await client.query(
                "UPDATE transactions SET status = 'Success', updated_at = NOW() WHERE id = $1",
                [tx.id]
            );
            await createNotification(
                tx.user_id,
                `Pesanan ${tx.invoice_id} telah dikonfirmasi berhasil oleh admin.`,
                `/invoice.html?id=${tx.invoice_id}`
            );
            await client.query('COMMIT');
            return res.json({ message: `Transaksi ${invoiceId} berhasil ditandai Berhasil.` });


        } else if (action === 'refund') {
            // DOUBLE REFUND GUARD: cek apakah sudah pernah ada refund
            const { rows: existingRefunds } = await client.query(
                "SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund' LIMIT 1",
                [tx.invoice_id]
            );
            if (existingRefunds.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'Saldo untuk transaksi ini sudah pernah direfund sebelumnya.' });
            }

            await client.query(
                "UPDATE transactions SET status = 'Failed', updated_at = NOW() WHERE id = $1",
                [tx.id]
            );
            await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                [tx.price, tx.user_id]
            );
            const histDesc = `Refund admin untuk invoice ${tx.invoice_id}`;
            await client.query(
                "INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, 'Refund', $3, $4)",
                [tx.user_id, tx.price, histDesc, tx.invoice_id]
            );
            await createNotification(
                tx.user_id,
                `Pesanan ${tx.invoice_id} gagal. Saldo Rp ${Number(tx.price).toLocaleString('id-ID')} telah dikembalikan.`,
                `/invoice.html?id=${tx.invoice_id}`
            );
            await client.query('COMMIT');
            return res.json({ message: `Transaksi ${invoiceId} berhasil di-refund dan ditandai Gagal.` });

        } else if (action === 'keep_review') {
            // Jika masih Pending, jadikan Partial Refund; jika sudah Partial Refund, no-op (update updated_at)
            if (tx.status === 'Pending') {
                await client.query(
                    "UPDATE transactions SET status = 'Partial Refund', updated_at = NOW() WHERE id = $1",
                    [tx.id]
                );
            } else {
                // Sudah Partial Refund — update updated_at saja sebagai tanda admin sudah lihat
                await client.query(
                    'UPDATE transactions SET updated_at = NOW() WHERE id = $1',
                    [tx.id]
                );
            }
            await client.query('COMMIT');
            return res.json({ message: `Transaksi ${invoiceId} tetap dalam status Review Admin.` });
        }

        // Seharusnya tidak sampai sini
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Aksi tidak valid.' });

    } catch (error) {
        await client.query('ROLLBACK');
        logSafeError('Admin resolve error:', error);
        res.status(500).json({ message: 'Gagal memproses aksi admin.' });
    } finally {
        client.release();
    }
});
app.put('/api/admin/products/:id/status', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params; // Ambil ID produk dari URL
        const { status } = req.body; // Ambil status baru dari body request ('Active' atau 'Inactive')

        if (!status || (status !== 'Active' && status !== 'Inactive')) {
            return res.status(400).json({ message: "Status tidak valid. Gunakan 'Active' atau 'Inactive'." });
        }

        const { rowCount } = await pool.query(
            'UPDATE products SET status = $1 WHERE id = $2',
            [status, id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ message: 'Produk tidak ditemukan.' });
        }

        res.json({ message: `Status produk berhasil diubah menjadi ${status}.` });

    } catch (error) {
        console.error('Error updating product status:', error);
        res.status(500).json({ message: 'Gagal memperbarui status produk.' });
    }
});
app.put('/api/admin/games/:id/status', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!status || (status !== 'Active' && status !== 'Inactive')) {
            return res.status(400).json({ message: "Status tidak valid. Gunakan 'Active' atau 'Inactive'." });
        }

        const { rowCount } = await pool.query(
            'UPDATE games SET status = $1 WHERE id = $2',
            [status, id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ message: 'Game tidak ditemukan.' });
        }

        res.json({ message: `Status game berhasil diubah menjadi ${status}.` });

    } catch (error) {
        console.error('Error updating game status:', error);
        res.status(500).json({ message: 'Gagal memperbarui status game.' });
    }
});
app.put('/api/admin/games/:id/needs-server', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { needsServer } = req.body; // Menerima nilai boolean (true/false)

        if (typeof needsServer !== 'boolean') {
            return res.status(400).json({ message: "Nilai 'needsServer' harus boolean." });
        }

        const { rowCount } = await pool.query(
            'UPDATE games SET needs_server_id = $1 WHERE id = $2',
            [needsServer, id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ message: 'Game tidak ditemukan.' });
        }

        res.json({ message: `Pengaturan 'Perlu Server' untuk game berhasil diubah.` });

    } catch (error) {
        console.error('Error updating game needs_server_id:', error);
        res.status(500).json({ message: 'Gagal memperbarui pengaturan game.' });
    }
});
app.put('/api/admin/products/:id/validation', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { validation_config } = req.body;
        const { rowCount } = await pool.query('UPDATE products SET validation_config = $1 WHERE id = $2', [validation_config, id]);
        if (rowCount === 0) return res.status(404).json({ message: 'Produk tidak ditemukan.' });
        res.json({ message: 'Pengaturan validasi produk berhasil diperbarui.' });
    } catch (error) {
        console.error('Error updating product validation:', error);
        res.status(500).json({ message: 'Gagal memperbarui pengaturan validasi.' });
    }
});
app.put('/api/admin/products/bulk-validation', protectAdmin, async (req, res) => {
    try {
        const { productIds, validation_config } = req.body;

        if (!Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ message: 'productIds harus berupa array dan tidak boleh kosong.' });
        }

        // Menggunakan query builder dari 'pg' untuk menangani array
        const { rowCount } = await pool.query(
            'UPDATE products SET validation_config = $1 WHERE id = ANY($2::int[])',
            [validation_config, productIds]
        );

        res.json({ message: `Pengaturan validasi berhasil diperbarui untuk ${rowCount} produk.` });
    } catch (error) {
        console.error('Error updating bulk product validation:', error);
        res.status(500).json({ message: 'Gagal memperbarui pengaturan validasi massal.' });
    }
});
app.post('/api/admin/promos', protectAdmin, async (req, res) => {
    const { code, description, type, value, expires_at, rules, max_uses } = req.body;
    try {
        const sql = `INSERT INTO promo_codes (code, description, type, value, expires_at, rules, max_uses) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
        const { rows } = await pool.query(sql, [code.toUpperCase(), description, type, value, expires_at, rules, max_uses]);
        res.status(201).json(rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Kode promo sudah ada.' });
        console.error("Gagal membuat kode promo:", error);
        res.status(500).json({ message: 'Gagal membuat kode promo.' });
    }
});

// Endpoint untuk melihat semua kode promo
app.get('/api/admin/promos', protectAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil data promo.' });
    }
});

// Endpoint untuk menonaktifkan/mengaktifkan promo
app.put('/api/admin/promos/:id/toggle', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        const sql = 'UPDATE promo_codes SET is_active = $1 WHERE id = $2 RETURNING *';
        const { rows } = await pool.query(sql, [is_active, id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Kode promo tidak ditemukan.' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengubah status promo.' });
    }
});

// Endpoint untuk melihat semua item flash sale di admin panel
app.get('/api/admin/flash-sales', protectAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT 
                fs.*,
                p.name as product_name,
                g.name as game_name
            FROM flash_sales fs
            JOIN products p ON fs.product_id = p.id
            JOIN games g ON p.game_id = g.id
            ORDER BY fs.created_at DESC;
        `;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil data flash sale.' });
    }
});
// Endpoint untuk menambah produk ke flash sale
app.post('/api/admin/flash-sales', protectAdmin, async (req, res) => {
    const { product_id, discount_price, start_at, end_at, max_uses, max_discount_amount } = req.body;
    const rules = max_discount_amount ? { max_discount_amount: parseFloat(max_discount_amount) } : null;

    try {
        // PERBAIKAN: Menambahkan kolom 'is_active' dan memberinya nilai 'true'
        const sql = `
            INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, rules, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *;
        `;
        
        const { rows } = await pool.query(sql, [product_id, discount_price, start_at, end_at, max_uses, rules]);
        res.status(201).json(rows[0]);

    } catch (error) {
        // Menambahkan log error agar lebih mudah dilacak jika ada masalah lain
        console.error("Error saat menambah flash sale:", error); 
        res.status(500).json({ message: 'Gagal menambah item flash sale.' });
    }
});
// Endpoint untuk menghapus item dari flash sale
app.delete('/api/admin/flash-sales/:id', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM flash_sales WHERE id = $1', [id]);
        res.status(200).json({ message: 'Item flash sale berhasil dihapus.' });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menghapus item flash sale.' });
    }
});

// Mengambil pengaturan margin khusus untuk sebuah game
app.get('/api/admin/games/:gameId/margins', protectAdmin, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { rows } = await pool.query('SELECT * FROM game_margins WHERE game_id = $1', [gameId]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            // Jika belum ada pengaturan, kirim data default
            res.json({ use_custom_margin: false });
        }
    } catch (error) {
        console.error('Error fetching game margins:', error);
        res.status(500).json({ message: 'Gagal mengambil data margin game.' });
    }
});

// Menyimpan atau memperbarui pengaturan margin khusus untuk sebuah game
app.post('/api/admin/games/:gameId/margins', protectAdmin, async (req, res) => {
    try {
        const { gameId } = req.params;
        const { use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin } = req.body;

        // Query UPSERT: Insert jika belum ada, Update jika sudah ada
        const sql = `
            INSERT INTO game_margins (game_id, use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (game_id)
            DO UPDATE SET
                use_custom_margin = EXCLUDED.use_custom_margin,
                bronze_margin = EXCLUDED.bronze_margin,
                silver_margin = EXCLUDED.silver_margin,
                gold_margin = EXCLUDED.gold_margin,
                partner_margin = EXCLUDED.partner_margin,
                updated_at = NOW()
        `;
        
        await pool.query(sql, [gameId, use_custom_margin, bronze_margin, silver_margin, gold_margin, partner_margin]);
        res.json({ message: 'Pengaturan margin untuk game ini berhasil disimpan.' });

    } catch (error) {
        console.error('Error saving game margins:', error);
        res.status(500).json({ message: 'Gagal menyimpan data margin game.' });
    }
});

// Mengambil pengaturan harga manual untuk sebuah produk
app.get('/api/admin/products/:productId/manual-prices', protectAdmin, async (req, res) => {
    try {
        const { productId } = req.params;
        const { rows } = await pool.query(
            'SELECT use_manual_prices, manual_prices FROM products WHERE id = $1',
            [productId]
        );
        if (rows.length > 0) {
            res.json({
                use_manual_prices: rows[0].use_manual_prices || false,
                manual_prices: rows[0].manual_prices || {}
            });
        } else {
            res.status(404).json({ message: 'Produk tidak ditemukan.' });
        }
    } catch (error) {
        console.error('Error fetching manual prices:', error);
        res.status(500).json({ message: 'Gagal mengambil data harga manual.' });
    }
});

// Menyimpan atau memperbarui pengaturan harga manual untuk sebuah produk
app.post('/api/admin/products/:productId/manual-prices', protectAdmin, async (req, res) => {
    try {
        const { productId } = req.params;
        const { use_manual_prices, manual_prices } = req.body;

        const sql = `
            UPDATE products 
            SET use_manual_prices = $1, manual_prices = $2
            WHERE id = $3
        `;
        
        await pool.query(sql, [use_manual_prices, manual_prices, productId]);
        res.json({ message: 'Pengaturan harga manual berhasil disimpan.' });

    } catch (error) {
        console.error('Error saving manual prices:', error);
        res.status(500).json({ message: 'Gagal menyimpan data harga manual.' });
    }
});

// === PUBLIC ENDPOINTS ===

app.post('/api/test', (req, res) => {
    console.log('SUKSES: Rute /api/test diakses dengan metode POST.');
    res.status(200).json({ message: 'Halo! Rute tes POST ini berfungsi!' });
});


app.get('/api/games', async (req, res) => {
    try {
        const sql = "SELECT * FROM games WHERE status = 'Active' ORDER BY name ASC";
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching public games:', error);
        res.status(500).json({ message: 'Server error saat mengambil data game.' });
    }
});

app.get('/api/games/validatable', async (req, res) => {
    try {
        // PERBAIKAN FINAL: Membuat path absolut yang pasti benar
        const filePath = path.resolve(__dirname, 'utils', 'validators', 'data_cekid.json');
        const cekIdDataBuffer = await fs.readFile(filePath);
        const cekIdGames = JSON.parse(cekIdDataBuffer.toString());

        const finalResult = cekIdGames.filter(game => game.name).map((game, index) => ({
            id: game.name,
            name: game.name,
            gameCode: game.game,
            hasZoneIdForValidation: game.hasZoneId
        }));

        res.json(finalResult);
    } catch (error) {
        console.error("Error fetching validatable games from JSON:", error);
        res.status(500).json({ message: 'Server error saat mengambil data game dari file.' });
    }
});

// Endpoint baru untuk validasi di halaman produk
app.post('/api/products/:productId/validate', async (req, res) => {
    const { productId } = req.params;
    const { userId, zoneId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID wajib diisi.' });
    try {
        const { rows } = await pool.query('SELECT validation_config FROM products WHERE id = $1', [productId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
        const config = rows[0].validation_config;
        if (!config || !config.validator) return res.json({ success: true, message: 'Produk ini tidak memerlukan validasi.' });
        const result = await validateGameId(config.validator, userId, zoneId, config.rules || {});
        if (result.success) res.json(result);
        else res.status(400).json({ success: false, message: result.message });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});

// Endpoint baru untuk halaman validasi (yang menampilkan promo)
app.post('/api/full-validate', async (req, res) => {
    const { gameCode, userId, zoneId, rules } = req.body;

    if (!gameCode || !userId) {
        return res.status(400).json({ success: false, message: 'Parameter tidak lengkap.' });
    }

    try {
        let result;

        // --- INI ADALAH LOGIKA YANG SEHARUSNYA ---
        if (gameCode.includes('magic-chess-go-go')) {
            // Logika khusus untuk Magic Chess
            const mcggResult = await cekPromoMcggMobapay(userId, zoneId);
            if (mcggResult.success) {
                result = { 
                    success: true, 
                    data: { 
                        username: mcggResult.nickname, 
                        promo: { doubleDiamond: { items: mcggResult.promoProducts } } 
                    } 
                };
            } else {
                result = mcggResult; // Kembalikan hasil errornya
            }

        } else {
            // Logika untuk semua game lain (termasuk Mobile Legends)
            const pgsResult = await validateGameId(gameCode, userId, zoneId, rules || {});
            if (!pgsResult.success) {
                return res.status(400).json({ success: false, message: pgsResult.message });
            }
            
            result = pgsResult;

            // Jika ini ML, tambahkan data promo
            if (gameCode.includes('mobile-legends-region')) {
                const mobapayResult = await checkAllMobapayPromosML(userId, zoneId);
                result.data.promo = mobapayResult.data;
            }
        }
        // --- AKHIR DARI LOGIKA YANG SEHARUSNYA ---

        res.json(result);

    } catch (error) {
        console.error(`Error validasi lengkap untuk ${gameCode}:`, error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan internal.' });
    }
});

app.get('/api/games/:gameId/products', softProtect, async (req, res) => {
    try {
        const { gameId } = req.params;
        let userRoleId = 1;
        let userRoleName = 'bronze';

        if (req.user) {
            const { rows: userRows } = await pool.query('SELECT role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1', [req.user.id]);
            if (userRows.length > 0) {
                userRoleId = userRows[0].role_id;
                userRoleName = userRows[0].role_name.toLowerCase();
            }
        }

        const { rows: games } = await pool.query("SELECT name, image_url, needs_server_id, target_id_label FROM games WHERE id = $1 AND status = 'Active'", [gameId]);
        if (games.length === 0) return res.status(404).json({ message: 'Game tidak ditemukan.' });
        
        // server.js - PERBAIKAN SEKITAR BARIS 1272

        const { rows: products } = await pool.query(`
            SELECT p.id, p.name, p.provider_sku, p.price as base_price, 
                   p.use_manual_prices, p.manual_prices,
                   gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
            FROM products p
            LEFT JOIN game_margins gm ON p.game_id = gm.game_id
            WHERE p.game_id = $1 AND p.status = 'Active'
            ORDER BY p.price ASC
        `, [gameId]);
        
        // --- AWAL PERBAIKAN ---
        // 1. Ambil semua item flash sale yang sedang aktif
        const { rows: activeFlashSales } = await pool.query(`
            SELECT product_id, discount_price FROM flash_sales
            WHERE is_active = true AND NOW() BETWEEN start_at AND end_at
        `);
        // 2. Buat Peta (Map) untuk pencarian cepat berdasarkan ID produk
        const flashSaleMap = new Map(activeFlashSales.map(fs => [fs.product_id, fs.discount_price]));
        // --- AKHIR PERBAIKAN ---
        
        const { rows: globalMargins } = await pool.query('SELECT name, margin_percent FROM roles');
        const globalMarginsMap = globalMargins.reduce((acc, role) => {
            acc[role.name.toLowerCase()] = role.margin_percent;
            return acc;
        }, {});

        const finalProducts = products.map(p => {
            let finalPrice;
            let originalPrice = null;
            let isFlashSale = false;

            // --- PERUBAHAN LOGIKA UTAMA ---
            // PRIORITAS 0: FLASH SALE
            if (flashSaleMap.has(p.id)) {
                isFlashSale = true;
                finalPrice = flashSaleMap.get(p.id); // Harga langsung dari flash sale
                
                // Hitung harga asli sebelum diskon untuk ditampilkan (dicoret)
                const margin = globalMarginsMap[userRoleName] || 0; 
                originalPrice = Math.ceil(p.base_price * (1 + margin / 100));

            } else {
                const manualPrice = p.manual_prices ? p.manual_prices[userRoleName] : null;
                // PRIORITAS 1: HARGA MANUAL
                if (p.use_manual_prices && manualPrice) {
                    finalPrice = manualPrice;
                } else {
                    let margin = globalMarginsMap[userRoleName] || 0; // Default: margin global
                    // PRIORITAS 2: MARGIN PER GAME
                    if (p.use_custom_margin) {
                        const customMargin = p[`${userRoleName}_margin`];
                        if (customMargin !== null && customMargin !== undefined) {
                            margin = customMargin;
                        }
                    }
                    finalPrice = Math.ceil(p.base_price * (1 + margin / 100));
                }
            }
            
            return { 
                id: p.id, 
                name: p.name, 
                provider_sku: p.provider_sku, 
                price: finalPrice,
                // Kirim data tambahan ini ke frontend
                isFlashSale: isFlashSale,
                originalPrice: originalPrice 
            };
        });

        res.json({ game: games[0], products: finalProducts });
    } catch (error) {
        console.error("Gagal mengambil produk game (public):", error);
        res.status(500).json({ message: 'Server error saat mengambil data produk.' });
    }
});

app.get('/api/games/:gameId/servers', async (req, res) => {
    try {
        const { gameId } = req.params;
        const sql = "SELECT server_name FROM game_servers WHERE game_id = $1 ORDER BY server_name ASC";
        const { rows } = await pool.query(sql, [gameId]);
        // Kirim array nama server, e.g., ["America", "Asia", "Europe"]
        res.json(rows.map(row => row.server_name));
    } catch (error) {
        console.error('Error fetching game servers:', error);
        res.status(500).json({ message: 'Server error saat mengambil data server game.' });
    }
});

app.get('/api/public/compare-prices', async (req, res) => {
    try {
        const { rows: products } = await pool.query(`
            SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, g.name as game_name, 
                   p.use_manual_prices, p.manual_prices,
                   gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
            FROM products p 
            JOIN games g ON p.game_id = g.id
            LEFT JOIN game_margins gm ON p.game_id = gm.game_id
            WHERE p.status = 'Active' ORDER BY g.name ASC, p.price ASC
        `);
        const { rows: roles } = await pool.query(`SELECT name, margin_percent FROM roles ORDER BY id ASC`);
        const { rows: games } = await pool.query("SELECT id, name FROM games WHERE status = 'Active' ORDER BY name ASC");
        const { rows: activeFlashSales } = await pool.query(
            `SELECT product_id, discount_price FROM flash_sales WHERE is_active = true AND NOW() BETWEEN start_at AND end_at`
        );
        const flashSaleMap = new Map(activeFlashSales.map(fs => [fs.product_id, Number(fs.discount_price)]));

        const productsWithRolePrices = products.map(product => {
            const productWithPrices = { 
                id: product.id, game_name: product.game_name, product_name: product.name, 
                provider_sku: product.provider_sku, base_price: product.price 
            }; 
            
            roles.forEach(role => {
                const roleNameLower = role.name.toLowerCase();
                let finalPrice;
                const manualPrice = product.manual_prices ? product.manual_prices[roleNameLower] : null;

                if (product.use_manual_prices && manualPrice) {
                    finalPrice = manualPrice;
                } else {
                    let finalMargin = role.margin_percent;
                    if (product.use_custom_margin) {
                        finalMargin = product[`${roleNameLower}_margin`] || role.margin_percent;
                    }
                    finalPrice = Math.ceil(product.price * (1 + (finalMargin / 100)));
                }
                // Apply flash sale if active and lower than computed price
                if (flashSaleMap.has(product.id)) {
                    const flashPrice = flashSaleMap.get(product.id);
                    if (flashPrice > 0 && flashPrice < finalPrice) {
                        finalPrice = flashPrice;
                    }
                }
                productWithPrices[`price_${roleNameLower}`] = finalPrice;
            });
            return productWithPrices;
        });

        res.json({ products: productsWithRolePrices, roles: roles, games: games });
    } catch (error) {
        console.error('Error fetching public compare prices:', error);
        res.status(500).json({ message: 'Server error saat mengambil data perbandingan harga.' });
    }
});

app.post('/api/promos/validate', protect, async (req, res) => {
    const { promo_code, product_id, target_game_id } = req.body;
    const client_user_id = req.user.id;

    if (!promo_code || !product_id || !target_game_id) {
        return res.status(400).json({ valid: false, message: 'Informasi promo, produk, dan ID game dibutuhkan.' });
    }

    const client = await pool.connect();
    try {
        const promoRes = await client.query('SELECT * FROM promo_codes WHERE code = $1 AND is_active = true', [promo_code.toUpperCase()]);
        if (promoRes.rows.length === 0) {
            return res.status(404).json({ valid: false, message: 'Kode promo tidak ditemukan atau tidak aktif.' });
        }
        const promo = promoRes.rows[0];
        const rules = promo.rules || {};

        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
            return res.status(400).json({ valid: false, message: 'Kode promo sudah kedaluwarsa.' });
        }
        if (promo.max_uses && promo.uses_count >= promo.max_uses) {
            return res.status(400).json({ valid: false, message: 'Kuota penggunaan promo ini sudah habis.' });
        }

        if (rules.max_uses_per_user) {
            const usageRes = await client.query(
                'SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND customer_game_id = $2',
                [promo.id, target_game_id]
            );
            const userUsageCount = parseInt(usageRes.rows[0].count, 10);
            if (userUsageCount >= rules.max_uses_per_user) {
                return res.status(400).json({ valid: false, message: `Anda sudah mencapai batas maksimal penggunaan kode ini (${rules.max_uses_per_user}x).` });
            }
        }
        
        // Ambil produk lengkap dengan game_margins untuk hitung harga efektif
        const productRes = await client.query(`
            SELECT p.*, g.id as game_id,
                   p.use_manual_prices, p.manual_prices,
                   gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
            FROM products p
            JOIN games g ON p.game_id = g.id
            LEFT JOIN game_margins gm ON p.game_id = gm.game_id
            WHERE p.id = $1 AND p.status = 'Active' AND g.status = 'Active'
        `, [product_id]);
        if (productRes.rows.length === 0) {
            return res.status(404).json({ valid: false, message: 'Produk tidak ditemukan.' });
        }
        const product = productRes.rows[0];

        // --- Hitung harga efektif backend (manual > custom margin > global margin > flash sale) ---
        const { rows: userRows } = await client.query(
            'SELECT role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1',
            [client_user_id]
        );
        const userRoleName = (userRows.length > 0 ? userRows[0].role_name : 'bronze').toLowerCase();
        const userRoleId = userRows.length > 0 ? userRows[0].role_id : 1;

        let effectivePrice;
        const manualPrice = product.manual_prices ? product.manual_prices[userRoleName] : null;
        if (product.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
            effectivePrice = Number(manualPrice);
        } else {
            const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [userRoleId]);
            let margin = roleRows.length > 0 ? Number(roleRows[0].margin_percent) : 0;
            if (product.use_custom_margin) {
                const customMargin = product[`${userRoleName}_margin`];
                if (customMargin !== null && customMargin !== undefined) {
                    margin = Number(customMargin);
                }
            }
            effectivePrice = Math.ceil(Number(product.price) * (1 + (margin / 100)));
        }

        // Flash sale override
        const { rows: fsRows } = await client.query(
            `SELECT discount_price FROM flash_sales WHERE product_id = $1 AND is_active = true AND NOW() BETWEEN start_at AND end_at LIMIT 1`,
            [product_id]
        );
        if (fsRows.length > 0) {
            const flashPrice = Number(fsRows[0].discount_price);
            if (flashPrice > 0 && flashPrice < effectivePrice) {
                effectivePrice = flashPrice;
            }
        }
        // --- Akhir hitung harga efektif ---

        if (rules.min_price && effectivePrice < rules.min_price) {
            return res.status(400).json({ valid: false, message: `Promo ini hanya berlaku untuk pembelian minimal Rp ${rules.min_price}.` });
        }
        if (rules.allowed_game_ids && !rules.allowed_game_ids.includes(product.game_id)) {
            return res.status(400).json({ valid: false, message: 'Promo ini tidak berlaku untuk game ini.' });
        }
        if (rules.allowed_product_ids && !rules.allowed_product_ids.includes(product.id)) {
            return res.status(400).json({ valid: false, message: 'Promo ini tidak berlaku untuk produk ini.' });
        }

        let discount = 0;
        if (promo.type === 'percentage') {
            discount = Math.floor(effectivePrice * Number(promo.value) / 100);
        } else if (promo.type === 'fixed') {
            discount = Math.floor(Number(promo.value));
        }
        // Cap discount so final price is at least 1
        if (discount >= effectivePrice) {
            discount = effectivePrice - 1;
        }
        if (discount < 0) discount = 0;
        const finalPrice = effectivePrice - discount;

        res.json({
            valid: true,
            message: 'Kode promo berhasil digunakan!',
            promo_code: promo.code,
            discount: discount,
            original_price: effectivePrice,
            final_price: finalPrice
        });

    } catch (error) {
        console.error('Error saat validasi promo:', error);
        res.status(500).json({ valid: false, message: 'Terjadi kesalahan di server.' });
    } finally {
        client.release();
    }
});


// Endpoint untuk mengambil produk flash sale yang aktif
app.get('/api/public/flash-sales', async (req, res) => {
    try {
        const sql = `
                SELECT 
                    fs.id as flash_sale_id,
                    fs.discount_price,
                    p.id as product_id,
                    p.name as product_name,
                    CEIL(p.price * (1 + COALESCE(r.margin_percent, 0) / 100)) as original_price,
                    g.id as game_id,
                    g.name as game_name,
                    g.image_url as game_image_url
                FROM flash_sales fs
                JOIN products p ON fs.product_id = p.id
                JOIN games g ON p.game_id = g.id
                LEFT JOIN roles r ON r.id = 1 
                WHERE 
                    fs.is_active = true AND
                    NOW() BETWEEN fs.start_at AND fs.end_at AND
                    (fs.max_uses IS NULL OR fs.uses_count < fs.max_uses)
                ORDER BY fs.end_at ASC;
            `;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching flash sales:", error);
        res.status(500).json({ message: 'Gagal mengambil data flash sale.' });
    }
});
// ambil pl dari role bronze di web untuk bot tele
app.get('/api/public/bot-products/:gameName', async (req, res) => {
    try {
        const { gameName } = req.params;

        // 1. Dapatkan margin untuk role 'BRONZE' (INI YANG DIUBAH)
        const { rows: roleRows } = await pool.query("SELECT margin_percent FROM roles WHERE name = 'BRONZE'");
        if (roleRows.length === 0) {
            throw new Error("Role 'BRONZE' tidak ditemukan untuk perhitungan harga.");
        }
        const publicMargin = roleRows[0].margin_percent;

        // 2. Cari game berdasarkan nama
        const { rows: gameRows } = await pool.query("SELECT id FROM games WHERE name ILIKE $1 AND status = 'Active'", [`%${gameName}%`]);
        if (gameRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Game tidak ditemukan.' });
        }
        const gameId = gameRows[0].id;

        // 3. Ambil semua produk untuk game tersebut
        const { rows: products } = await pool.query("SELECT name, price FROM products WHERE game_id = $1 AND status = 'Active' ORDER BY price ASC", [gameId]);

        // 4. Hitung harga jual akhir untuk setiap produk (LOGIKA DISINI JUGA BERUBAH)
        const finalProducts = products.map(p => {
            // Langsung hitung harga jual berdasarkan margin BRONZE
            const publicPrice = Math.ceil(p.price * (1 + publicMargin / 100));

            return {
                name: p.name,
                price: publicPrice
            };
        });

        res.json({ success: true, data: finalProducts });

    } catch (error) {
        console.error("Error di endpoint bot-products:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});
// --- ENDPOINT BARU UNTUK MENGAMBIL DAFTAR GAME UNTUK BOT (DENGAN BLACKLIST) ---
app.get('/api/public/bot-games', async (req, res) => {
    try {
        const { rows: games } = await pool.query(
            "SELECT name, category FROM games WHERE status = 'Active' ORDER BY category, name"
        );

        // Filter game berdasarkan blacklist
        const filteredGames = games.filter(game => 
            !BOT_PRODUCT_BLACKLIST.some(keyword => game.name.toLowerCase().includes(keyword.toLowerCase()))
        );

        // Kelompokkan game yang sudah difilter berdasarkan kategori
        const groupedGames = filteredGames.reduce((acc, game) => {
            const category = game.category || 'Lainnya';
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(game.name);
            return acc;
        }, {});

        res.json({ success: true, data: groupedGames });
    } catch (error) {
        console.error("Error di endpoint bot-games:", error);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar game.' });
    }
});

// === PUBLIC CEK TRANSAKSI ENDPOINTS ===

// Helper: status label publik
function publicStatusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'success') return 'Berhasil';
    if (s === 'failed') return 'Gagal';
    if (s === 'refunded') return 'Refund';
    if (s === 'partial refund') return 'Perlu Review Admin';
    return 'Pending';
}

// Helper: mask invoice ID — TRX-17781619937353 => TRX-1778****7353
function maskInvoiceId(invoiceId) {
    if (!invoiceId || invoiceId.length <= 8) return invoiceId;
    // Cari prefix (misal TRX-)
    const dashIdx = invoiceId.indexOf('-');
    if (dashIdx !== -1 && dashIdx <= 6) {
        const prefix = invoiceId.slice(0, dashIdx + 1);    // "TRX-"
        const num = invoiceId.slice(dashIdx + 1);          // "17781619937353"
        if (num.length <= 8) return invoiceId;
        const visible_start = num.slice(0, 4);
        const visible_end = num.slice(-4);
        return `${prefix}${visible_start}****${visible_end}`;
    }
    // Fallback: tampilkan 4 karakter awal + **** + 4 karakter akhir
    const start = invoiceId.slice(0, 4);
    const end = invoiceId.slice(-4);
    return `${start}****${end}`;
}

// GET /api/public/transaction/:invoiceId — cek satu transaksi (publik, tanpa login)
app.get('/api/public/transaction/:invoiceId', async (req, res) => {
    try {
        const rawId = String(req.params.invoiceId || '').trim().slice(0, 64);
        // Hanya izinkan karakter aman: huruf, angka, underscore, dash
        if (!rawId || !/^[A-Za-z0-9_-]+$/.test(rawId)) {
            return res.status(400).json({ message: 'Format invoice tidak valid.' });
        }

        const sql = `
            SELECT t.invoice_id, t.status, t.price, t.created_at, t.updated_at,
                   p.name AS product_name,
                   g.name AS game_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN games g ON p.game_id = g.id
            WHERE t.invoice_id = $1
            LIMIT 1
        `;
        const { rows } = await pool.query(sql, [rawId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
        }
        const tx = rows[0];

        return res.json({
            invoice_id:   tx.invoice_id,
            status:       tx.status,
            status_label: publicStatusLabel(tx.status),
            game_name:    tx.game_name,
            product_name: tx.product_name,
            price:        Number(tx.price),
            created_at:   tx.created_at,
            updated_at:   tx.updated_at
        });
    } catch (error) {
        logSafeError('[public/transaction] Error:', error);
        res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data transaksi.' });
    }
});

// GET /api/public/recent-transactions — 10 transaksi terbaru (invoice tersamarkan)
app.get('/api/public/recent-transactions', async (req, res) => {
    try {
        const sql = `
            SELECT t.invoice_id, t.status, t.created_at,
                   p.name AS product_name,
                   g.name AS game_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN games g ON p.game_id = g.id
            ORDER BY t.created_at DESC
            LIMIT 10
        `;
        const { rows } = await pool.query(sql);

        const result = rows.map(tx => ({
            invoice_masked: maskInvoiceId(tx.invoice_id),
            status:         tx.status,
            status_label:   publicStatusLabel(tx.status),
            game_name:      tx.game_name,
            product_name:   tx.product_name,
            created_at:     tx.created_at
        }));

        return res.json(result);
    } catch (error) {
        logSafeError('[public/recent-transactions] Error:', error);
        res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data transaksi.' });
    }
});

// === ORDER & H2H ENDPOINTS ===
app.post('/api/order', protect, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const productId = Number(req.body.productId);
        const targetGameId = normalizeString(req.body.targetGameId, 80);
        const targetServerId = normalizeString(req.body.targetServerId, 80);
        const promoCode = req.body.promoCode ? String(req.body.promoCode).trim().toUpperCase() : null;
        const userId = req.user.id;

        if (!Number.isInteger(productId) || productId <= 0 || !targetGameId) throw new Error('Produk dan ID Game wajib diisi.');

        // Ambil detail produk LENGKAP (termasuk join ke game_margins)
        const productQuery = `
                SELECT p.*, g.id as game_id, g.needs_server_id,
                    gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM (SELECT * FROM products WHERE id = $1 AND status = 'Active' FOR UPDATE) AS p
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE g.status = 'Active'
            `;
        const { rows: products } = await client.query(productQuery, [productId]);

        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        const product = products[0];

        // --- LOGIKA HARGA FINAL TIGA LAPIS (YANG DISEMPURNAKAN) ---
        const { rows: users } = await client.query('SELECT balance, role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1 FOR UPDATE', [userId]);
        const user = users[0];
        const userRoleName = user.role_name.toLowerCase();

        let finalPrice;
        const manualPrice = product.manual_prices ? product.manual_prices[userRoleName] : null;
        
        if (product.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
            finalPrice = Number(manualPrice);
        } else {
            const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [user.role_id]);
            if (roleRows.length === 0) throw new Error('Harga produk tidak valid.');
            let margin = Number(roleRows[0].margin_percent); // Default: margin global
            
            if (product.use_custom_margin) {
                const customMargin = product[`${userRoleName}_margin`];
                if (customMargin !== null && customMargin !== undefined) {
                    margin = Number(customMargin);
                }
            }
            finalPrice = Math.ceil(Number(product.price) * (1 + (margin / 100)));
        }
        // --- AKHIR LOGIKA HARGA FINAL ---

        // --- FLASH SALE OVERRIDE ---
        const { rows: flashSaleRows } = await client.query(
            `SELECT discount_price FROM flash_sales WHERE product_id = $1 AND is_active = true AND NOW() BETWEEN start_at AND end_at LIMIT 1`,
            [productId]
        );
        if (flashSaleRows.length > 0) {
            const flashPrice = Number(flashSaleRows[0].discount_price);
            if (flashPrice > 0 && flashPrice < finalPrice) {
                finalPrice = flashPrice;
            }
        }
        // --- AKHIR FLASH SALE OVERRIDE ---

        // --- PRICE GUARD: Cek harga provider real-time sebelum order ---
        try {
            console.log('[order] Checking real-time price from Foxy...');
            const providerProducts = await getFoxyProducts();
            const currentFoxyProduct = providerProducts
                ? providerProducts.find(p => p.product_code === product.provider_sku)
                : null;

            if (!currentFoxyProduct) {
                console.warn(`[order] Product SKU ${product.provider_sku} not found in provider list.`);
                throw new Error('Produk sedang tidak tersedia, silakan coba lagi nanti.');
            }

            const currentProviderCost = Number(currentFoxyProduct.product_price);
            // Blokir jika harga provider > finalPrice yang dikenakan ke user
            if (currentProviderCost > finalPrice) {
                console.warn(`[order] Price risk: Provider cost (${currentProviderCost}) > Final user price (${finalPrice}). SKU ${product.provider_sku}.`);
                syncProductsWithFoxy().catch(err => console.error('[order] Auto-sync after price change failed:', safeAxiosError(err, 'Foxy')));
                throw new Error('Harga produk sedang diperbarui, silakan coba beberapa saat lagi.');
            }
        } catch (priceGuardErr) {
            // Jika provider error (403, timeout, network error), WAJIB block order
            if (priceGuardErr.message && (
                priceGuardErr.message.startsWith('Harga produk sedang diperbarui') ||
                priceGuardErr.message.startsWith('Produk sedang tidak tersedia') ||
                priceGuardErr.message.startsWith('Terjadi perubahan harga')
            )) {
                throw priceGuardErr;
            }
            console.warn('[order] Provider check failed, blocking order:', safeAxiosError(priceGuardErr, 'Foxy'));
            throw new Error('Harga produk sedang diperbarui, silakan coba beberapa saat lagi.');
        }
        // --- AKHIR PRICE GUARD ---

        if (product.needs_server_id && !targetServerId) throw new Error('Server ID wajib diisi untuk game ini.');
        
        // --- PROMO CODE ENFORCEMENT ---
        let appliedPromoId = null;
        if (promoCode) {
            const { rows: promoRows } = await client.query(
                'SELECT * FROM promo_codes WHERE code = $1 AND is_active = true FOR UPDATE',
                [promoCode]
            );
            if (promoRows.length === 0) throw new Error('Kode promo tidak ditemukan atau tidak aktif.');
            const promo = promoRows[0];
            const rules = promo.rules || {};

            if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
                throw new Error('Kode promo sudah kedaluwarsa.');
            }
            if (promo.max_uses && promo.uses_count >= promo.max_uses) {
                throw new Error('Kuota penggunaan promo ini sudah habis.');
            }
            if (rules.max_uses_per_user) {
                const { rows: usageRows } = await client.query(
                    'SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND customer_game_id = $2',
                    [promo.id, targetGameId]
                );
                if (parseInt(usageRows[0].count, 10) >= rules.max_uses_per_user) {
                    throw new Error(`Anda sudah mencapai batas maksimal penggunaan kode ini (${rules.max_uses_per_user}x).`);
                }
            }
            if (rules.min_price && finalPrice < rules.min_price) {
                throw new Error(`Promo ini hanya berlaku untuk pembelian minimal Rp ${rules.min_price}.`);
            }
            if (rules.allowed_game_ids && !rules.allowed_game_ids.includes(product.game_id)) {
                throw new Error('Promo ini tidak berlaku untuk game ini.');
            }
            if (rules.allowed_product_ids && !rules.allowed_product_ids.includes(product.id)) {
                throw new Error('Promo ini tidak berlaku untuk produk ini.');
            }

            let discount = 0;
            if (promo.type === 'percentage') {
                discount = Math.floor(finalPrice * Number(promo.value) / 100);
            } else if (promo.type === 'fixed') {
                discount = Math.floor(Number(promo.value));
            }
            if (!Number.isFinite(discount) || discount < 0) {
                throw new Error('Nilai diskon promo tidak valid.');
            }
            if (discount >= finalPrice) {
                discount = finalPrice - 1;
            }
            if (discount > 0) {
                finalPrice = finalPrice - discount;
                appliedPromoId = promo.id;
            }
        }
        // --- AKHIR PROMO CODE ENFORCEMENT ---

        if (!isValidPriceAmount(finalPrice)) throw new Error('Harga produk tidak valid.');
        const finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
        const duplicate = await findRecentPendingDuplicate(client, userId, productId, finalTargetForDB);
        if (duplicate) throw new Error(`Pesanan serupa masih pending (${duplicate.invoice_id}). Mohon tunggu sebelum mencoba lagi.`);

        if (user.balance < finalPrice) throw new Error('Saldo Anda tidak mencukupi.');
        
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [finalPrice, userId]);
        
        const invoiceId = `TRX-${Date.now()}${userId}`;
        const trx_id_provider = `WEB-${Date.now()}`;
        const { rows: txInsertRows } = await client.query('INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [invoiceId, userId, productId, finalTargetForDB, finalPrice, 'Pending', trx_id_provider]);
        const newTransactionId = txInsertRows[0].id;
        const historyDesc = `Pembelian produk: ${product.name} (${invoiceId})`;
        await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)', [userId, -finalPrice, 'Purchase', historyDesc, invoiceId]);

        if (appliedPromoId) {
            await client.query('UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1', [appliedPromoId]);
            await client.query(
                'INSERT INTO promo_usages (promo_code_id, user_id, product_id, transaction_id, customer_game_id) VALUES ($1, $2, $3, $4, $5)',
                [appliedPromoId, userId, productId, newTransactionId, targetGameId]
            );
        }
        
        try {
            await axios.post(
                `${FOXY_BASE_URL}/v1/order`,
                { product_code: product.provider_sku, user_id: targetGameId, server_id: targetServerId || '', trx_id: trx_id_provider, callback_url: FOXY_CALLBACK_URL },
                { headers: { 'Authorization': FOXY_API_KEY, 'Content-Type': 'application/json' }, timeout: PROVIDER_TIMEOUT_MS }
            );
        } catch (providerError) {
            console.error('[order] Foxy order submission failed:', safeAxiosError(providerError, 'Foxy'));
            throw new Error('Gagal mengirim pesanan ke provider. Saldo tidak dipotong.');
        }

        try {
            await client.query('COMMIT');
        } catch (commitError) {
            console.error(`[CRITICAL] DB COMMIT FAILED AFTER PROVIDER SUCCESS! Invoice: ${invoiceId}, ProviderTrxId: ${trx_id_provider}, UserId: ${userId}`);
            throw commitError;
        }
        res.status(201).json({ message: 'Pesanan Anda sedang diproses!', invoiceId });

    } catch (error) {
        await client.query('ROLLBACK');
        logSafeError("Order error:", error);
        res.status(400).json({ message: getSafeOrderErrorMessage(error, 'Gagal memproses transaksi.') });
    } finally {
        client.release();
    }
});

app.post('/api/foxy/callback', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const trx_id = normalizeString(req.body.trx_id, 255);
        const status = normalizeString(req.body.status, 50);
        const message = normalizeString(req.body.message, 500);
        console.log(`Callback Foxy diterima untuk trx_id: ${trx_id ? `...${trx_id.slice(-8)}` : 'kosong'}`);

        if (!trx_id || !status) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Parameter tidak lengkap.' });
        }
        const normalizedStatus = status.toUpperCase();
        if (!['SUCCESS', 'FAILED', 'REFUNDED', 'PENDING', 'PARTIAL_REFUND'].includes(normalizedStatus)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Status tidak valid.' });
        }
        // TODO: Validate HMAC/Signature from provider (e.g., Foxy) to ensure authenticity of the callback.

        const { rows: transactions } = await client.query('SELECT * FROM transactions WHERE provider_trx_id = $1 AND status = \'Pending\' FOR UPDATE', [trx_id]);
        if (transactions.length === 0) {
            console.log(`Callback untuk provider_trx_id ${trx_id} tidak ditemukan atau sudah diproses.`);
            await client.query('ROLLBACK'); // Rollback jika tidak ada transaksi yang cocok
            return res.status(200).json({ message: 'OK' });
        }
        const tx = transactions[0];

        if (normalizedStatus === 'SUCCESS') {
            const providerSn = req.body.sn || req.body.serial_number || req.body.provider_sn;
            if (providerSn) {
                await client.query('UPDATE transactions SET status = \'Success\', provider_sn = $1, updated_at = NOW() WHERE id = $2', [providerSn, tx.id]);
            } else {
                await client.query('UPDATE transactions SET status = \'Success\', updated_at = NOW() WHERE id = $1', [tx.id]);
            }
                 await createNotification(tx.user_id, `Pesanan ${tx.invoice_id} telah berhasil diproses.`, `/invoice.html?id=${tx.invoice_id}`);
        } else if (normalizedStatus === 'FAILED' || normalizedStatus === 'REFUNDED') {
            await client.query('UPDATE transactions SET status = \'Failed\', updated_at = NOW() WHERE id = $1', [tx.id]);
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);

            const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: ${message || 'Transaksi gagal dari provider'}`;
            await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)', [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
                 await createNotification(tx.user_id, `Pesanan ${tx.invoice_id} gagal. Saldo telah dikembalikan.`, `/invoice.html?id=${tx.invoice_id}`);
        } else if (normalizedStatus === 'PENDING') {
            console.log(`Transaksi ${trx_id} masih pending dari callback.`);
        } else if (normalizedStatus === 'PARTIAL_REFUND') {
            // Tidak auto-refund saldo, tidak mark Success/Failed — butuh review admin
            await client.query(
                "UPDATE transactions SET status = 'Partial Refund', updated_at = NOW() WHERE id = $1",
                [tx.id]
            );
            await createNotification(
                tx.user_id,
                `Pesanan ${tx.invoice_id} memerlukan tinjauan admin. Silakan hubungi CS kami untuk informasi lebih lanjut.`,
                `/invoice.html?id=${tx.invoice_id}`
            );
            console.log(`[callback] Invoice ${tx.invoice_id}: set to Partial Refund (needs admin review).`);
        }
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Callback berhasil diproses.' });

    } catch (error) {
        await client.query('ROLLBACK');
        logSafeError('Callback error:', error);
        res.status(500).json({ message: 'Gagal memproses callback.' });
    } finally {
        client.release();
    }
});

app.post('/h2h/order', protectH2HIp, protectH2H, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const productId = Number(req.body.productId);
        const targetGameId = normalizeString(req.body.targetGameId, 80);
        const targetServerId = normalizeString(req.body.targetServerId, 80);
        const h2hUser = req.user; // User didapat dari middleware protectH2H

        if (!Number.isInteger(productId) || productId <= 0 || !targetGameId) {
            throw new Error('productId dan targetGameId wajib diisi.');
        }

        // 1. Ambil detail produk LENGKAP (termasuk join ke game_margins)
        const productQuery = `
            SELECT p.*, g.id as game_id, g.needs_server_id,
                   gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
            FROM products p 
            JOIN games g ON p.game_id = g.id
            LEFT JOIN game_margins gm ON p.game_id = gm.game_id
            WHERE p.id = $1 AND p.status = 'Active' AND g.status = 'Active' FOR UPDATE
        `;
        const { rows: products } = await client.query(productQuery, [productId]);

        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        const product = products[0];

        if (product.needs_server_id && !targetServerId) {
            throw new Error('Server ID wajib diisi untuk game ini.');
        }

        // 2. Ambil User H2H
        const { rows: users } = await client.query('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE', [h2hUser.id]);
        const userForTx = users[0];
        const userRoleName = h2hUser.role_name.toLowerCase();

        // --- LOGIKA HARGA FINAL ---
        let finalPrice;
        const manualPrice = product.manual_prices ? product.manual_prices[userRoleName] : null;
        if (product.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
            finalPrice = Number(manualPrice);
        } else {
            const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [userForTx.role_id]);
            if (roleRows.length === 0) throw new Error('Harga produk tidak valid.');
            let margin = Number(roleRows[0].margin_percent);
            if (product.use_custom_margin) {
                const customMargin = product[`${userRoleName}_margin`];
                if (customMargin !== null && customMargin !== undefined) {
                    margin = Number(customMargin);
                }
            }
            finalPrice = Math.ceil(Number(product.price) * (1 + (margin / 100)));
        }
        
        // --- FLASH SALE OVERRIDE ---
        const { rows: h2hFlashSaleRows } = await client.query(
            `SELECT discount_price FROM flash_sales WHERE product_id = $1 AND is_active = true AND NOW() BETWEEN start_at AND end_at LIMIT 1`,
            [productId]
        );
        if (h2hFlashSaleRows.length > 0) {
            const flashPrice = Number(h2hFlashSaleRows[0].discount_price);
            if (flashPrice > 0 && flashPrice < finalPrice) {
                finalPrice = flashPrice;
            }
        }

        // --- PRICE GUARD H2H ---
        try {
            console.log(`[h2h-order] Checking real-time price for SKU ${product.provider_sku}...`);
            const providerProducts = await getFoxyProducts();
            const currentFoxyProduct = providerProducts
                ? providerProducts.find(p => p.product_code === product.provider_sku)
                : null;
            
            if (!currentFoxyProduct) {
                console.warn(`[h2h-order] Product SKU ${product.provider_sku} not found in provider list.`);
                throw new Error('Produk sedang tidak tersedia, silakan coba lagi nanti.');
            }

            const currentProviderCost = Number(currentFoxyProduct.product_price);
            if (currentProviderCost > finalPrice) {
                console.warn(`[h2h-order] Price risk: Cost (${currentProviderCost}) > Final price (${finalPrice}). SKU ${product.provider_sku}.`);
                syncProductsWithFoxy().catch(err => console.error('[h2h-order] Auto-sync after price change failed:', safeAxiosError(err, 'Foxy')));
                throw new Error('Harga produk sedang diperbarui, silakan coba beberapa saat lagi.');
            }
        } catch (priceGuardErr) {
            if (priceGuardErr.message && (
                priceGuardErr.message.startsWith('Harga produk sedang diperbarui') ||
                priceGuardErr.message.startsWith('Produk sedang tidak tersedia') ||
                priceGuardErr.message.startsWith('Terjadi perubahan harga')
            )) {
                throw priceGuardErr;
            }
            console.warn('[h2h-order] Provider check failed, blocking order:', safeAxiosError(priceGuardErr, 'Foxy'));
            throw new Error('Harga produk sedang diperbarui, silakan coba beberapa saat lagi.');
        }
        // --- AKHIR PRICE GUARD H2H ---

        if (!isValidPriceAmount(finalPrice)) throw new Error('Harga produk tidak valid.');
        const finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
        const duplicate = await findRecentPendingDuplicate(client, h2hUser.id, productId, finalTargetForDB);
        if (duplicate) throw new Error(`Pesanan serupa masih pending (${duplicate.invoice_id}). Mohon tunggu sebelum mencoba lagi.`);

        if (userForTx.balance < finalPrice) throw new Error('Saldo H2H Anda tidak mencukupi.');
        
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [finalPrice, h2hUser.id]);

        const invoiceId = `H2H-${Date.now()}${h2hUser.id}`;
        const trx_id_provider = `H2H-PROVIDER-${Date.now()}`;

        await client.query('INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [invoiceId, h2hUser.id, productId, finalTargetForDB, finalPrice, 'Pending', trx_id_provider]);

        const historyDesc = `Pembelian H2H: ${product.name} (${invoiceId})`;
        await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)', [h2hUser.id, -finalPrice, 'Purchase', historyDesc, invoiceId]);

        const foxyPayload = {
            product_code: product.provider_sku,
            user_id: targetGameId,
            server_id: targetServerId || '',
            trx_id: trx_id_provider,
            callback_url: FOXY_CALLBACK_URL
        };

        const foxyConfigHeaders = {
            headers: {
                'Authorization': FOXY_API_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/108.0.0.0 Safari/537.36',
                'Referer': 'https://www.foxygamestore.com/'
            }
        };

        try {
            await axios.post(`${FOXY_BASE_URL}/v1/order`, foxyPayload, { ...foxyConfigHeaders, timeout: PROVIDER_TIMEOUT_MS });
        } catch (providerError) {
            console.error('[h2h-order] Foxy order submission failed:', safeAxiosError(providerError, 'Foxy'));
            throw new Error('Gagal mengirim pesanan ke provider. Saldo tidak dipotong.');
        }

        try {
            await client.query('COMMIT');
        } catch (commitError) {
            console.error(`[CRITICAL] DB COMMIT FAILED AFTER PROVIDER SUCCESS! Invoice: ${invoiceId}, ProviderTrxId: ${trx_id_provider}, UserId: ${h2hUser.id}`);
            throw commitError;
        }
        
        res.status(201).json({ 
            success: true,
            message: 'Pesanan H2H Anda sedang diproses!', 
            data: {
                invoiceId: invoiceId,
                status: 'Pending',
                productName: product.name,
                target: finalTargetForDB,
                price: finalPrice
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        logSafeError("H2H Order error:", error);
        res.status(400).json({ success: false, message: getSafeOrderErrorMessage(error, 'Gagal memproses transaksi H2H.') });
    } finally {
        client.release();
    }
});

app.get('/h2h/products', protectH2HIp, protectH2H, async (req, res) => {
    try {
        const h2hPartner = req.user;
        const partnerRoleName = h2hPartner.role_name.toLowerCase();

        const { rows: globalRoleRows } = await pool.query('SELECT margin_percent FROM roles WHERE id = $1', [h2hPartner.role_id]);
        const globalMargin = globalRoleRows[0].margin_percent;

        // --- AWAL PERBAIKAN ---
        // 1. Ambil semua item flash sale yang sedang aktif
        const { rows: activeFlashSales } = await pool.query(`
            SELECT product_id, discount_price FROM flash_sales
            WHERE is_active = true AND NOW() BETWEEN start_at AND end_at
        `);
        // 2. Buat Peta (Map) untuk pencarian cepat
        const flashSaleMap = new Map(activeFlashSales.map(fs => [fs.product_id, fs.discount_price]));
        // --- AKHIR PERBAIKAN ---

        const productQuery = `
            SELECT p.id, p.name as product_name, p.provider_sku, p.price as base_price, g.name as game_name,
                   p.use_manual_prices, p.manual_prices,
                   gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
            FROM products p
            JOIN games g ON p.game_id = g.id
            LEFT JOIN game_margins gm ON p.game_id = gm.game_id
            WHERE p.status = 'Active' AND g.status = 'Active'
            ORDER BY g.name, p.price
        `;
        const { rows: allActiveProducts } = await pool.query(productQuery);
        
        const partnerProductList = allActiveProducts.map(product => {
            let finalPrice;
            let originalPrice = null;
            let isFlashSale = false;

            // --- PERUBAHAN LOGIKA UTAMA ---
            // PRIORITAS 0: FLASH SALE
            if (flashSaleMap.has(product.id)) {
                isFlashSale = true;
                finalPrice = flashSaleMap.get(product.id);

                // Hitung harga asli partner sebelum diskon untuk referensi
                let margin = globalMargin;
                 if (product.use_custom_margin) {
                    const customMargin = product[`${partnerRoleName}_margin`];
                    if (customMargin !== null && customMargin !== undefined) {
                        margin = customMargin;
                    }
                }
                originalPrice = Math.ceil(product.base_price * (1 + (margin / 100)));

            } else {
                const manualPrice = product.manual_prices ? product.manual_prices[partnerRoleName] : null;

                // PRIORITAS 1: HARGA MANUAL
                if (product.use_manual_prices && manualPrice) {
                    finalPrice = manualPrice;
                } else {
                    // PRIORITAS 2 & 3: MARGIN
                    let margin = globalMargin;
                    if (product.use_custom_margin) {
                        const customMargin = product[`${partnerRoleName}_margin`];
                        if (customMargin !== null && customMargin !== undefined) {
                            margin = customMargin;
                        }
                    }
                    finalPrice = Math.ceil(product.base_price * (1 + (margin / 100)));
                }
            }

            return {
                productId: product.id,
                game_name: product.game_name,
                product_name: product.product_name,
                sku: product.provider_sku,
                price: finalPrice,
                isFlashSale: isFlashSale, // Info tambahan untuk partner
                originalPrice: originalPrice // Info tambahan untuk partner
            };
        });
        
        res.json({
            success: true,
            message: 'Daftar produk berhasil diambil.',
            data: partnerProductList
        });

    } catch (error) {
        console.error('H2H Get Products Error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar produk H2H.' });
    }
});

/* Deprecated checkPendingTransactions removed in Phase 3B */

app.put('/h2h/profile/callback', protectH2H, async (req, res) => {
    try {
        const callback_url = normalizeString(req.body.callback_url, 2048);
        // Validasi URL sederhana
        if (!callback_url || !isValidHttpsCallbackUrl(callback_url)) {
            return res.status(400).json({ success: false, message: 'URL callback tidak valid.' });
        }
        
        await pool.query('UPDATE users SET h2h_callback_url = $1 WHERE id = $2', [callback_url, req.user.id]);
        
        res.json({ success: true, message: 'Callback URL berhasil diperbarui.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memperbarui callback URL.' });
    }
});

app.get('/h2h/profile', protectH2H, async (req, res) => {

    const profileData = {
        username: req.user.username,
        balance: req.user.balance,
        role: req.user.role_name 
    };

    res.json({
        success: true,
        message: 'Profil berhasil diambil.',
        data: profileData
    });
});

function startServer(port = PORT) {
    validateEnvironment({ strict: true });
    const startedServer = app.listen(port, () => {
        const address = startedServer.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        console.log(`Server berjalan di port ${actualPort}`);
    });
    return startedServer;
}

let server = null;
if (require.main === module) {
    server = startServer();
}

module.exports = { app, pool, startServer, server, validateEnvironment };
