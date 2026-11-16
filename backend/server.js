const {
    PORT,
    FOXY_API_KEY,
    FOXY_CALLBACK_URL,
    validateEnvironment,
} = require('./config/env');
const {
    MAX_BODY_SIZE,
    FOXY_BASE_URL,
    PROVIDER_TIMEOUT_MS,
    CALLBACK_VERIFY_COOLDOWN_MS,
    CALLBACK_SUCCESS_RESPONSE,
} = require('./config/constants');
const {
    safeErrorDetail,
    logSafeError,
    safeAxiosError,
} = require('./utils/logger');
const { normalizeString } = require('./utils/strings');
const { timingSafeStringEqual } = require('./utils/crypto');
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
const createCatalogRoutes = require('./routes/catalog.routes');
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
const { createPool } = require('./config/db');
const axios = require('axios');
const { validateWebhookUrl, dispatchSafeH2HWebhook } = require('./utils/webhookClient.js');
const { rollbackTransactionResources } = require('./services/refundService');
const {
    validateOrderGameIdIfNeeded,
    invalidateFoxyProductCache,
    getFoxyProducts,
} = require('./services/foxyClient');
const {
    generateInvoiceId,
    generateProviderTrxId,
    resolveExistingIdempotentOrder,
    insertTransactionRecord,
    findRecentPendingDuplicate,
} = require('./services/idempotency');
const { createNotificationService } = require('./services/notificationService');
const {
    getSafeOrderErrorMessage,
    executeWebOrder,
    executeH2HOrder,
} = require('./services/orderService');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // untuk mendapatkan IP asli di belakang proxy

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
const createNotification = createNotificationService({ pool });

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
app.use(createCatalogRoutes({ pool, protect, softProtect }));

// === WA BOT ADMIN DEPOSITS ENDPOINTS ===
app.use(createWaBotRoutes({ pool, createNotification, requireWaBotAdminToken }));

// === ORDER & H2H ENDPOINTS ===
app.post('/api/order', protect, async (req, res) => {
    try {
        const idempotencyKey = parseOptionalIdempotencyKeyHeader(req);
        const productId = Number(req.body.productId);
        const targetGameId = normalizeString(req.body.targetGameId, 80);
        const targetServerId = normalizeString(req.body.targetServerId, 80);
        const promoCode = req.body.promoCode ? String(req.body.promoCode).trim().toUpperCase() : null;
        const userId = req.user.id;

        const result = await executeWebOrder({
            pool,
            userId,
            productId,
            targetGameId,
            targetServerId,
            promoCode,
            idempotencyKey,
        });
        return res.status(result.statusCode).json(result.body);
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

        const result = await executeH2HOrder({
            pool,
            h2hUser,
            productId,
            targetGameId,
            targetServerId,
            refId,
        });
        return res.status(result.statusCode).json(result.body);
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
