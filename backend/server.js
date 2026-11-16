const {
    PORT,
    JWT_SECRET,
    FOXY_API_KEY,
    FOXY_CALLBACK_URL,
    validateEnvironment,
} = require('./config/env');
const {
    BOT_PRODUCT_BLACKLIST,
    MAX_BODY_SIZE,
    DUPLICATE_ORDER_WINDOW_SECONDS,
    FOXY_BASE_URL,
    PROVIDER_TIMEOUT_MS,
    FOXY_CACHE_TTL,
    ALLOWED_PAYMENT_METHOD_TYPES,
    CALLBACK_VERIFY_COOLDOWN_MS,
    CALLBACK_SUCCESS_RESPONSE,
} = require('./config/constants');
const {
    safeErrorDetail,
    logSafeError,
    safeAxiosError,
} = require('./utils/logger');
const {
    normalizeString,
    normalizePhone,
    normalizeProfilePhone,
    escapeHtml,
    publicStatusLabel,
    maskInvoiceId,
    maskLeaderboardName,
    leaderboardRankLabel,
    formatRupiahBot,
} = require('./utils/strings');
const {
    hashResetToken,
    hashApiKey,
    timingSafeStringEqual,
    generateInvoiceId,
    generateProviderTrxId,
} = require('./utils/crypto');
const {
    isValidEmail,
    isValidPassword,
    parsePositiveQuota,
    isValidPriceAmount,
    isValidInvoiceId,
    parseOptionalRefId,
    parseOptionalIdempotencyKeyHeader,
    isSafeAssetUrl,
    parseOptionalBoolean,
    parseOptionalText,
    sanitizeValidationServiceName,
} = require('./utils/validation');
const { securityHeaders, corsMiddleware } = require('./middleware/securityHeaders');
const { createRateLimiters } = require('./middleware/rateLimiters');
const { createAuthMiddleware } = require('./middleware/auth');
const { createH2HAuthMiddleware } = require('./middleware/h2hAuth');
const createPublicRoutes = require('./routes/public.routes');
const createUserRoutes = require('./routes/user.routes');
const express = require('express');
const fs = require('fs').promises;
const { createPool } = require('./config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const net = require('net');
const { sendPasswordResetEmail } = require('./utils/mailer.js');
const { isValidIpOrCidr } = require('./utils/networkSecurity.js');
const { sendH2HWebhook, validateWebhookUrl, dispatchSafeH2HWebhook } = require('./utils/webhookClient.js');
const { syncProductsWithFoxy, rollbackTransactionResources } = require('./utils/cronUtils.js');
const { validateGameId } = require('./utils/validators/cek-id-game.js');
const { checkAllMobapayPromosML, checkMobapayMlbbEligibility } = require('./utils/validators/stalk-ml-promo.js');
const { cekPromoMcggMobapay } = require('./utils/validators/stalk-mcgg.js');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // untuk mendapatkan IP asli di belakang proxy

function getSafeOrderErrorMessage(error, fallback) {
    const message = error && error.message ? error.message : '';
    const allowedMessages = [
        'Produk dan ID Game wajib diisi.',
        'productId dan targetGameId wajib diisi.',
        'Produk tidak valid atau tidak aktif.',
        'Terjadi perubahan harga',
        'Harga sedang diperbarui, coba lagi sebentar',
        'Harga produk sedang diperbarui',
        'Produk sedang tidak tersedia',
        'Server ID wajib diisi',
        'Saldo Anda tidak mencukupi.',
        'Saldo H2H Anda tidak mencukupi.',
        'Harga produk tidak valid.',
        'Pesanan serupa masih pending',
        'Gagal mengirim pesanan ke provider.',
        'Kode promo tidak ditemukan',
        'Kode promo tidak dapat digunakan',
        'Kode promo sudah kedaluwarsa.',
        'Kuota penggunaan promo',
        'Anda sudah mencapai batas maksimal',
        'Promo ini hanya berlaku',
        'Promo ini tidak berlaku',
        'Nilai diskon promo tidak valid.',
        'Validasi ID sedang tidak tersedia',
        'ID game tidak valid',
        // Phase 5C-2A — Mobapay Eligibility
        'User ID atau Zone ID tidak valid.',
        'WDP untuk ID ini sudah penuh atau tidak tersedia.',
        'Promo Double Diamond untuk ID ini sudah tidak tersedia.',
        'Bundle Weekly Elite tidak tersedia untuk ID ini.',
        'Bundle Monthly Epic tidak tersedia untuk ID ini.',
        'Pengecekan promo sedang tidak tersedia, coba lagi nanti.',
        'Produk tidak tersedia untuk ID ini.',
        'Metode pembayaran akun tidak sesuai untuk produk ini.',
        'Konfigurasi Double Diamond tidak valid',
        'Kuota transaksi harian H2H Anda telah tercapai.',
        'Batas nominal transaksi harian H2H Anda telah tercapai.',
        'Format ref_id tidak valid',
        'Header Idempotency-Key harus berupa UUID yang valid.',
        'ref_id sudah digunakan',
        'Idempotency-Key sudah digunakan',
    ];
    return allowedMessages.some(allowed => message.startsWith(allowed)) ? message : fallback;
}

async function findTransactionByRefId(queryable, userId, refId) {
    const { rows } = await queryable.query(
        `SELECT t.id, t.invoice_id, t.user_id, t.product_id, t.target_game_id, t.price, t.status, t.ref_id,
                p.name AS product_name, g.needs_server_id
         FROM transactions t
         LEFT JOIN products p ON t.product_id = p.id
         LEFT JOIN games g ON p.game_id = g.id
         WHERE t.user_id = $1 AND t.ref_id = $2
         LIMIT 1`,
        [userId, refId]
    );
    return rows && rows[0] ? rows[0] : null;
}

function matchesOrderIdempotencyPayload(existingTx, productId, targetGameId, targetServerId) {
    if (!existingTx || Number(existingTx.product_id) !== Number(productId)) {
        return false;
    }
    const expectedTarget = Boolean(existingTx.needs_server_id)
        ? `${targetGameId}|${targetServerId || ''}`
        : targetGameId;
    return existingTx.target_game_id === expectedTarget;
}

function buildIdempotentOrderResponseBody(channel, existingTx) {
    if (channel === 'h2h') {
        return {
            success: true,
            idempotent: true,
            message: 'Transaksi H2H sudah tercatat sebelumnya (idempotent).',
            data: {
                invoiceId: existingTx.invoice_id,
                status: existingTx.status,
                productName: existingTx.product_name,
                target: existingTx.target_game_id,
                price: Number(existingTx.price)
            }
        };
    }
    return {
        idempotent: true,
        message: 'Pesanan sudah tercatat sebelumnya (idempotent).',
        invoiceId: existingTx.invoice_id,
        status: existingTx.status
    };
}

async function resolveExistingIdempotentOrder(queryable, { channel, userId, idempotencyKey, keyLabel, productId, targetGameId, targetServerId }) {
    if (!idempotencyKey) return null;
    const existingTx = await findTransactionByRefId(queryable, userId, idempotencyKey);
    if (!existingTx) return null;

    if (!matchesOrderIdempotencyPayload(existingTx, productId, targetGameId, targetServerId)) {
        const conflictErr = new Error(`${keyLabel} sudah digunakan untuk pesanan dengan payload berbeda.`);
        conflictErr.statusCode = 409;
        throw conflictErr;
    }

    if (channel === 'web' && existingTx.status === 'Failed') {
        return {
            statusCode: 409,
            body: {
                idempotent: true,
                invoiceId: existingTx.invoice_id,
                status: existingTx.status,
                message: 'Pesanan sebelumnya gagal dan saldo telah dikembalikan. Silakan buat pesanan baru.'
            }
        };
    }

    return {
        statusCode: 200,
        body: buildIdempotentOrderResponseBody(channel, existingTx)
    };
}

async function findDepositByIdempotencyKey(queryable, userId, idempotencyKey) {
    const { rows } = await queryable.query(
        `SELECT id, user_id, amount, unique_code, status, method, note, idempotency_key, created_at
         FROM deposits
         WHERE user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [userId, idempotencyKey]
    );
    return rows && rows[0] ? rows[0] : null;
}

function matchesDepositIdempotencyPayload(existingDeposit, baseAmount, methodRow, trimmedNote) {
    if (!existingDeposit) return false;
    const existingBaseAmount = Math.trunc(Number(existingDeposit.amount) - Number(existingDeposit.unique_code || 0));
    const existingMethod = String(existingDeposit.method || '').trim().toLowerCase();
    const targetMethod = String(methodRow.name || '').trim().toLowerCase();
    const existingNote = existingDeposit.note ? String(existingDeposit.note).trim() : null;
    const targetNote = trimmedNote ? String(trimmedNote).trim() : null;
    return existingBaseAmount === baseAmount && existingMethod === targetMethod && existingNote === targetNote;
}

function buildDepositPaymentInstructions({ depositId, totalAmount, uniqueCode, methodRow }) {
    const useUniqueCode = !Boolean(methodRow.is_qris);
    const amountFormatted = new Intl.NumberFormat('id-ID').format(totalAmount);
    const safeMethodName = escapeHtml(methodRow.name);
    const safeAcctNumber = methodRow.account_number ? escapeHtml(methodRow.account_number) : '';
    const safeAcctName = methodRow.account_name ? escapeHtml(methodRow.account_name) : '';
    const targetLabel = safeAcctNumber
        ? `ke tujuan <strong>${safeAcctNumber}</strong>${safeAcctName ? ` (a.n. <strong>${safeAcctName}</strong>)` : ''}`
        : 'ke tujuan pembayaran resmi MIKU Store';

    let paymentInstructions;
    if (useUniqueCode) {
        paymentInstructions = `Transfer sejumlah <strong>Rp ${amountFormatted}</strong> (termasuk kode unik <strong>${uniqueCode}</strong>) via <strong>${safeMethodName}</strong> ${targetLabel}. Sertakan nomor deposit <strong>#${depositId}</strong> di keterangan transfer.`;
    } else {
        paymentInstructions = `Transfer tepat sejumlah <strong>Rp ${amountFormatted}</strong> via <strong>${safeMethodName}</strong> (tanpa kode unik 3 digit)${safeAcctName ? ` a.n. <strong>${safeAcctName}</strong>` : ''}. Cantumkan nomor deposit <strong>#${depositId}</strong> saat konfirmasi pembayaran.`;
    }
    if (methodRow.instructions) {
        paymentInstructions += ` <br><small>${escapeHtml(methodRow.instructions)}</small>`;
    }
    return paymentInstructions;
}

function buildDepositResponsePayload(depositRow, methodRow, idempotent = false) {
    const totalAmount = Number(depositRow.amount);
    const uniqueCode = Number(depositRow.unique_code || 0);
    const body = {
        message: idempotent
            ? 'Permintaan deposit sudah tercatat sebelumnya (idempotent).'
            : 'Permintaan deposit berhasil dibuat. Saldo akan masuk setelah admin memverifikasi pembayaran.',
        deposit: {
            id: depositRow.id,
            amount: totalAmount,
            unique_code: uniqueCode,
            method: methodRow.name,
            is_qris: Boolean(methodRow.is_qris),
            status: depositRow.status || 'Pending',
            created_at: depositRow.created_at,
            paymentInstructions: buildDepositPaymentInstructions({
                depositId: depositRow.id,
                totalAmount,
                uniqueCode,
                methodRow
            })
        }
    };
    if (idempotent) {
        body.idempotent = true;
    }
    return body;
}

async function insertTransactionRecord(client, {
    invoiceId,
    userId,
    productId,
    targetForDb,
    finalPrice,
    providerTrxId,
    flashSaleId,
    idempotencyKey
}) {
    const sql = idempotencyKey
        ? 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id, flash_sale_id, ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id'
        : 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id, flash_sale_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id';
    const params = idempotencyKey
        ? [invoiceId, userId, productId, targetForDb, finalPrice, 'Pending', providerTrxId, flashSaleId || null, idempotencyKey]
        : [invoiceId, userId, productId, targetForDb, finalPrice, 'Pending', providerTrxId, flashSaleId || null];
    return client.query(sql, params);
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

/**
 * Jalankan validasi ID game jika product.validation_config aktif.
 * Dipanggil SEBELUM saldo dipotong.
 * @param {object} product - Baris produk dari DB (harus punya validation_config & needs_server_id)
 * @param {string} targetGameId - User ID game dari request
 * @param {string|null} targetServerId - Server ID dari request (bisa null)
 * @returns {{ skipped: true } | { validated: true }}
 * @throws {Error} Jika validasi gagal atau validator error
 */
async function validateOrderGameIdIfNeeded(product, targetGameId, targetServerId) {
    const config = product.validation_config;
    // Skip jika config tidak ada, enabled !== true, atau validator kosong
    if (!config || config.enabled !== true || !config.validator ||
        typeof config.validator !== 'string' || !config.validator.trim()) {
        return { skipped: true };
    }

    const validatorName = config.validator.trim();
    const zoneId = product.needs_server_id ? (targetServerId || null) : null;

    // === Phase 5C-2A: Mobapay MLBB Eligibility ===
    if (validatorName === 'mobapay-mlbb-eligibility') {
        let mobapayResult;
        try {
            mobapayResult = await checkMobapayMlbbEligibility(
                targetGameId,
                zoneId,
                config.checks || [],
                config.rules || {},
                { country: config.country || 'ID', timeout: 10000 }
            );
        } catch (mobErr) {
            // Network/API fatal — fail-closed: tolak order, saldo tidak dipotong
            console.warn('[validateOrderGameId] Mobapay network error:', mobErr && mobErr.message);
            throw new Error('Pengecekan promo sedang tidak tersedia, coba lagi nanti.');
        }
        if (!mobapayResult.success) {
            const safeMsg = typeof mobapayResult.message === 'string' && mobapayResult.message.length > 0
                ? mobapayResult.message
                : 'Produk tidak tersedia untuk ID ini.';
            throw new Error(safeMsg);
        }
        return { validated: true };
    }

    // === PGS Validator (existing) ===
    let result;
    try {
        result = await validateGameId(
            validatorName,
            targetGameId,
            zoneId,
            config.rules || {}
        );
    } catch (valErr) {
        console.warn('[validateOrderGameId] Validator error:', valErr && valErr.message);
        throw new Error('Validasi ID sedang tidak tersedia, coba lagi nanti.');
    }

    if (!result.success) {
        const safeMsg = typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : 'ID game tidak valid.';
        throw new Error(safeMsg);
    }
    return { validated: true };
}

// === CACHE PRODUK FOXY ===
let foxyProductCache = null;
let foxyCacheTimestamp = null;

function invalidateFoxyProductCache() {
    foxyProductCache = null;
    foxyCacheTimestamp = null;
}

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
app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json({ limit: MAX_BODY_SIZE }));
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

const pool = createPool();

pool.on('connect', (client) => {
  client.query("SET TIME ZONE 'Asia/Jakarta'");
});

app.use(createPublicRoutes({ pool }));

const { h2hUserLimiter, applyRateLimiters } = createRateLimiters();
applyRateLimiters(app);


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
const { protect, protectAdmin, softProtect } = createAuthMiddleware({ pool });
const { protectH2H, protectH2HIp } = createH2HAuthMiddleware({ pool });

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
app.use(createUserRoutes({ pool, protect }));

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

app.post('/api/user/generate-apikey', protect, handleGenerateOrRegenerateApiKey);
app.post('/api/user/apikey/regenerate', protect, handleGenerateOrRegenerateApiKey);

app.get('/api/user/apikey', protect, async (req, res) => {
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

app.delete('/api/user/apikey', protect, handleRevokeApiKey);
app.post('/api/user/apikey/revoke', protect, handleRevokeApiKey);

app.get('/api/user/webhook-secret', protect, async (req, res) => {
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

app.post('/api/user/webhook-secret/rotate', protect, async (req, res) => {
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

// === DEPOSIT & PAYMENT METHOD ENDPOINTS ===

function normalizePaymentMethodPayload(body, existing = null) {
    const src = body && typeof body === 'object' ? body : {};
    const hasProp = (k) => Object.prototype.hasOwnProperty.call(src, k);

    const rawName = hasProp('name') ? src.name : existing?.name;
    if (typeof rawName !== 'string' || !rawName.trim()) {
        return { error: 'Nama metode pembayaran wajib diisi.' };
    }
    const name = rawName.trim();
    if (name.length > 100) {
        return { error: 'Nama metode pembayaran maksimal 100 karakter.' };
    }

    const rawCode = hasProp('code') ? src.code : existing?.code;
    if (typeof rawCode !== 'string' || !rawCode.trim()) {
        return { error: 'Kode metode pembayaran wajib diisi.' };
    }
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,50}$/.test(code)) {
        return { error: 'Kode metode harus 2-50 karakter (huruf, angka, _ atau -).' };
    }

    const rawType = hasProp('type') ? src.type : (existing?.type ?? 'ewallet');
    const type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
    if (!ALLOWED_PAYMENT_METHOD_TYPES.includes(type)) {
        return { error: `Tipe metode harus salah satu dari: ${ALLOWED_PAYMENT_METHOD_TYPES.join(', ')}.` };
    }

    const acctNumRes = parseOptionalText(src, 'account_number', existing?.account_number ?? null, 100);
    if (acctNumRes.error) return { error: 'Nomor rekening/HP ' + acctNumRes.error };

    const acctNameRes = parseOptionalText(src, 'account_name', existing?.account_name ?? null, 150);
    if (acctNameRes.error) return { error: 'Atas nama ' + acctNameRes.error };

    const qrisUrlRes = parseOptionalText(src, 'qris_image_url', existing?.qris_image_url ?? null, 1000);
    if (qrisUrlRes.error) return { error: 'URL gambar QRIS ' + qrisUrlRes.error };
    if (qrisUrlRes.value && !isSafeAssetUrl(qrisUrlRes.value)) {
        return { error: 'URL gambar QRIS tidak valid. Gunakan URL http(s):// atau path /...' };
    }

    const instrRes = parseOptionalText(src, 'instructions', existing?.instructions ?? null, 1000);
    if (instrRes.error) return { error: 'Instruksi ' + instrRes.error };

    const rawMin = hasProp('min_amount') && src.min_amount !== '' && src.min_amount !== null
        ? src.min_amount
        : (existing?.min_amount ?? 10000);
    const minAmount = Number(rawMin);
    if (!Number.isFinite(minAmount) || minAmount < 10000 || minAmount > 100000000) {
        return { error: 'Minimal deposit harus antara Rp 10.000 hingga Rp 100.000.000.' };
    }

    const rawSort = hasProp('sort_order') && src.sort_order !== '' && src.sort_order !== null
        ? src.sort_order
        : (existing?.sort_order ?? 0);
    const sortOrder = Number(rawSort);
    if (!Number.isInteger(sortOrder) || sortOrder < -9999 || sortOrder > 9999) {
        return { error: 'Urutan tampil harus berupa bilangan bulat (-9999 sampai 9999).' };
    }

    const parsedActive = hasProp('is_active')
        ? parseOptionalBoolean(src.is_active, null)
        : (existing ? Boolean(existing.is_active) : true);
    if (parsedActive === null) {
        return { error: 'Status aktif (is_active) tidak valid.' };
    }

    let isQris;
    if (type === 'qris') {
        isQris = true;
    } else if (hasProp('is_qris')) {
        const parsedQris = parseOptionalBoolean(src.is_qris, null);
        if (parsedQris === null) return { error: 'Flag is_qris tidak valid.' };
        isQris = parsedQris;
    } else if (hasProp('type')) {
        isQris = false;
    } else {
        isQris = existing ? Boolean(existing.is_qris) : false;
    }

    return {
        data: {
            code,
            name,
            type,
            account_number: acctNumRes.value,
            account_name: acctNameRes.value,
            qris_image_url: qrisUrlRes.value,
            instructions: instrRes.value,
            is_qris: isQris,
            min_amount: minAmount,
            is_active: parsedActive,
            sort_order: sortOrder
        }
    };
}

app.get('/api/payment-methods', protect, async (req, res) => {
    try {
        const sql = `SELECT id, code, name, type, account_number, account_name,
                            qris_image_url, instructions, is_qris, min_amount, sort_order
                     FROM payment_methods
                     WHERE is_active = true
                     ORDER BY sort_order ASC, id ASC`;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching active payment methods:', error);
        res.status(500).json({ message: 'Gagal memuat metode pembayaran.' });
    }
});

app.post('/api/deposit/request', protect, async (req, res) => {
    let idempotencyKey = null;
    try {
        idempotencyKey = parseOptionalIdempotencyKeyHeader(req);
    } catch (keyErr) {
        return res.status(keyErr.statusCode || 400).json({ message: keyErr.message });
    }

    const { amount, method, note } = req.body;
    const userId = req.user.id;
    const parsedAmount = Number(amount);

    // Validasi amount global
    if (!Number.isFinite(parsedAmount) || parsedAmount < 10000 || parsedAmount > 100000000) {
        return res.status(400).json({ message: 'Jumlah deposit tidak valid. Minimum Rp 10.000, maksimum Rp 100.000.000.' });
    }

    // Validasi method — wajib dan aktif di tabel payment_methods
    const trimmedMethod = typeof method === 'string' ? method.trim() : '';
    if (!trimmedMethod) {
        return res.status(400).json({ message: 'Metode pembayaran wajib dipilih.' });
    }

    // Validasi note — opsional, max 200 karakter
    const trimmedNote = typeof note === 'string' ? note.trim() : '';
    if (trimmedNote.length > 200) {
        return res.status(400).json({ message: 'Catatan terlalu panjang. Maksimum 200 karakter.' });
    }

    let methodRow;
    try {
        const methodRes = await pool.query(
            `SELECT id, code, name, type, account_number, account_name,
                    qris_image_url, instructions, is_qris, min_amount
             FROM payment_methods
             WHERE (LOWER(code) = LOWER($1) OR LOWER(name) = LOWER($1))
               AND is_active = true
             LIMIT 1`,
            [trimmedMethod]
        );
        if (!methodRes || !methodRes.rows || methodRes.rows.length === 0) {
            return res.status(400).json({ message: 'Metode pembayaran tidak valid atau sedang tidak aktif.' });
        }
        methodRow = methodRes.rows[0];
    } catch (error) {
        console.error('Error validating deposit payment method:', error);
        return res.status(500).json({ message: 'Terjadi kesalahan pada server saat memvalidasi metode pembayaran.' });
    }

    const baseAmount = Math.trunc(parsedAmount);
    const methodMinAmount = Number(methodRow.min_amount) || 10000;
    if (baseAmount < methodMinAmount) {
        const minFormatted = new Intl.NumberFormat('id-ID').format(methodMinAmount);
        return res.status(400).json({
            message: `Minimum deposit untuk metode ${methodRow.name} adalah Rp ${minFormatted}.`
        });
    }

    // Pre-check idempotency (sebelum pendingCount >= 2 agar retry deposit yang baru dibuat tidak terkena 429)
    if (idempotencyKey) {
        try {
            const existingDeposit = await findDepositByIdempotencyKey(pool, userId, idempotencyKey);
            if (existingDeposit) {
                if (!matchesDepositIdempotencyPayload(existingDeposit, baseAmount, methodRow, trimmedNote)) {
                    return res.status(409).json({
                        message: 'Idempotency-Key sudah digunakan untuk deposit dengan payload berbeda.'
                    });
                }
                return res.status(200).json(buildDepositResponsePayload(existingDeposit, methodRow, true));
            }
        } catch (idempErr) {
            console.error('Error checking deposit idempotency:', idempErr);
            return res.status(500).json({ message: 'Terjadi kesalahan pada server saat memvalidasi idempotency deposit.' });
        }
    }

    const useUniqueCode = !Boolean(methodRow.is_qris);
    const client = await pool.connect();
    let inTransaction = false;
    try {
        await client.query('BEGIN');
        inTransaction = true;
        const pendingCheck = await client.query(
            "SELECT COUNT(*) AS count FROM deposits WHERE user_id = $1 AND status = 'Pending'",
            [userId]
        );
        const pendingCount = (pendingCheck && pendingCheck.rows && pendingCheck.rows[0] && pendingCheck.rows[0].count !== undefined)
            ? parseInt(pendingCheck.rows[0].count, 10)
            : 0;
        if (pendingCount >= 2) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(429).json({
                message: 'Anda masih memiliki maksimal 2 permintaan deposit Pending. Selesaikan atau tunggu verifikasi terlebih dahulu.'
            });
        }

        let uniqueCode = 0;
        let totalAmount = baseAmount;
        if (useUniqueCode) {
            for (let attempt = 0; attempt < 10; attempt++) {
                const candidateCode = Math.floor(Math.random() * 900) + 100;
                const candidateTotal = baseAmount + candidateCode;
                const collisionRes = await client.query(
                    "SELECT 1 FROM deposits WHERE status = 'Pending' AND amount = $1 LIMIT 1",
                    [candidateTotal]
                );
                if (!collisionRes || !collisionRes.rows || collisionRes.rows.length === 0) {
                    uniqueCode = candidateCode;
                    totalAmount = candidateTotal;
                    break;
                }
            }
            if (uniqueCode === 0) {
                uniqueCode = Math.floor(Math.random() * 900) + 100;
                totalAmount = baseAmount + uniqueCode;
            }
        }

        const insertSql = idempotencyKey
            ? 'INSERT INTO deposits (user_id, amount, unique_code, status, method, note, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at'
            : 'INSERT INTO deposits (user_id, amount, unique_code, status, method, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at';
        const insertParams = idempotencyKey
            ? [userId, totalAmount, uniqueCode, 'Pending', methodRow.name, trimmedNote || null, idempotencyKey]
            : [userId, totalAmount, uniqueCode, 'Pending', methodRow.name, trimmedNote || null];

        const { rows } = await client.query(insertSql, insertParams);
        const depositId = rows[0].id;
        const createdAt = rows[0].created_at;
        await client.query('COMMIT');
        inTransaction = false;

        return res.status(201).json(buildDepositResponsePayload({
            id: depositId,
            amount: totalAmount,
            unique_code: uniqueCode,
            status: 'Pending',
            created_at: createdAt
        }, methodRow, false));
    } catch (error) {
        if (inTransaction) {
            await client.query('ROLLBACK').catch(() => {});
            inTransaction = false;
        }
        if (error && error.code === '23505' && idempotencyKey) {
            try {
                const existingAfterRace = await findDepositByIdempotencyKey(client, userId, idempotencyKey);
                if (existingAfterRace) {
                    if (!matchesDepositIdempotencyPayload(existingAfterRace, baseAmount, methodRow, trimmedNote)) {
                        return res.status(409).json({
                            message: 'Idempotency-Key sudah digunakan untuk deposit dengan payload berbeda.'
                        });
                    }
                    return res.status(200).json(buildDepositResponsePayload(existingAfterRace, methodRow, true));
                }
            } catch (rereadErr) {
                console.error('Error re-reading deposit after 23505 race:', rereadErr);
            }
        }
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
        const sql = `SELECT id, amount, unique_code, status, method, note, created_at
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
// GET /api/admin/deposits — list semua deposit, optional ?status=Pending
app.get('/api/admin/deposits', protectAdmin, async (req, res) => {
    try {
        const statusFilter = req.query.status;
        const ALLOWED_STATUSES = ['Pending', 'Approved', 'Rejected'];
        let sql;
        let params = [];
        if (statusFilter && ALLOWED_STATUSES.includes(statusFilter)) {
            sql = `SELECT d.id, d.user_id, u.username, u.email, u.nomor_wa,
                          d.amount, d.unique_code, d.status, d.method, d.note,
                          d.created_at, d.updated_at
                   FROM deposits d
                   JOIN users u ON d.user_id = u.id
                   WHERE d.status = $1
                   ORDER BY d.created_at DESC
                   LIMIT 50`;
            params = [statusFilter];
        } else {
            sql = `SELECT d.id, d.user_id, u.username, u.email, u.nomor_wa,
                          d.amount, d.unique_code, d.status, d.method, d.note,
                          d.created_at, d.updated_at
                   FROM deposits d
                   JOIN users u ON d.user_id = u.id
                   ORDER BY d.created_at DESC
                   LIMIT 50`;
        }
        const { rows } = await pool.query(sql, params);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching deposits (admin):', error);
        res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
    }
});

// Backward-compat alias: /api/admin/deposits/pending masih bisa dipanggil
app.get('/api/admin/deposits/pending', protectAdmin, async (req, res) => {
    try {
        const sql = `SELECT d.id, d.user_id, u.username, u.email, u.nomor_wa,
                            d.amount, d.unique_code, d.status, d.created_at, d.updated_at
                     FROM deposits d
                     JOIN users u ON d.user_id = u.id
                     WHERE d.status = 'Pending'
                     ORDER BY d.created_at ASC
                     LIMIT 50`;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching pending deposits:', error);
        res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
    }
});

// POST /api/admin/deposits/approve — approve deposit Pending
app.post('/api/admin/deposits/approve', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const depositId = Number(req.body.depositId);
        if (!depositId || !Number.isFinite(depositId) || depositId <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Deposit ID tidak valid.' });
        }
        // Lock baris — cegah double approve (FOR UPDATE)
        const { rows: allRows } = await client.query(
            'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
            [depositId]
        );
        if (allRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Deposit tidak ditemukan.' });
        }
        const deposit = allRows[0];
        // Hanya Pending yang bisa di-approve
        if (deposit.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa approve ulang.`
            });
        }
        // Guard tambahan: cegah double-credit di balance_history (konsisten dengan endpoint bot)
        const referenceId = `DEPOSIT-${deposit.id}`;
        const { rows: existingCredit } = await client.query(
            "SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Deposit' LIMIT 1",
            [referenceId]
        );
        if (existingCredit && existingCredit.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: 'Deposit ini sudah pernah dikreditkan.'
            });
        }
        await client.query(
            "UPDATE deposits SET status = 'Approved', updated_at = NOW() WHERE id = $1",
            [depositId]
        );
        await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2',
            [deposit.amount, deposit.user_id]
        );
        const historyDesc = `Deposit #${deposit.id} disetujui admin`;
        await client.query(
            'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
            [deposit.user_id, deposit.amount, 'Deposit', historyDesc, referenceId]
        );
        await client.query('COMMIT');
        // Notifikasi async — tidak blok response
        createNotification(
            deposit.user_id,
            `Deposit #${deposit.id} sebesar Rp ${Number(deposit.amount).toLocaleString('id-ID')} telah disetujui dan masuk ke saldo.`
        ).catch(err => console.error('Notifikasi approve deposit gagal:', err));
        res.json({ message: `Deposit #${depositId} berhasil disetujui. Saldo user bertambah.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving deposit:', error);
        res.status(500).json({ message: 'Gagal menyetujui deposit.' });
    } finally {
        client.release();
    }
});

// POST /api/admin/deposits/reject — reject deposit Pending
app.post('/api/admin/deposits/reject', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const depositId = Number(req.body.depositId);
        if (!depositId || !Number.isFinite(depositId) || depositId <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Deposit ID tidak valid.' });
        }
        // Lock baris — cegah race condition
        const { rows: allRows } = await client.query(
            'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
            [depositId]
        );
        if (allRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Deposit tidak ditemukan.' });
        }
        const deposit = allRows[0];
        // Hanya Pending yang bisa di-reject
        if (deposit.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa reject.`
            });
        }
        await client.query(
            "UPDATE deposits SET status = 'Rejected', updated_at = NOW() WHERE id = $1",
            [depositId]
        );
        // TIDAK ada UPDATE balance, TIDAK ada INSERT balance_history
        await client.query('COMMIT');
        // Notifikasi async — tidak blok response
        createNotification(
            deposit.user_id,
            `Deposit #${deposit.id} sebesar Rp ${Number(deposit.amount).toLocaleString('id-ID')} ditolak. Hubungi admin untuk informasi lebih lanjut.`
        ).catch(err => console.error('Notifikasi reject deposit gagal:', err));
        res.json({ message: `Deposit #${depositId} berhasil ditolak.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error rejecting deposit:', error);
        res.status(500).json({ message: 'Gagal menolak deposit.' });
    } finally {
        client.release();
    }
});

// === ADMIN PAYMENT METHODS CRUD ===
app.get('/api/admin/payment-methods', protectAdmin, async (req, res) => {
    try {
        const sql = `SELECT id, code, name, type, account_number, account_name,
                            qris_image_url, instructions, is_qris, min_amount,
                            is_active, sort_order, created_at, updated_at
                     FROM payment_methods
                     ORDER BY sort_order ASC, id ASC`;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching admin payment methods:', error);
        res.status(500).json({ message: 'Gagal memuat daftar metode pembayaran.' });
    }
});

app.post('/api/admin/payment-methods', protectAdmin, async (req, res) => {
    const validated = normalizePaymentMethodPayload(req.body);
    if (validated.error) {
        return res.status(400).json({ message: validated.error });
    }
    const pm = validated.data;
    try {
        const sql = `INSERT INTO payment_methods (
                         code, name, type, account_number, account_name,
                         qris_image_url, instructions, is_qris, min_amount,
                         is_active, sort_order
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     RETURNING id, code, name, type, account_number, account_name,
                               qris_image_url, instructions, is_qris, min_amount,
                               is_active, sort_order, created_at, updated_at`;
        const params = [
            pm.code, pm.name, pm.type, pm.account_number, pm.account_name,
            pm.qris_image_url, pm.instructions, pm.is_qris, pm.min_amount,
            pm.is_active, pm.sort_order
        ];
        const { rows } = await pool.query(sql, params);
        res.status(201).json({
            message: 'Metode pembayaran berhasil ditambahkan.',
            paymentMethod: rows[0]
        });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ message: 'Kode metode pembayaran sudah digunakan.' });
        }
        console.error('Error creating payment method:', error);
        res.status(500).json({ message: 'Gagal menambahkan metode pembayaran.' });
    }
});

app.put('/api/admin/payment-methods/:id', protectAdmin, async (req, res) => {
    const methodId = parseInt(req.params.id, 10);
    if (!Number.isInteger(methodId) || methodId <= 0) {
        return res.status(400).json({ message: 'ID metode pembayaran tidak valid.' });
    }
    try {
        const existingRes = await pool.query('SELECT * FROM payment_methods WHERE id = $1 LIMIT 1', [methodId]);
        if (!existingRes || !existingRes.rows || existingRes.rows.length === 0) {
            return res.status(404).json({ message: 'Metode pembayaran tidak ditemukan.' });
        }
        const validated = normalizePaymentMethodPayload(req.body, existingRes.rows[0]);
        if (validated.error) {
            return res.status(400).json({ message: validated.error });
        }
        const pm = validated.data;
        const sql = `UPDATE payment_methods
                     SET code = $1,
                         name = $2,
                         type = $3,
                         account_number = $4,
                         account_name = $5,
                         qris_image_url = $6,
                         instructions = $7,
                         is_qris = $8,
                         min_amount = $9,
                         is_active = $10,
                         sort_order = $11,
                         updated_at = NOW()
                     WHERE id = $12
                     RETURNING id, code, name, type, account_number, account_name,
                               qris_image_url, instructions, is_qris, min_amount,
                               is_active, sort_order, created_at, updated_at`;
        const params = [
            pm.code, pm.name, pm.type, pm.account_number, pm.account_name,
            pm.qris_image_url, pm.instructions, pm.is_qris, pm.min_amount,
            pm.is_active, pm.sort_order, methodId
        ];
        const { rows } = await pool.query(sql, params);
        res.json({
            message: 'Metode pembayaran berhasil diperbarui.',
            paymentMethod: rows[0]
        });
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ message: 'Kode metode pembayaran sudah digunakan.' });
        }
        console.error('Error updating payment method:', error);
        res.status(500).json({ message: 'Gagal memperbarui metode pembayaran.' });
    }
});

app.delete('/api/admin/payment-methods/:id', protectAdmin, async (req, res) => {
    const methodId = parseInt(req.params.id, 10);
    if (!Number.isInteger(methodId) || methodId <= 0) {
        return res.status(400).json({ message: 'ID metode pembayaran tidak valid.' });
    }
    try {
        const { rows } = await pool.query('DELETE FROM payment_methods WHERE id = $1 RETURNING id, name', [methodId]);
        if (!rows || rows.length === 0) {
            return res.status(404).json({ message: 'Metode pembayaran tidak ditemukan.' });
        }
        res.json({ message: `Metode pembayaran "${rows[0].name}" berhasil dihapus.` });
    } catch (error) {
        console.error('Error deleting payment method:', error);
        res.status(500).json({ message: 'Gagal menghapus metode pembayaran.' });
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
        const numericAmount = Number(amount);
        if (!username || !description || !Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error('Input tidak valid.');
        const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
        if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = rows[0];
        if (Number(user.balance) < numericAmount) throw new Error('Saldo pengguna tidak mencukupi untuk dikurangi.');
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1', [numericAmount, user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [user.id, -numericAmount, 'Refund', description, `ADMIN_REDUCE-${Date.now()}`]);
        await client.query('COMMIT');
        res.json({ message: `Saldo akun ${username} berhasil dikurangi sebesar ${numericAmount}.` });
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
         const sqlProducts = `SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, p.status, p.validation_config, g.name as game_name 
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
        const activeFoxyKey = process.env.FOXY_API_KEY !== undefined ? process.env.FOXY_API_KEY : FOXY_API_KEY;
        if (!activeFoxyKey || !String(activeFoxyKey).trim()) {
            return res.status(400).json({
                message: 'FOXY_API_KEY belum diatur di file .env. Isi API key Foxy atau gunakan data seeder lokal untuk pengujian.'
            });
        }

        const rawMargin = req.body ? req.body.margin_percent : undefined;
        let effectiveMargin = null;

        if (rawMargin !== undefined && rawMargin !== null && String(rawMargin).trim() !== '') {
            const parsed = Number(rawMargin);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return res.status(400).json({ message: 'Persentase margin tidak valid.' });
            }
            effectiveMargin = parsed;
        } else {
            const { rows: roleRows } = await pool.query(
                "SELECT margin_percent FROM roles WHERE LOWER(name) = 'bronze' ORDER BY id ASC LIMIT 1"
            );
            effectiveMargin = roleRows.length > 0 && roleRows[0].margin_percent !== null
                ? Number(roleRows[0].margin_percent)
                : 10;
        }

        await syncProductsWithFoxy(effectiveMargin);
        invalidateFoxyProductCache();

        res.json({ message: `Sinkronisasi produk berhasil dipicu dengan margin ${effectiveMargin}%.` });
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
            const histDesc = `Refund admin untuk invoice ${tx.invoice_id}`;
            const rollbackResult = await rollbackTransactionResources(client, tx, {
                refundDescription: histDesc,
                abortIfAlreadyRefunded: true
            });
            if (rollbackResult.alreadyRefunded) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'Saldo untuk transaksi ini sudah pernah direfund sebelumnya.' });
            }
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
/**
 * Validasi dan sanitasi objek validation_config sebelum disimpan ke DB.
 * @param {*} validation_config - Input dari request body
 * @returns {{ error: string } | { safe: object|null }} error string jika tidak valid, atau safe config
 */
