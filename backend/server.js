const {
    PORT,
    FOXY_API_KEY,
    FOXY_CALLBACK_URL,
    validateEnvironment,
} = require('./config/env');
const {
    MAX_BODY_SIZE,
    DUPLICATE_ORDER_WINDOW_SECONDS,
    FOXY_BASE_URL,
    PROVIDER_TIMEOUT_MS,
    FOXY_CACHE_TTL,
    CALLBACK_VERIFY_COOLDOWN_MS,
    CALLBACK_SUCCESS_RESPONSE,
} = require('./config/constants');
const {
    safeErrorDetail,
    logSafeError,
    safeAxiosError,
} = require('./utils/logger');
const { normalizeString } = require('./utils/strings');
const {
    timingSafeStringEqual,
    generateInvoiceId,
    generateProviderTrxId,
} = require('./utils/crypto');
const {
    parsePositiveQuota,
    isValidPriceAmount,
    parseOptionalRefId,
    parseOptionalIdempotencyKeyHeader,
} = require('./utils/validation');
const { securityHeaders, corsMiddleware } = require('./middleware/securityHeaders');
const { createRateLimiters } = require('./middleware/rateLimiters');
const { createAuthMiddleware } = require('./middleware/auth');
const { createH2HAuthMiddleware } = require('./middleware/h2hAuth');
const { requireWaBotAdminToken } = require('./middleware/waBotAuth');
const createAuthRoutes = require('./routes/auth.routes');
const createDepositRoutes = require('./routes/deposit.routes');
const createPublicRoutes = require('./routes/public.routes');
const createUserRoutes = require('./routes/user.routes');
const createUserApiKeyRoutes = require('./routes/userApiKey.routes');
const createWaBotRoutes = require('./routes/waBot.routes');
const createAdminDepositsRoutes = require('./routes/admin/deposits.routes');
const createAdminBalanceRoutes = require('./routes/admin/balance.routes');
const createAdminTransactionsRoutes = require('./routes/admin/transactions.routes');
const createAdminPaymentMethodsRoutes = require('./routes/admin/paymentMethods.routes');
const createAdminGamesRoutes = require('./routes/admin/games.routes');
const createAdminProductsRoutes = require('./routes/admin/products.routes');
const createAdminPromosRoutes = require('./routes/admin/promos.routes');
const createAdminFlashSalesRoutes = require('./routes/admin/flashSales.routes');
const createAdminMarginsRoutes = require('./routes/admin/margins.routes');
const express = require('express');
const fs = require('fs').promises;
const { createPool } = require('./config/db');
const axios = require('axios');
const { validateWebhookUrl, dispatchSafeH2HWebhook } = require('./utils/webhookClient.js');
const { syncProductsWithFoxy, rollbackTransactionResources } = require('./utils/cronUtils.js');
const { validateGameId } = require('./utils/validators/cek-id-game.js');
const { checkAllMobapayPromosML, checkMobapayMlbbEligibility } = require('./utils/validators/stalk-ml-promo.js');
const { cekPromoMcggMobapay } = require('./utils/validators/stalk-mcgg.js');
const {
    validateOrderGameIdIfNeeded,
    invalidateFoxyProductCache,
    getFoxyProducts,
} = require('./services/foxyClient');
const {
    getGameProductsCatalog,
    validatePromoCodeForProduct,
} = require('./services/priceService');
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
app.use(createAuthRoutes({ pool }));

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
app.use(createUserApiKeyRoutes({ pool, protect }));

// === DEPOSIT & PAYMENT METHOD ENDPOINTS ===

app.use(createDepositRoutes({ pool, protect }));

// === ADMIN ENDPOINTS ===
app.use(createAdminDepositsRoutes({ pool, protectAdmin, createNotification }));
app.use(createAdminPaymentMethodsRoutes({ pool, protectAdmin }));

app.use(createAdminBalanceRoutes({ pool, protectAdmin }));
app.use(createAdminGamesRoutes({ pool, protectAdmin }));
app.use(createAdminProductsRoutes({ pool, protectAdmin }));
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

app.use(createAdminTransactionsRoutes({
    pool,
    protectAdmin,
    createNotification,
    rollbackTransactionResources,
}));
app.use(createAdminPromosRoutes({ pool, protectAdmin }));
app.use(createAdminFlashSalesRoutes({ pool, protectAdmin }));
app.use(createAdminMarginsRoutes({ pool, protectAdmin }));

// === PUBLIC ENDPOINTS ===

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
        const result = await getGameProductsCatalog({ pool, gameId, user: req.user });
        if (result.notFound) return res.status(404).json({ message: 'Game tidak ditemukan.' });
        res.json(result.body);
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

    try {
        const result = await validatePromoCodeForProduct({
            pool,
            userId: client_user_id,
            promoCode: promo_code,
            productId: product_id,
            targetGameId: target_game_id,
        });
        return res.status(result.statusCode).json(result.body);
    } catch (error) {
        console.error('Error saat validasi promo:', error);
        res.status(500).json({ valid: false, message: 'Terjadi kesalahan di server.' });
    }
});


// === WA BOT ADMIN DEPOSITS ENDPOINTS ===
app.use(createWaBotRoutes({ pool, createNotification, requireWaBotAdminToken }));

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