function sanitizeValidationConfig(validation_config) {
    // null / undefined → simpan null (hapus config)
    if (validation_config === null || validation_config === undefined) {
        return { safe: null };
    }
    if (typeof validation_config !== 'object' || Array.isArray(validation_config)) {
        return { error: 'validation_config harus berupa object atau null.' };
    }
    if (validation_config.enabled === true) {
        const validator = validation_config.validator;
        if (!validator || typeof validator !== 'string' || !validator.trim()) {
            return { error: 'validator wajib diisi jika enabled=true.' };
        }
        if (!/^[a-zA-Z0-9_\-]{1,80}$/.test(validator.trim())) {
            return { error: 'validator hanya boleh berisi huruf, angka, dash, underscore (maks. 80 karakter).' };
        }

        // === Validasi khusus Mobapay Eligibility ===
        if (validator.trim() === 'mobapay-mlbb-eligibility') {
            // country: opsional, jika ada harus 2–5 huruf
            if (validation_config.country !== undefined && validation_config.country !== null) {
                if (typeof validation_config.country !== 'string' || !/^[A-Za-z]{2,5}$/.test(validation_config.country)) {
                    return { error: 'country harus string kode negara 2–5 huruf (contoh: ID).' };
                }
            }
            // checks: opsional array string
            const VALID_MOBAPAY_CHECKS = ['wdp_available', 'double_diamond', 'weekly_elite', 'monthly_epic', 'payment_channel', 'region_id'];
            if (validation_config.checks !== undefined && validation_config.checks !== null) {
                if (!Array.isArray(validation_config.checks)) {
                    return { error: 'checks harus berupa array string.' };
                }
                for (const c of validation_config.checks) {
                    if (typeof c !== 'string' || !VALID_MOBAPAY_CHECKS.includes(c)) {
                        return { error: `checks mengandung nilai tidak valid: "${c}". Nilai yang diizinkan: ${VALID_MOBAPAY_CHECKS.join(', ')}.` };
                    }
                }
                // double_diamond wajib ada rules.target
                if (validation_config.checks.includes('double_diamond')) {
                    const target = validation_config.rules && validation_config.rules.target;
                    const VALID_DD = ['50+50', '150+150', '250+250', '500+500'];
                    if (!target || !VALID_DD.includes(target)) {
                        return { error: `double_diamond memerlukan rules.target yang valid. Nilai yang diizinkan: ${VALID_DD.join(', ')}.` };
                    }
                }
            }
            // rules.allowedPaymentCountries: jika ada harus array string country code
            if (validation_config.rules && validation_config.rules.allowedPaymentCountries !== undefined) {
                const apc = validation_config.rules.allowedPaymentCountries;
                if (!Array.isArray(apc)) {
                    return { error: 'rules.allowedPaymentCountries harus berupa array string.' };
                }
                for (const cc of apc) {
                    if (typeof cc !== 'string' || !/^[A-Za-z]{2,5}$/.test(cc)) {
                        return { error: `rules.allowedPaymentCountries mengandung nilai tidak valid: "${cc}".` };
                    }
                }
            }
        } else {
            // === Validasi PGS / validator lain (existing behavior) ===
            if (validation_config.rules !== undefined && validation_config.rules !== null) {
                if (typeof validation_config.rules !== 'object' || Array.isArray(validation_config.rules)) {
                    return { error: 'rules harus berupa object.' };
                }
                const safeRegion = /^[a-zA-Z0-9_\-]{1,10}$/;
                for (const field of ['allowedRegions', 'disallowedRegions']) {
                    const val = validation_config.rules[field];
                    if (val !== undefined && val !== null) {
                        if (!Array.isArray(val)) {
                            return { error: `rules.${field} harus berupa array string.` };
                        }
                        for (const region of val) {
                            if (typeof region !== 'string' || !safeRegion.test(region)) {
                                return { error: `rules.${field} mengandung nilai tidak valid: "${region}".` };
                            }
                        }
                    }
                }
            }
        }
    }
    // enabled=false atau tidak ada enabled: simpan apa adanya
    return { safe: validation_config };
}

app.put('/api/admin/products/:id/validation', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { validation_config } = req.body;

        const { error, safe: safeConfig } = sanitizeValidationConfig(validation_config);
        if (error) return res.status(400).json({ message: error });

        const { rowCount } = await pool.query(
            'UPDATE products SET validation_config = $1 WHERE id = $2',
            [safeConfig, id]
        );
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
        if (productIds.length > 500) {
            return res.status(400).json({ message: 'Maksimal 500 produk dalam satu batch.' });
        }
        // Pastikan setiap productId adalah angka positif
        const safeIds = productIds.map(id => Number(id));
        if (safeIds.some(id => !Number.isInteger(id) || id <= 0)) {
            return res.status(400).json({ message: 'Setiap productId harus berupa angka positif.' });
        }

        const { error, safe: safeConfig } = sanitizeValidationConfig(validation_config);
        if (error) return res.status(400).json({ message: error });

        const { rowCount } = await pool.query(
            'UPDATE products SET validation_config = $1 WHERE id = ANY($2::int[])',
            [safeConfig, safeIds]
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


// === ADMIN: Preview daftar service PGS terbaru (tidak menulis file) ===
app.get('/api/admin/validation-services/pgs-preview', protectAdmin, async (req, res) => {
    const pgsKey = process.env.PGS_KEY;
    const pgsApiKey = process.env.PGS_API_KEY;
    if (!pgsKey || !pgsApiKey) {
        return res.status(503).json({ message: 'PGS API Key belum dikonfigurasi di server.' });
    }
    try {
        const response = await axios.post(
            'https://pgscode.id/api/tools/run',
            { key: pgsKey, api_key: pgsApiKey, action: 'get-service' },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        const rawData = response.data;
        // Jangan forward key/api_key ke frontend — hanya kirim data service
        const services = rawData && rawData.data ? rawData.data : rawData;
        res.json({
            message: 'Preview daftar service PGS berhasil diambil. Data ini hanya untuk referensi, tidak disimpan otomatis.',
            count: Array.isArray(services) ? services.length : null,
            data: services
        });
    } catch (err) {
        console.warn('[pgs-preview] Gagal mengambil service PGS:', err && err.message);
        res.status(502).json({ message: 'Gagal mengambil data dari PGS. Coba lagi nanti.' });
    }
});

// Endpoint pre-validasi di halaman produk
// Phase 5C-2A HOTFIX: dispatch ke Mobapay eligibility engine jika validatornya bukan PGS
app.post('/api/products/:productId/validate', async (req, res) => {
    const { productId } = req.params;
    const { userId, zoneId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID wajib diisi.' });
    try {
        // HOTFIX: needs_server_id is on the games table, not products.
        // Use a LEFT JOIN so we never query a non-existent column on products.
        const { rows } = await pool.query(
            `SELECT
                p.id,
                p.name,
                p.validation_config,
                p.game_id,
                COALESCE(g.needs_server_id, false) AS needs_server_id
             FROM products p
             LEFT JOIN games g ON g.id = p.game_id
             WHERE p.id = $1`,
            [productId]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
        const config = rows[0].validation_config;

        // Tidak ada config atau config tidak aktif → tidak perlu validasi
        if (!config || config.enabled !== true || !config.validator) {
            return res.json({ success: true, message: 'Produk ini tidak memerlukan validasi.' });
        }

        const validatorName = String(config.validator).trim();
        const effectiveZoneId = rows[0].needs_server_id ? (zoneId || null) : null;

        // === Phase 5C-2A: Mobapay MLBB Eligibility ===
        if (validatorName === 'mobapay-mlbb-eligibility') {
            let mobapayResult;
            try {
                mobapayResult = await checkMobapayMlbbEligibility(
                    userId,
                    effectiveZoneId,
                    config.checks || [],
                    config.rules || {},
                    { country: config.country || 'ID', timeout: 10000 }
                );
            } catch (mobErr) {
                // Network/API fatal — kembalikan pesan aman
                console.warn('[pre-validate] Mobapay network error:', mobErr && mobErr.message);
                return res.status(503).json({
                    success: false,
                    message: 'Pengecekan promo sedang tidak tersedia, coba lagi nanti.'
                });
            }

            if (!mobapayResult.success) {
                const safeMsg = typeof mobapayResult.message === 'string' && mobapayResult.message.length > 0
                    ? mobapayResult.message
                    : 'Produk tidak tersedia untuk ID ini.';
                return res.status(400).json({ success: false, message: safeMsg });
            }

            // Sukses — kembalikan pesan aman; frontend akan tampilkan di blok "tidak memerlukan validasi"
            return res.json({
                success: true,
                message: 'ID valid dan produk tersedia untuk ID ini.',
                data: { mobapay: true }
            });
        }

        // === PGS Validator (existing behaviour) ===
        const result = await validateGameId(validatorName, userId, effectiveZoneId, config.rules || {});
        if (result.success) res.json(result);
        else res.status(400).json({ success: false, message: result.message });

    } catch (error) {
        logSafeError('[pre-validate] Error:', error);
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
                'SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND (user_id = $2 OR customer_game_id = $3)',
                [promo.id, client_user_id, target_game_id]
            );
            const userUsageCount = parseInt(usageRes.rows[0].count, 10);
            if (userUsageCount >= Number(rules.max_uses_per_user)) {
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
            `SELECT discount_price FROM flash_sales WHERE product_id = $1 AND is_active = true AND NOW() BETWEEN start_at AND end_at AND (max_uses IS NULL OR uses_count < max_uses) LIMIT 1`,
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
            if (rules.max_discount_amount && Number(rules.max_discount_amount) > 0 && discount > Number(rules.max_discount_amount)) {
                discount = Math.floor(Number(rules.max_discount_amount));
            }
        } else if (promo.type === 'fixed') {
            discount = Math.floor(Number(promo.value));
        }
        // Cap discount so final price is at least 1
        if (discount >= effectivePrice) {
            discount = effectivePrice - 1;
        }
        if (discount < 0) discount = 0;
        const finalPrice = effectivePrice - discount;

        // Konsisten dengan checkout (SEC-003): harga akhir setelah promo tidak boleh di bawah modal provider
        let providerCost = Number(product.price) || 0;
        try {
            const providerProducts = await getFoxyProducts();
            const currentFoxyProduct = providerProducts
                ? providerProducts.find(p => p.product_code === product.provider_sku)
                : null;
            if (currentFoxyProduct && Number.isFinite(Number(currentFoxyProduct.product_price))) {
                providerCost = Number(currentFoxyProduct.product_price);
            }
        } catch (_foxyErr) {
            // Fallback ke product.price lokal jika Foxy tidak dapat diakses saat validasi promo
        }
        if (finalPrice < providerCost) {
            return res.status(400).json({
                valid: false,
                message: 'Kode promo tidak dapat digunakan karena membuat harga akhir di bawah harga modal produk.'
            });
        }

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


// === PHASE 7A: WA BOT ADMIN READ-ONLY API ===

/**
 * Middleware: requireWaBotAdminToken
 *
 * Memeriksa header Authorization: Bearer <WA_BOT_ADMIN_TOKEN>.
 * - Jika env WA_BOT_ADMIN_TOKEN tidak dikonfigurasi → 503 (aman, tidak bocor info).
 * - Jika token tidak ada → 401.
 * - Jika token salah → 403 (constant-time compare untuk mencegah timing attack).
 * - Token tidak pernah dilog.
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

// GET /api/bot/admin/deposits/pending — daftar deposit Pending (read-only)
// Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
// Query: ?limit=10 (default 10, max 50)
app.get('/api/bot/admin/deposits/pending', requireWaBotAdminToken, async (req, res) => {
    try {
        // Limit: default 10, max 50
        const rawLimit = parseInt(req.query.limit, 10);
        const limit = (Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 50) ? rawLimit : 10;

        // READ-ONLY: hanya SELECT, tidak ada UPDATE/INSERT/DELETE
        const sql = `
            SELECT
                d.id,
                u.username,
                d.amount,
                d.unique_code,
                d.method,
                d.note,
                d.status,
                d.created_at
            FROM deposits d
            JOIN users u ON d.user_id = u.id
            WHERE d.status = 'Pending'
            ORDER BY d.created_at ASC
            LIMIT $1
        `;
        const { rows } = await pool.query(sql, [limit]);

        const deposits = rows.map(d => {
            const amountNum = Number(d.amount) || 0;
            const summaryText = `Deposit #${d.id} dari ${d.username} sebesar ${formatRupiahBot(amountNum)} via ${d.method || '-'}. Status: Pending.`;
            return {
                id:           d.id,
                username:     d.username,
                amount:       amountNum,
                unique_code:  d.unique_code,
                method:       d.method   || null,
                note:         d.note     || null,
                status:       d.status,
                created_at:   d.created_at,
                summary_text: summaryText
            };
        });

        return res.json({
            deposits,
            count:        deposits.length,
            generated_at: new Date().toISOString()
        });
    } catch (error) {
        logSafeError('[bot/admin/deposits/pending] Error:', error);
        res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data deposit.' });
    }
});

// GET /api/bot/admin/deposits/:id — detail satu deposit (read-only)
// Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
app.get('/api/bot/admin/deposits/:id', requireWaBotAdminToken, async (req, res) => {
    try {
        const depositId = parseInt(req.params.id, 10);
        if (!Number.isFinite(depositId) || depositId <= 0) {
            return res.status(400).json({ message: 'ID deposit tidak valid.' });
        }

        // READ-ONLY: hanya SELECT, tidak ada UPDATE/INSERT/DELETE
        const sql = `
            SELECT
                d.id,
                u.username,
                d.amount,
                d.unique_code,
                d.method,
                d.note,
                d.status,
                d.created_at,
                d.updated_at
            FROM deposits d
            JOIN users u ON d.user_id = u.id
            WHERE d.id = $1
            LIMIT 1
        `;
        const { rows } = await pool.query(sql, [depositId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Deposit tidak ditemukan.' });
        }

        const d = rows[0];
        const amountNum = Number(d.amount) || 0;
        const summaryText = `Deposit #${d.id} dari ${d.username} sebesar ${formatRupiahBot(amountNum)} via ${d.method || '-'}. Status: ${d.status}.`;

        return res.json({
            id:           d.id,
            username:     d.username,
            amount:       amountNum,
            unique_code:  d.unique_code,
            method:       d.method   || null,
            note:         d.note     || null,
            status:       d.status,
            created_at:   d.created_at,
            updated_at:   d.updated_at || null,
            summary_text: summaryText
        });
    } catch (error) {
        logSafeError('[bot/admin/deposits/:id] Error:', error);
        res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data deposit.' });
    }
});

// === PHASE 7B: WA BOT ADMIN DEPOSIT APPROVE/REJECT API ===

// POST /api/bot/admin/deposits/:id/approve — approve deposit Pending via WA bot
// Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
// Body (optional): { "note": "catatan admin" }
app.post('/api/bot/admin/deposits/:id/approve', requireWaBotAdminToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const depositId = parseInt(req.params.id, 10);
        if (!Number.isFinite(depositId) || depositId <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'ID deposit tidak valid.' });
        }

        // Lock baris — cegah double approve (FOR UPDATE)
        const { rows: allRows } = await client.query(
            `SELECT d.id, d.user_id, d.amount, d.unique_code, d.method, d.note, d.status, d.created_at,
                    u.username
             FROM deposits d
             JOIN users u ON d.user_id = u.id
             WHERE d.id = $1
             FOR UPDATE OF d`,
            [depositId]
        );

        if (allRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Deposit tidak ditemukan.' });
        }

        const deposit = allRows[0];

        // Hanya Pending yang bisa di-approve
        if (deposit.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa approve ulang.`
            });
        }

        // Guard tambahan: cek apakah balance_history sudah pernah dikreditkan
        const referenceId = `DEPOSIT-${deposit.id}`;
        const { rows: existingCredit } = await client.query(
            "SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Deposit' LIMIT 1",
            [referenceId]
        );
        if (existingCredit.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: 'Deposit ini sudah pernah dikreditkan.'
            });
        }

        // Update status deposit
        await client.query(
            "UPDATE deposits SET status = 'Approved', updated_at = NOW() WHERE id = $1",
            [depositId]
        );

        // Tambah saldo user
        await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2',
            [deposit.amount, deposit.user_id]
        );

        // Insert balance_history (simpan req.body.note jika ada)
        const adminNote = (req.body && typeof req.body.note === 'string') ? req.body.note.trim().slice(0, 200) : '';
        const historyDesc = adminNote
            ? `Deposit #${deposit.id} disetujui via WA bot (${adminNote})`
            : `Deposit #${deposit.id} disetujui via WA bot`;
        await client.query(
            'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
            [deposit.user_id, deposit.amount, 'Deposit', historyDesc, referenceId]
        );

        await client.query('COMMIT');

        // Notifikasi async — tidak blok response
        const amountNum = Number(deposit.amount) || 0;
        createNotification(
            deposit.user_id,
            `Deposit #${deposit.id} sebesar ${formatRupiahBot(amountNum)} telah disetujui dan masuk ke saldo.`
        ).catch(err => console.error('Notifikasi bot approve deposit gagal:', err));

        const summaryText = `✅ Deposit #${deposit.id} dari ${deposit.username} sebesar ${formatRupiahBot(amountNum)} via ${deposit.method || '-'} berhasil di-approve. Saldo user sudah ditambahkan.`;

        return res.json({
            success: true,
            message: `Deposit #${deposit.id} berhasil di-approve.`,
            deposit: {
                id:       deposit.id,
                username: deposit.username,
                amount:   amountNum,
                method:   deposit.method || null,
                status:   'Approved'
            },
            summary_text: summaryText
        });
    } catch (error) {
        await client.query('ROLLBACK');
        logSafeError('[bot/admin/deposits/:id/approve] Error:', error);
        res.status(500).json({ success: false, message: 'Gagal menyetujui deposit.' });
    } finally {
        client.release();
    }
});

// POST /api/bot/admin/deposits/:id/reject — reject deposit Pending via WA bot
// Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
// Body (optional): { "reason": "alasan reject" }
app.post('/api/bot/admin/deposits/:id/reject', requireWaBotAdminToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const depositId = parseInt(req.params.id, 10);
        if (!Number.isFinite(depositId) || depositId <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'ID deposit tidak valid.' });
        }

        // Lock baris — cegah race condition
        const { rows: allRows } = await client.query(
            `SELECT d.id, d.user_id, d.amount, d.unique_code, d.method, d.note, d.status, d.created_at,
                    u.username
             FROM deposits d
             JOIN users u ON d.user_id = u.id
             WHERE d.id = $1
             FOR UPDATE OF d`,
            [depositId]
        );

        if (allRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Deposit tidak ditemukan.' });
        }

        const deposit = allRows[0];

        // Hanya Pending yang bisa di-reject
        if (deposit.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa reject.`
            });
        }

        // Update status deposit — TIDAK update balance, TIDAK insert balance_history
        await client.query(
            "UPDATE deposits SET status = 'Rejected', updated_at = NOW() WHERE id = $1",
            [depositId]
        );

        await client.query('COMMIT');

        // Notifikasi async — tidak blok response
        const amountNum = Number(deposit.amount) || 0;
        const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 200) : '';
        const notifMessage = reason
            ? `Deposit #${deposit.id} sebesar ${formatRupiahBot(amountNum)} ditolak. Alasan: ${reason}`
            : `Deposit #${deposit.id} sebesar ${formatRupiahBot(amountNum)} ditolak. Hubungi admin untuk informasi lebih lanjut.`;
        createNotification(deposit.user_id, notifMessage)
            .catch(err => console.error('Notifikasi bot reject deposit gagal:', err));

        const summaryText = `❌ Deposit #${deposit.id} dari ${deposit.username} sebesar ${formatRupiahBot(amountNum)} via ${deposit.method || '-'} ditolak.`;

        return res.json({
            success: true,
            message: `Deposit #${deposit.id} berhasil ditolak.`,
            deposit: {
                id:       deposit.id,
                username: deposit.username,
                amount:   amountNum,
                method:   deposit.method || null,
                status:   'Rejected'
            },
            summary_text: summaryText
        });
    } catch (error) {
        await client.query('ROLLBACK');
        logSafeError('[bot/admin/deposits/:id/reject] Error:', error);
        res.status(500).json({ success: false, message: 'Gagal menolak deposit.' });
    } finally {
        client.release();
    }
});

// === ORDER & H2H HELPERS (3-Phase Architecture — SEC-013) ===
function isProviderTimeoutOrAmbiguous(providerError) {
    if (!providerError || providerError.isExplicitRejection) return false;
    const httpStatus = providerError.response && providerError.response.status;
    const errCode = providerError.code;
    return (
        errCode === 'ECONNABORTED' ||
        errCode === 'ETIMEDOUT' ||
        errCode === 'ECONNRESET' ||
        Boolean(providerError.message && /timeout/i.test(providerError.message)) ||
        httpStatus === 502 ||
        httpStatus === 503 ||
        httpStatus === 504
    );
}

/**
 * Fase (c): transaksi DB kedua setelah panggilan provider tanpa menahan koneksi di Fase (b).
 * Mempertahankan lock FOR UPDATE tanpa filter status agar aman terhadap balapan callback.
 */
async function finalizeOrderAfterProviderCall({
    invoiceId,
    providerTrxId,
    userId,
    finalPrice,
    appliedFlashSaleId,
    newTransactionId,
    shouldRollbackIfPending,
    logPrefix
}) {
    const client = await pool.connect();
    let inTransaction = false;
    let lockedTxStatus = null;
    try {
        await client.query('BEGIN');
        inTransaction = true;
        const { rows: lockedTxRows } = await client.query(
            'SELECT id, status, provider_trx_id, flash_sale_id, flash_sale_restored FROM transactions WHERE invoice_id = $1 FOR UPDATE',
            [invoiceId]
        );
        if (lockedTxRows && lockedTxRows.length === 1) {
            lockedTxStatus = lockedTxRows[0].status;
            // Simpan provider_trx_id tanpa menimpa status transaksi yang sudah dikunci
            await client.query(
                'UPDATE transactions SET provider_trx_id = COALESCE(provider_trx_id, $1), updated_at = NOW() WHERE invoice_id = $2',
                [providerTrxId, invoiceId]
            );
            if (shouldRollbackIfPending && ['Pending', 'Processing'].includes(lockedTxStatus)) {
                await rollbackTransactionResources(client, {
                    id: lockedTxRows[0].id || newTransactionId,
                    invoice_id: invoiceId,
                    user_id: userId,
                    price: finalPrice,
                    status: lockedTxStatus,
                    flash_sale_id: lockedTxRows[0].flash_sale_id !== undefined ? lockedTxRows[0].flash_sale_id : appliedFlashSaleId,
                    flash_sale_restored: lockedTxRows[0].flash_sale_restored
                }, {
                    refundDescription: `Refund otomatis karena gagal kirim ke provider (${invoiceId})`
                });
            }
        }
        await client.query('COMMIT');
        inTransaction = false;
    } catch (compErr) {
        if (inTransaction) {
            await client.query('ROLLBACK').catch(() => {});
            inTransaction = false;
        }
        const actionLabel = shouldRollbackIfPending ? 'Compensating refund' : 'Persisting provider_trx_id';
        console.error(`[CRITICAL] ${logPrefix} ${actionLabel} failed for invoice ${invoiceId}:`, safeErrorDetail(compErr));
    } finally {
        client.release();
    }
    return lockedTxStatus;
}

// === ORDER & H2H ENDPOINTS ===
app.post('/api/order', protect, async (req, res) => {
    try {
        const idempotencyKey = parseOptionalIdempotencyKeyHeader(req);
        const productId = Number(req.body.productId);
        const targetGameId = normalizeString(req.body.targetGameId, 80);
        const targetServerId = normalizeString(req.body.targetServerId, 80);
        const promoCode = req.body.promoCode ? String(req.body.promoCode).trim().toUpperCase() : null;
        const userId = req.user.id;

        if (!Number.isInteger(productId) || productId <= 0 || !targetGameId) throw new Error('Produk dan ID Game wajib diisi.');

        // Pre-check DB singkat: idempotency + lookup produk, lalu LEPAS koneksi sebelum HTTP eksternal
        let product;
        const preClient = await pool.connect();
        try {
            const earlyIdempotent = await resolveExistingIdempotentOrder(preClient, {
                channel: 'web',
                userId,
                idempotencyKey,
                keyLabel: 'Idempotency-Key',
                productId,
                targetGameId,
                targetServerId
            });
            if (earlyIdempotent) {
                return res.status(earlyIdempotent.statusCode).json(earlyIdempotent.body);
            }

            const productQuery = `
                SELECT p.*, g.id as game_id, g.needs_server_id,
                    gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM (SELECT * FROM products WHERE id = $1 AND status = 'Active') AS p
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE g.status = 'Active'
            `;
            const { rows: products } = await preClient.query(productQuery, [productId]);

            if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
            product = products[0];
        } finally {
            preClient.release();
        }

        if (product.needs_server_id && !targetServerId) throw new Error('Server ID wajib diisi untuk game ini.');

        // === PHASE 5B: VALIDASI ID GAME (0 koneksi DB ditahan) ===
        await validateOrderGameIdIfNeeded(product, targetGameId, targetServerId);
        // === AKHIR PHASE 5B ===

        // --- PRICE GUARD FETCH: Ambil harga provider real-time tanpa menahan koneksi DB ---
        let currentProviderCost = 0;
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
            currentProviderCost = Number(currentFoxyProduct.product_price);
        } catch (priceGuardErr) {
            if (priceGuardErr.message && (
                priceGuardErr.message.startsWith('Harga sedang diperbarui') ||
                priceGuardErr.message.startsWith('Harga produk sedang diperbarui') ||
                priceGuardErr.message.startsWith('Produk sedang tidak tersedia') ||
                priceGuardErr.message.startsWith('Terjadi perubahan harga')
            )) {
                throw priceGuardErr;
            }
            console.warn('[order] Provider check failed, blocking order:', safeAxiosError(priceGuardErr, 'Foxy'));
            throw new Error('Harga sedang diperbarui, coba lagi sebentar');
        }

        // === FASE (a): RESERVASI ATOMIK SINGKAT DI DATABASE ===
        let finalPrice;
        let appliedFlashSaleId = null;
        let finalTargetForDB;
        let invoiceId;
        let trx_id_provider;
        let newTransactionId = null;
        const client = await pool.connect();
        let inTransaction = false;
        try {
            await client.query('BEGIN');
            inTransaction = true;

            // --- LOGIKA HARGA FINAL TIGA LAPIS ---
            const { rows: users } = await client.query('SELECT balance, role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1 FOR UPDATE', [userId]);
            if (!users || users.length === 0) throw new Error('Pengguna tidak ditemukan.');
            const user = users[0];
            const userRoleName = user.role_name.toLowerCase();

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

            // --- FLASH SALE OVERRIDE (dengan FOR UPDATE & kuota max_uses) ---
            const { rows: flashSaleRows } = await client.query(
                `SELECT id, discount_price FROM flash_sales
                 WHERE product_id = $1 AND is_active = true
                   AND NOW() BETWEEN start_at AND end_at
                   AND (max_uses IS NULL OR uses_count < max_uses)
                 LIMIT 1 FOR UPDATE`,
                [productId]
            );
            if (flashSaleRows.length > 0) {
                const flashPrice = Number(flashSaleRows[0].discount_price);
                if (flashPrice > 0 && flashPrice < finalPrice) {
                    finalPrice = flashPrice;
                    appliedFlashSaleId = flashSaleRows[0].id || null;
                }
            }
            // --- AKHIR FLASH SALE OVERRIDE ---

            // Blokir jika harga prapromo sudah di bawah modal provider
            if (currentProviderCost > finalPrice) {
                console.warn(`[order] Price risk: Provider cost (${currentProviderCost}) > Final user price (${finalPrice}). SKU ${product.provider_sku}.`);
                invalidateFoxyProductCache();
                throw new Error('Harga sedang diperbarui, coba lagi sebentar');
            }

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
                        'SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND (user_id = $2 OR customer_game_id = $3)',
                        [promo.id, userId, targetGameId]
                    );
                    const usageCount = (usageRows && usageRows[0] && usageRows[0].count !== undefined)
                        ? parseInt(usageRows[0].count, 10)
                        : 0;
                    if (usageCount >= Number(rules.max_uses_per_user)) {
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
                    if (rules.max_discount_amount && Number(rules.max_discount_amount) > 0 && discount > Number(rules.max_discount_amount)) {
                        discount = Math.floor(Number(rules.max_discount_amount));
                    }
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

            // SEC-003: Validasi ulang harga akhir terhadap modal provider SETELAH diskon promo dihitung
            if (currentProviderCost > finalPrice) {
                if (appliedPromoId) {
                    console.warn(`[order] Promo cost guard blocked order: Final price (${finalPrice}) < Provider cost (${currentProviderCost}). SKU ${product.provider_sku}.`);
                    throw new Error('Kode promo tidak dapat digunakan karena membuat harga akhir di bawah harga modal produk.');
                }
                invalidateFoxyProductCache();
                throw new Error('Harga sedang diperbarui, coba lagi sebentar');
            }

            if (!isValidPriceAmount(finalPrice)) throw new Error('Harga produk tidak valid.');
            finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
            if (!idempotencyKey) {
                const duplicate = await findRecentPendingDuplicate(client, userId, productId, finalTargetForDB);
                if (duplicate) throw new Error(`Pesanan serupa masih pending (${duplicate.invoice_id}). Mohon tunggu sebelum mencoba lagi.`);
            }

            if (Number(user.balance) < finalPrice) throw new Error('Saldo Anda tidak mencukupi.');
            
            const deductRes = await client.query(
                'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
                [finalPrice, userId]
            );
            if (deductRes && typeof deductRes.rowCount === 'number' && deductRes.rowCount === 0) {
                throw new Error('Saldo Anda tidak mencukupi.');
            }
            
            invoiceId = generateInvoiceId('TRX');
            trx_id_provider = generateProviderTrxId('WEB');
            let txInsertRows;
            try {
                ({ rows: txInsertRows } = await insertTransactionRecord(client, {
                    invoiceId,
                    userId,
                    productId,
                    targetForDb: finalTargetForDB,
                    finalPrice,
                    providerTrxId: trx_id_provider,
                    flashSaleId: appliedFlashSaleId,
                    idempotencyKey
                }));
            } catch (insertErr) {
                if (insertErr && insertErr.code === '23505' && idempotencyKey) {
                    await client.query('ROLLBACK').catch(() => {});
                    inTransaction = false;
                    const raceResolved = await resolveExistingIdempotentOrder(client, {
                        channel: 'web',
                        userId,
                        idempotencyKey,
                        keyLabel: 'Idempotency-Key',
                        productId,
                        targetGameId,
                        targetServerId
                    });
                    if (raceResolved) {
                        return res.status(raceResolved.statusCode).json(raceResolved.body);
                    }
                }
                throw insertErr;
            }
            newTransactionId = (txInsertRows && txInsertRows[0]) ? txInsertRows[0].id : null;
            const historyDesc = `Pembelian produk: ${product.name} (${invoiceId})`;
            await client.query(
                'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                [userId, -finalPrice, 'Purchase', historyDesc, invoiceId]
            );

            if (appliedFlashSaleId) {
                await client.query(
                    'UPDATE flash_sales SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1',
                    [appliedFlashSaleId]
                );
            }

            if (appliedPromoId) {
                await client.query('UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1', [appliedPromoId]);
                await client.query(
                    'INSERT INTO promo_usages (promo_code_id, user_id, product_id, transaction_id, customer_game_id) VALUES ($1, $2, $3, $4, $5)',
                    [appliedPromoId, userId, productId, newTransactionId, targetGameId]
                );
            }

            // COMMIT fase reservasi saldo dan LEPAS koneksi DB sebelum memanggil API Foxy
            await client.query('COMMIT');
            inTransaction = false;
        } catch (phaseAError) {
            if (inTransaction) {
                await client.query('ROLLBACK').catch(() => {});
            }
            throw phaseAError;
        } finally {
            client.release();
        }

        // === FASE (b): DISPATCH PESANAN KE PROVIDER FOXY (0 koneksi DB ditahan) ===
        let providerSucceeded = false;
        let isTimeoutOrAmbiguous = false;
        try {
            const foxyRes = await axios.post(
                `${FOXY_BASE_URL}/v1/order`,
                { product_code: product.provider_sku, user_id: targetGameId, server_id: targetServerId || '', trx_id: trx_id_provider, callback_url: FOXY_CALLBACK_URL },
                { headers: { 'Authorization': FOXY_API_KEY, 'Content-Type': 'application/json' }, timeout: PROVIDER_TIMEOUT_MS }
            );
            if (foxyRes && foxyRes.data && foxyRes.data.status === false) {
                const rejectErr = new Error(foxyRes.data.message || 'Provider menolak pesanan.');
                rejectErr.isExplicitRejection = true;
                throw rejectErr;
            }
            providerSucceeded = true;
        } catch (providerError) {
            console.error('[order] Foxy order submission failed:', safeAxiosError(providerError, 'Foxy'));
            isTimeoutOrAmbiguous = isProviderTimeoutOrAmbiguous(providerError);
        }

        // === FASE (c): TRANSAKSI DB KEDUA — SIMPAN provider_trx_id ATAU KOMPENSASI ===
        const lockedTxStatus = await finalizeOrderAfterProviderCall({
            invoiceId,
            providerTrxId: trx_id_provider,
            userId,
            finalPrice,
            appliedFlashSaleId,
            newTransactionId,
            shouldRollbackIfPending: !providerSucceeded && !isTimeoutOrAmbiguous,
            logPrefix: '[order]'
        });

        if (providerSucceeded || isTimeoutOrAmbiguous || lockedTxStatus === 'Success') {
            if (!providerSucceeded && isTimeoutOrAmbiguous) {
                console.warn(`[order] Timeout/ambiguous response for invoice ${invoiceId} (${trx_id_provider}). Keeping status Pending for cron reconciliation.`);
            }
            return res.status(201).json({ message: 'Pesanan Anda sedang diproses!', invoiceId });
        }

        throw new Error('Gagal mengirim pesanan ke provider. Saldo tidak dipotong.');

    } catch (error) {
        logSafeError("Order error:", error);
        const statusCode = error && [400, 409, 429].includes(error.statusCode) ? error.statusCode : 400;
        res.status(statusCode).json({ message: getSafeOrderErrorMessage(error, 'Gagal memproses transaksi.') });
    }
});

const callbackVerificationCooldown = new Map();
const callbackClock = {
    now: () => Date.now()
};

function clearCallbackCooldownCache() {
    callbackVerificationCooldown.clear();
}

function extractCallbackToken(req) {
    const headerToken = req.headers && req.headers['x-callback-token'];
    if (typeof headerToken === 'string' && headerToken.trim()) {
        return headerToken.trim();
    }
    const queryToken = req.query && req.query.token;
    if (typeof queryToken === 'string' && queryToken.trim()) {
        return queryToken.trim();
    }
    return '';
}

function verifyFoxyCallbackAuth(req) {
    const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const currentSecret = (process.env.FOXY_CALLBACK_SECRET || '').trim();
    const previousSecret = (process.env.FOXY_CALLBACK_SECRET_PREVIOUS || '').trim();
    const allowInsecureLocal = !isProduction && String(process.env.ALLOW_INSECURE_CALLBACK || '').toLowerCase() === 'true';

    if (!currentSecret) {
        return allowInsecureLocal;
    }

    const providedToken = extractCallbackToken(req);
    if (!providedToken) {
        return false;
    }

    const matchCurrent = timingSafeStringEqual(providedToken, currentSecret);
    const matchPrevious = previousSecret ? timingSafeStringEqual(providedToken, previousSecret) : false;
    return matchCurrent || matchPrevious;
}

function checkAndMarkCallbackCooldown(trxId) {
    const nowMs = callbackClock.now();
    const lastVerifiedAt = callbackVerificationCooldown.get(trxId);
    if (lastVerifiedAt !== undefined && (nowMs - lastVerifiedAt) < CALLBACK_VERIFY_COOLDOWN_MS) {
        return false;
    }
    if (callbackVerificationCooldown.size > 1000) {
        for (const [key, ts] of callbackVerificationCooldown.entries()) {
            if ((nowMs - ts) >= CALLBACK_VERIFY_COOLDOWN_MS) {
                callbackVerificationCooldown.delete(key);
            }
        }
    }
    callbackVerificationCooldown.set(trxId, nowMs);
    return true;
}

function doesFoxyStatusMatchDb(foxyData, tx, preTx, productRow) {
    const verifiedTrxId = foxyData && foxyData.trx_id != null ? String(foxyData.trx_id).trim() : '';
    const expectedTrxId = tx && tx.provider_trx_id != null ? String(tx.provider_trx_id).trim() : '';
    if (verifiedTrxId && expectedTrxId && verifiedTrxId !== expectedTrxId) {
        return { ok: false, reason: 'trx_id mismatch' };
    }

    const verifiedSkuRaw = foxyData ? (foxyData.product_code ?? foxyData.sku ?? foxyData.code) : null;
    const verifiedSku = verifiedSkuRaw != null && String(verifiedSkuRaw).trim() !== ''
        ? String(verifiedSkuRaw).trim()
        : null;
    const expectedSku = (productRow && productRow.provider_sku) || (preTx && preTx.provider_sku) || null;
    if (verifiedSku && expectedSku && verifiedSku !== String(expectedSku).trim()) {
        return { ok: false, reason: 'SKU mismatch' };
    }

    // Catatan skema: kolom harga modal saat order dibuat belum ada di tabel `transactions`
    // (`transactions.price` adalah harga jual ke user/reseller, bukan harga modal provider).
    // Jangan membandingkan nominal terhadap `products.price` saat ini yang bisa berubah sewaktu-waktu.

    return { ok: true };
}

app.post('/api/foxy/callback', async (req, res) => {
    // Lapis 1: Fail-closed auth validation via ?token= or X-Callback-Token (supports secret rotation)
    if (!verifyFoxyCallbackAuth(req)) {
        return res.status(403).json({ message: 'Token callback tidak valid.' });
    }

    // Lapis 2: Zero-Trust Payload — hanya membaca trx_id dari req.body (abaikan status/sn/message dari body)
    const trx_id = normalizeString(req.body && req.body.trx_id, 255);
    const maskedTrx = trx_id ? `...${trx_id.slice(-8)}` : 'kosong';
    console.log(`Callback Foxy diterima untuk trx_id: ${maskedTrx}`);

    if (!trx_id) {
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }

    // Pre-check non-locking sebelum memanggil Foxy agar transaksi final/tidak dikenal & cooldown tidak menghabiskan kuota API
    let preTx = null;
    try {
        const preRes = await pool.query(
            `SELECT t.id, t.status, t.price, t.product_id, t.provider_trx_id,
                    p.provider_sku
             FROM transactions t
             LEFT JOIN products p ON p.id = t.product_id
             WHERE t.provider_trx_id = $1`,
            [trx_id]
        );
        preTx = preRes && preRes.rows && preRes.rows[0] ? preRes.rows[0] : null;
    } catch (preCheckErr) {
        logSafeError('[callback] Gagal melakukan pre-check transaksi:', preCheckErr);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }

    if (!preTx) {
        console.log(`Callback untuk provider_trx_id ${maskedTrx} tidak ditemukan.`);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }
    if (!['Pending', 'Processing'].includes(preTx.status)) {
        console.log(`Callback untuk provider_trx_id ${maskedTrx} diabaikan karena status sudah ${preTx.status}.`);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }
    if (!checkAndMarkCallbackCooldown(trx_id)) {
        console.log(`[callback] Cooldown verifikasi aktif untuk trx_id ${maskedTrx}, panggilan ke Foxy dilewati.`);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }

    // Lapis 3: Zero-Trust re-verification ke GET /v1/status/:trx_id di luar DB lock
    let foxyData = null;
    try {
        const foxyStatusRes = await axios.get(
            `${FOXY_BASE_URL}/v1/status/${encodeURIComponent(trx_id)}`,
            {
                headers: {
                    'Authorization': FOXY_API_KEY,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                    'Referer': 'https://www.foxygamestore.com/'
                },
                timeout: PROVIDER_TIMEOUT_MS
            }
        );
        foxyData = foxyStatusRes && foxyStatusRes.data && foxyStatusRes.data.data;
    } catch (verifyErr) {
        console.error('[callback] Gagal re-verify status ke Foxy:', safeAxiosError(verifyErr, 'Foxy'));
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }

    if (!foxyData || !foxyData.status) {
        console.warn(`[callback] Respons status Foxy tidak lengkap untuk trx_id ${maskedTrx}.`);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }

    const verifiedStatus = String(foxyData.status).toUpperCase();
    if (!['SUCCESS', 'FAILED', 'REFUNDED', 'PENDING', 'PARTIAL_REFUND'].includes(verifiedStatus)) {
        console.warn(`[callback] Status provider tidak dikenal untuk trx_id ${maskedTrx}.`);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }
    if (verifiedStatus === 'PENDING') {
        console.log(`Transaksi ${maskedTrx} masih pending dari verifikasi provider.`);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    }

    const verifiedSn = normalizeString(String(foxyData.sn || foxyData.serial_number || foxyData.provider_sn || ''), 500) || null;
    const verifiedMessage = normalizeString(String(foxyData.message || foxyData.note || ''), 300);

    const client = await pool.connect();
    let committedStatus = null;
    let tx = null;
    let finalSerialNumber = null;
    try {
        await client.query('BEGIN');

        const { rows: transactions } = await client.query('SELECT * FROM transactions WHERE provider_trx_id = $1 FOR UPDATE', [trx_id]);
        if (transactions.length === 0) {
            console.log(`Callback untuk provider_trx_id ${maskedTrx} tidak ditemukan saat lock.`);
            await client.query('ROLLBACK');
            return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
        }
        tx = transactions[0];
        if (!['Pending', 'Processing'].includes(tx.status)) {
            console.log(`Callback untuk provider_trx_id ${maskedTrx} diabaikan karena status sudah ${tx.status}.`);
            await client.query('ROLLBACK');
            return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
        }

        let productRow = null;
        if (tx.product_id) {
            const prodRes = await client.query('SELECT provider_sku FROM products WHERE id = $1', [tx.product_id]);
            productRow = prodRes && prodRes.rows && prodRes.rows[0] ? prodRes.rows[0] : null;
        }
        const crossCheck = doesFoxyStatusMatchDb(foxyData, tx, preTx, productRow);
        if (!crossCheck.ok) {
            console.warn(`[callback] Cross-check gagal: invoice=${tx.invoice_id || 'unknown'} reason=${crossCheck.reason}`);
            await client.query('ROLLBACK');
            return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
        }

        if (verifiedStatus === 'SUCCESS') {
            committedStatus = 'Success';
            const providerSn = verifiedSn;
            finalSerialNumber = providerSn || 'Tidak ada SN';
            if (providerSn) {
                await client.query('UPDATE transactions SET status = \'Success\', provider_sn = $1, updated_at = NOW() WHERE id = $2', [providerSn, tx.id]);
            } else {
                await client.query('UPDATE transactions SET status = \'Success\', updated_at = NOW() WHERE id = $1', [tx.id]);
            }
            await createNotification(tx.user_id, `Pesanan ${tx.invoice_id} telah berhasil diproses.`, `/invoice.html?id=${tx.invoice_id}`);
        } else if (verifiedStatus === 'FAILED' || verifiedStatus === 'REFUNDED') {
            committedStatus = 'Failed';
            finalSerialNumber = 'Tidak ada SN';
            await rollbackTransactionResources(client, tx, {
                refundDescription: `Pengembalian dana untuk invoice ${tx.invoice_id} karena: ${verifiedMessage || 'Transaksi gagal dari provider'}`
            });
            await createNotification(tx.user_id, `Pesanan ${tx.invoice_id} gagal. Saldo telah dikembalikan.`, `/invoice.html?id=${tx.invoice_id}`);
        } else if (verifiedStatus === 'PARTIAL_REFUND') {
            committedStatus = 'Partial Refund';
            finalSerialNumber = 'Tidak ada SN';
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

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        logSafeError('Callback error:', error);
        return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
    } finally {
        client.release();
    }

    // Teruskan webhook ke h2h_callback_url jika transaksi H2H selesai lewat callback (samakan dengan cronUtils.js)
    if (committedStatus && tx) {
        try {
            const metaRes = await pool.query(
                `SELECT u.h2h_callback_url, u.h2h_webhook_secret, p.name AS product_name
                 FROM users u
                 LEFT JOIN products p ON p.id = $2
                 WHERE u.id = $1`,
                [tx.user_id, tx.product_id]
            );
            const meta = metaRes && metaRes.rows && metaRes.rows[0];
            if (meta && meta.h2h_callback_url) {
                const webhookPayload = {
                    invoice_id: tx.invoice_id,
                    status: committedStatus,
                    product_name: meta.product_name || '',
                    price: tx.price,
                    serial_number: finalSerialNumber || 'Tidak ada SN',
                    timestamp: new Date().toISOString()
                };
                void dispatchSafeH2HWebhook({
                    dbPool: pool,
                    userId: tx.user_id,
                    callbackUrl: meta.h2h_callback_url,
                    webhookSecret: meta.h2h_webhook_secret,
                    payload: webhookPayload,
                    invoiceId: tx.invoice_id,
                    source: 'callback'
                });
            }
        } catch (webhookErr) {
            logSafeError('[callback] Error preparing H2H webhook:', webhookErr);
        }
    }

    return res.status(200).json(CALLBACK_SUCCESS_RESPONSE);
});

app.post('/h2h/order', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
    try {
        const refId = parseOptionalRefId(req.body.ref_id);
        const productId = Number(req.body.productId);
        const targetGameId = normalizeString(req.body.targetGameId, 80);
        const targetServerId = normalizeString(req.body.targetServerId, 80);
        const h2hUser = req.user; // User didapat dari middleware protectH2H

        if (!Number.isInteger(productId) || productId <= 0 || !targetGameId) {
            throw new Error('productId dan targetGameId wajib diisi.');
        }

        // Pre-check DB singkat: idempotency + lookup produk, lalu LEPAS koneksi sebelum HTTP eksternal
        let product;
        const preClient = await pool.connect();
        try {
            const earlyIdempotent = await resolveExistingIdempotentOrder(preClient, {
                channel: 'h2h',
                userId: h2hUser.id,
                idempotencyKey: refId,
                keyLabel: 'ref_id',
                productId,
                targetGameId,
                targetServerId
            });
            if (earlyIdempotent) {
                return res.status(earlyIdempotent.statusCode).json(earlyIdempotent.body);
            }

            const productQuery = `
                SELECT p.*, g.id as game_id, g.needs_server_id,
                       gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM products p 
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE p.id = $1 AND p.status = 'Active' AND g.status = 'Active'
            `;
            const { rows: products } = await preClient.query(productQuery, [productId]);

            if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
            product = products[0];
        } finally {
            preClient.release();
        }

        if (product.needs_server_id && !targetServerId) {
            throw new Error('Server ID wajib diisi untuk game ini.');
        }

        // === PHASE 5B: VALIDASI ID GAME H2H (0 koneksi DB ditahan) ===
        await validateOrderGameIdIfNeeded(product, targetGameId, targetServerId);
        // === AKHIR PHASE 5B ===

        // --- PRICE GUARD H2H FETCH (0 koneksi DB ditahan) ---
        let currentProviderCost = 0;
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
            currentProviderCost = Number(currentFoxyProduct.product_price);
        } catch (priceGuardErr) {
            if (priceGuardErr.message && (
                priceGuardErr.message.startsWith('Harga sedang diperbarui') ||
                priceGuardErr.message.startsWith('Harga produk sedang diperbarui') ||
                priceGuardErr.message.startsWith('Produk sedang tidak tersedia') ||
                priceGuardErr.message.startsWith('Terjadi perubahan harga')
            )) {
                throw priceGuardErr;
            }
            console.warn('[h2h-order] Provider check failed, blocking order:', safeAxiosError(priceGuardErr, 'Foxy'));
            throw new Error('Harga sedang diperbarui, coba lagi sebentar');
        }

        // === FASE (a): RESERVASI ATOMIK SINGKAT DI DATABASE ===
        let finalPrice;
        let appliedFlashSaleId = null;
        let finalTargetForDB;
        let invoiceId;
        let trx_id_provider;
        let newH2hTransactionId = null;
        const client = await pool.connect();
        let inTransaction = false;
        try {
        await client.query('BEGIN');
        inTransaction = true;

        // 2. Ambil User H2H
        const { rows: users } = await client.query('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE', [h2hUser.id]);
        if (!users || users.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const userForTx = users[0];
        const userRoleName = h2hUser.role_name.toLowerCase();

        // --- LOGIKA HARGA FINAL ---
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
        
        // --- FLASH SALE OVERRIDE (dengan FOR UPDATE & kuota max_uses) ---
        appliedFlashSaleId = null;
        const { rows: h2hFlashSaleRows } = await client.query(
            `SELECT id, discount_price FROM flash_sales
             WHERE product_id = $1 AND is_active = true
               AND NOW() BETWEEN start_at AND end_at
               AND (max_uses IS NULL OR uses_count < max_uses)
             LIMIT 1 FOR UPDATE`,
            [productId]
        );
        if (h2hFlashSaleRows.length > 0) {
            const flashPrice = Number(h2hFlashSaleRows[0].discount_price);
            if (flashPrice > 0 && flashPrice < finalPrice) {
                finalPrice = flashPrice;
                appliedFlashSaleId = h2hFlashSaleRows[0].id || null;
            }
        }

        if (currentProviderCost > finalPrice) {
            console.warn(`[h2h-order] Price risk: Cost (${currentProviderCost}) > Final price (${finalPrice}). SKU ${product.provider_sku}.`);
            invalidateFoxyProductCache();
            throw new Error('Harga sedang diperbarui, coba lagi sebentar');
        }

        if (!isValidPriceAmount(finalPrice)) throw new Error('Harga produk tidak valid.');

        // Kuota harian H2H opsional via env (nonaktif by default kecuali diaktifkan > 0)
        const maxDailyOrders = parsePositiveQuota(process.env.H2H_DAILY_MAX_ORDERS);
        const maxDailyAmount = parsePositiveQuota(process.env.H2H_DAILY_MAX_AMOUNT);
        if (maxDailyOrders !== null || maxDailyAmount !== null) {
            const { rows: quotaRows } = await client.query(
                `SELECT COUNT(*)::int AS order_count, COALESCE(SUM(price), 0)::bigint AS total_amount
                 FROM transactions
                 WHERE user_id = $1
                   AND invoice_id LIKE 'H2H-%'
                   AND created_at >= DATE_TRUNC('day', NOW())
                   AND status IN ('Pending', 'Processing', 'Success')`,
                [h2hUser.id]
            );
            const usage = quotaRows[0] || { order_count: 0, total_amount: 0 };
            const currentCount = Number(usage.order_count || 0);
            const currentAmount = Number(usage.total_amount || 0);

            if (maxDailyOrders !== null && currentCount + 1 > maxDailyOrders) {
                const quotaErr = new Error('Kuota transaksi harian H2H Anda telah tercapai.');
                quotaErr.statusCode = 429;
                throw quotaErr;
            }
            if (maxDailyAmount !== null && currentAmount + finalPrice > maxDailyAmount) {
                const amountErr = new Error('Batas nominal transaksi harian H2H Anda telah tercapai.');
                amountErr.statusCode = 429;
                throw amountErr;
            }
        }

        finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
        if (!refId) {
            const duplicate = await findRecentPendingDuplicate(client, h2hUser.id, productId, finalTargetForDB);
            if (duplicate) throw new Error(`Pesanan serupa masih pending (${duplicate.invoice_id}). Mohon tunggu sebelum mencoba lagi.`);
        }

        if (Number(userForTx.balance) < finalPrice) throw new Error('Saldo H2H Anda tidak mencukupi.');
        
        const deductRes = await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
            [finalPrice, h2hUser.id]
        );
        if (deductRes && typeof deductRes.rowCount === 'number' && deductRes.rowCount === 0) {
            throw new Error('Saldo H2H Anda tidak mencukupi.');
        }

        invoiceId = generateInvoiceId('H2H');
        trx_id_provider = generateProviderTrxId('H2H-PROVIDER');

        let h2hTxInsertRows;
        try {
            ({ rows: h2hTxInsertRows } = await insertTransactionRecord(client, {
                invoiceId,
                userId: h2hUser.id,
                productId,
                targetForDb: finalTargetForDB,
                finalPrice,
                providerTrxId: trx_id_provider,
                flashSaleId: appliedFlashSaleId,
                idempotencyKey: refId
            }));
        } catch (insertErr) {
            if (insertErr && insertErr.code === '23505' && refId) {
                await client.query('ROLLBACK').catch(() => {});
                inTransaction = false;
                const raceResolved = await resolveExistingIdempotentOrder(client, {
                    channel: 'h2h',
                    userId: h2hUser.id,
                    idempotencyKey: refId,
                    keyLabel: 'ref_id',
                    productId,
                    targetGameId,
                    targetServerId
                });
                if (raceResolved) {
                    return res.status(raceResolved.statusCode).json(raceResolved.body);
                }
            }
            throw insertErr;
        }
        newH2hTransactionId = (h2hTxInsertRows && h2hTxInsertRows[0]) ? h2hTxInsertRows[0].id : null;

        const historyDesc = `Pembelian H2H: ${product.name} (${invoiceId})`;
        await client.query(
            'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
            [h2hUser.id, -finalPrice, 'Purchase', historyDesc, invoiceId]
        );

        if (appliedFlashSaleId) {
            await client.query(
                'UPDATE flash_sales SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1',
                [appliedFlashSaleId]
            );
        }

        // COMMIT fase reservasi saldo dan LEPAS koneksi DB sebelum memanggil API Foxy
        await client.query('COMMIT');
        inTransaction = false;
        } catch (phaseAError) {
            if (inTransaction) {
                await client.query('ROLLBACK').catch(() => {});
            }
            throw phaseAError;
        } finally {
            client.release();
        }

        // === FASE (b): DISPATCH PESANAN KE PROVIDER FOXY (0 koneksi DB ditahan) ===
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

        let providerSucceeded = false;
        let isTimeoutOrAmbiguous = false;
        try {
            const foxyRes = await axios.post(`${FOXY_BASE_URL}/v1/order`, foxyPayload, { ...foxyConfigHeaders, timeout: PROVIDER_TIMEOUT_MS });
            if (foxyRes && foxyRes.data && foxyRes.data.status === false) {
                const rejectErr = new Error(foxyRes.data.message || 'Provider menolak pesanan.');
                rejectErr.isExplicitRejection = true;
                throw rejectErr;
            }
            providerSucceeded = true;
        } catch (providerError) {
            console.error('[h2h-order] Foxy order submission failed:', safeAxiosError(providerError, 'Foxy'));
            isTimeoutOrAmbiguous = isProviderTimeoutOrAmbiguous(providerError);
        }

        // === FASE (c): TRANSAKSI DB KEDUA — SIMPAN provider_trx_id ATAU KOMPENSASI ===
        const lockedTxStatus = await finalizeOrderAfterProviderCall({
            invoiceId,
            providerTrxId: trx_id_provider,
            userId: h2hUser.id,
            finalPrice,
            appliedFlashSaleId,
            newTransactionId: newH2hTransactionId,
            shouldRollbackIfPending: !providerSucceeded && !isTimeoutOrAmbiguous,
            logPrefix: '[h2h-order]'
        });

        if (providerSucceeded || isTimeoutOrAmbiguous || lockedTxStatus === 'Success') {
            if (!providerSucceeded && isTimeoutOrAmbiguous) {
                console.warn(`[h2h-order] Timeout/ambiguous response for invoice ${invoiceId} (${trx_id_provider}). Keeping status Pending for cron reconciliation.`);
            }
            return res.status(201).json({
                success: true,
                message: 'Pesanan H2H Anda sedang diproses!',
                data: {
                    invoiceId: invoiceId,
                    status: lockedTxStatus === 'Success' ? 'Success' : 'Pending',
                    productName: product.name,
                    target: finalTargetForDB,
                    price: finalPrice
                }
            });
        }

        throw new Error('Gagal mengirim pesanan ke provider. Saldo tidak dipotong.');

    } catch (error) {
        logSafeError("H2H Order error:", error);
        const statusCode = error && [400, 409, 429].includes(error.statusCode) ? error.statusCode : 400;
        res.status(statusCode).json({ success: false, message: getSafeOrderErrorMessage(error, 'Gagal memproses transaksi H2H.') });
    }
});

app.get('/h2h/products', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
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

app.put('/h2h/profile/callback', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {
    try {
        const callback_url = normalizeString(req.body.callback_url, 2048);
        if (!callback_url) {
            return res.status(400).json({ success: false, message: 'URL callback tidak valid.' });
        }
        try {
            await validateWebhookUrl(callback_url);
        } catch (_ssrfErr) {
            return res.status(400).json({ success: false, message: 'URL callback tidak valid.' });
        }
        
        await pool.query('UPDATE users SET h2h_callback_url = $1 WHERE id = $2', [callback_url, req.user.id]);
        
        res.json({ success: true, message: 'Callback URL berhasil diperbarui.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memperbarui callback URL.' });
    }
});

app.get('/h2h/profile', protectH2HIp, protectH2H, h2hUserLimiter, async (req, res) => {

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

module.exports = { app, pool, startServer, server, validateEnvironment, invalidateFoxyProductCache, callbackClock, clearCallbackCooldownCache };
