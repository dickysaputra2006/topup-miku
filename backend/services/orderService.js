const axios = require('axios');
const { FOXY_API_KEY, FOXY_CALLBACK_URL } = require('../config/env');
const { FOXY_BASE_URL, PROVIDER_TIMEOUT_MS } = require('../config/constants');
const { safeErrorDetail, safeAxiosError } = require('../utils/logger');
const { parsePositiveQuota, isValidPriceAmount } = require('../utils/validation');
const { rollbackTransactionResources } = require('./refundService');
const { validateOrderGameIdIfNeeded, invalidateFoxyProductCache, fetchRealtimeFoxyCostForOrder } = require('./foxyClient');
const { generateInvoiceId, generateProviderTrxId, resolveExistingIdempotentOrder, insertTransactionRecord, findRecentPendingDuplicate } = require('./idempotency');

function getSafeOrderErrorMessage(error, fallback) {
    const message = error && error.message ? error.message : '';
    const allowedMessages = [
        'Produk dan ID Game wajib diisi.', 'productId dan targetGameId wajib diisi.',
        'Produk tidak valid atau tidak aktif.', 'Terjadi perubahan harga',
        'Harga sedang diperbarui, coba lagi sebentar', 'Harga produk sedang diperbarui',
        'Produk sedang tidak tersedia', 'Server ID wajib diisi',
        'Saldo Anda tidak mencukupi.', 'Saldo H2H Anda tidak mencukupi.',
        'Harga produk tidak valid.', 'Pesanan serupa masih pending',
        'Gagal mengirim pesanan ke provider.', 'Kode promo tidak ditemukan',
        'Kode promo tidak dapat digunakan', 'Kode promo sudah kedaluwarsa.',
        'Kuota penggunaan promo', 'Anda sudah mencapai batas maksimal',
        'Promo ini hanya berlaku', 'Promo ini tidak berlaku',
        'Nilai diskon promo tidak valid.', 'Validasi ID sedang tidak tersedia',
        'ID game tidak valid',
        'User ID atau Zone ID tidak valid.', 'WDP untuk ID ini sudah penuh atau tidak tersedia.',
        'Promo Double Diamond untuk ID ini sudah tidak tersedia.',
        'Bundle Weekly Elite tidak tersedia untuk ID ini.',
        'Bundle Monthly Epic tidak tersedia untuk ID ini.',
        'Pengecekan promo sedang tidak tersedia, coba lagi nanti.',
        'Produk tidak tersedia untuk ID ini.',
        'Metode pembayaran akun tidak sesuai untuk produk ini.',
        'Konfigurasi Double Diamond tidak valid',
        'Kuota transaksi harian H2H Anda telah tercapai.',
        'Batas nominal transaksi harian H2H Anda telah tercapai.',
        'Format ref_id tidak valid', 'Header Idempotency-Key harus berupa UUID yang valid.',
        'ref_id sudah digunakan', 'Idempotency-Key sudah digunakan',
    ];
    return allowedMessages.some(allowed => message.startsWith(allowed)) ? message : fallback;
}

function isProviderTimeoutOrAmbiguous(providerError) {
    if (!providerError || providerError.isExplicitRejection) return false;
    const httpStatus = providerError.response && providerError.response.status;
    const errCode = providerError.code;
    return (
        errCode === 'ECONNABORTED' || errCode === 'ETIMEDOUT' || errCode === 'ECONNRESET' ||
        Boolean(providerError.message && /timeout/i.test(providerError.message)) ||
        httpStatus === 502 || httpStatus === 503 || httpStatus === 504
    );
}

/**
 * Fase (c): transaksi DB kedua setelah panggilan provider tanpa menahan koneksi di Fase (b).
 * Mempertahankan lock FOR UPDATE tanpa filter status agar aman terhadap balapan callback.
 */
async function finalizeOrderAfterProviderCall({
    pool, invoiceId, providerTrxId, userId, finalPrice, appliedFlashSaleId, newTransactionId, shouldRollbackIfPending, logPrefix
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

async function preCheckOrderAndLookupProduct(pool, {
    channel, userId, idempotencyKey, keyLabel, productId, targetGameId, targetServerId, useSubquery
}) {
    const preClient = await pool.connect();
    try {
        const earlyIdempotent = await resolveExistingIdempotentOrder(preClient, {
            channel, userId, idempotencyKey, keyLabel, productId, targetGameId, targetServerId
        });
        if (earlyIdempotent) return { earlyIdempotent };

        const productQuery = useSubquery
            ? `
                SELECT p.*, g.id as game_id, g.needs_server_id,
                    gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM (SELECT * FROM products WHERE id = $1 AND status = 'Active') AS p
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE g.status = 'Active'
            `
            : `
                SELECT p.*, g.id as game_id, g.needs_server_id,
                       gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM products p 
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE p.id = $1 AND p.status = 'Active' AND g.status = 'Active'
            `;
        const { rows: products } = await preClient.query(productQuery, [productId]);
        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        return { product: products[0] };
    } finally {
        preClient.release();
    }
}

async function lockAndCalculateOrderSellingPrice(client, product, roleId, userRoleName) {
    let finalPrice;
    const manualPrice = product.manual_prices ? product.manual_prices[userRoleName] : null;
    if (product.use_manual_prices && manualPrice !== null && manualPrice !== undefined && manualPrice !== '') {
        finalPrice = Number(manualPrice);
    } else {
        const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [roleId]);
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

    let appliedFlashSaleId = null;
    const { rows: flashSaleRows } = await client.query(
        `SELECT id, discount_price FROM flash_sales
         WHERE product_id = $1 AND is_active = true
           AND NOW() BETWEEN start_at AND end_at
           AND (max_uses IS NULL OR uses_count < max_uses)
         LIMIT 1 FOR UPDATE`,
        [product.id]
    );
    if (flashSaleRows.length > 0) {
        const flashPrice = Number(flashSaleRows[0].discount_price);
        if (flashPrice > 0 && flashPrice < finalPrice) {
            finalPrice = flashPrice;
            appliedFlashSaleId = flashSaleRows[0].id || null;
        }
    }
    return { finalPrice, appliedFlashSaleId };
}

async function lockAndApplyOrderPromo(client, { promoCode, userId, product, targetGameId, finalPrice }) {
    if (!promoCode) return { finalPrice, appliedPromoId: null };
    const { rows: promoRows } = await client.query(
        'SELECT * FROM promo_codes WHERE code = $1 AND is_active = true FOR UPDATE',
        [promoCode]
    );
    if (promoRows.length === 0) throw new Error('Kode promo tidak ditemukan atau tidak aktif.');
    const promo = promoRows[0];
    const rules = promo.rules || {};

    if (promo.expires_at && new Date(promo.expires_at) < new Date()) throw new Error('Kode promo sudah kedaluwarsa.');
    if (promo.max_uses && promo.uses_count >= promo.max_uses) throw new Error('Kuota penggunaan promo ini sudah habis.');
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
    if (!Number.isFinite(discount) || discount < 0) throw new Error('Nilai diskon promo tidak valid.');
    if (discount >= finalPrice) discount = finalPrice - 1;
    if (discount > 0) {
        return { finalPrice: finalPrice - discount, appliedPromoId: promo.id };
    }
    return { finalPrice, appliedPromoId: null };
}

async function enforceH2HDailyQuotaIfConfigured(client, h2hUserId, finalPrice) {
    const maxDailyOrders = parsePositiveQuota(process.env.H2H_DAILY_MAX_ORDERS);
    const maxDailyAmount = parsePositiveQuota(process.env.H2H_DAILY_MAX_AMOUNT);
    if (maxDailyOrders === null && maxDailyAmount === null) return;
    const { rows: quotaRows } = await client.query(
        `SELECT COUNT(*)::int AS order_count, COALESCE(SUM(price), 0)::bigint AS total_amount
         FROM transactions
         WHERE user_id = $1
           AND invoice_id LIKE 'H2H-%'
           AND created_at >= DATE_TRUNC('day', NOW())
           AND status IN ('Pending', 'Processing', 'Success')`,
        [h2hUserId]
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

async function deductBalanceAndInsertOrderTx(client, {
    channel, userId, userBalance, insufficientBalanceMessage, product, targetGameId, targetServerId,
    finalPrice, appliedFlashSaleId, appliedPromoId, idempotencyKey, keyLabel, invoicePrefix, providerPrefix, historyDescPrefix
}) {
    const finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
    if (!idempotencyKey) {
        const duplicate = await findRecentPendingDuplicate(client, userId, product.id, finalTargetForDB);
        if (duplicate) throw new Error(`Pesanan serupa masih pending (${duplicate.invoice_id}). Mohon tunggu sebelum mencoba lagi.`);
    }

    if (Number(userBalance) < finalPrice) throw new Error(insufficientBalanceMessage);
    const deductRes = await client.query(
        'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1',
        [finalPrice, userId]
    );
    if (deductRes && typeof deductRes.rowCount === 'number' && deductRes.rowCount === 0) {
        throw new Error(insufficientBalanceMessage);
    }

    const invoiceId = generateInvoiceId(invoicePrefix);
    const providerTrxId = generateProviderTrxId(providerPrefix);
    let txInsertRows;
    try {
        ({ rows: txInsertRows } = await insertTransactionRecord(client, {
            invoiceId, userId, productId: product.id, targetForDb: finalTargetForDB,
            finalPrice, providerTrxId, flashSaleId: appliedFlashSaleId, idempotencyKey
        }));
    } catch (insertErr) {
        if (insertErr && insertErr.code === '23505' && idempotencyKey) {
            await client.query('ROLLBACK').catch(() => {});
            const raceResolved = await resolveExistingIdempotentOrder(client, {
                channel, userId, idempotencyKey, keyLabel, productId: product.id, targetGameId, targetServerId
            });
            if (raceResolved) return { raceResolved };
        }
        throw insertErr;
    }

    const newTransactionId = (txInsertRows && txInsertRows[0]) ? txInsertRows[0].id : null;
    await client.query(
        'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, -finalPrice, 'Purchase', `${historyDescPrefix}: ${product.name} (${invoiceId})`, invoiceId]
    );

    if (appliedFlashSaleId) {
        await client.query('UPDATE flash_sales SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1', [appliedFlashSaleId]);
    }
    if (appliedPromoId) {
        await client.query('UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = NOW() WHERE id = $1', [appliedPromoId]);
        await client.query(
            'INSERT INTO promo_usages (promo_code_id, user_id, product_id, transaction_id, customer_game_id) VALUES ($1, $2, $3, $4, $5)',
            [appliedPromoId, userId, product.id, newTransactionId, targetGameId]
        );
    }

    return { invoiceId, providerTrxId, newTransactionId, finalTargetForDB };
}

async function submitOrderToFoxyProvider({ productSku, targetGameId, targetServerId, providerTrxId, isH2H, logPrefix }) {
    const foxyPayload = {
        product_code: productSku,
        user_id: targetGameId,
        server_id: targetServerId || '',
        trx_id: providerTrxId,
        callback_url: FOXY_CALLBACK_URL
    };
    const foxyConfig = isH2H
        ? {
            headers: {
                'Authorization': FOXY_API_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                'Referer': 'https://www.foxygamestore.com/'
            },
            timeout: PROVIDER_TIMEOUT_MS
        }
        : {
            headers: { 'Authorization': FOXY_API_KEY, 'Content-Type': 'application/json' },
            timeout: PROVIDER_TIMEOUT_MS
        };

    let providerSucceeded = false;
    let isTimeoutOrAmbiguous = false;
    try {
        const foxyRes = await axios.post(`${FOXY_BASE_URL}/v1/order`, foxyPayload, foxyConfig);
        if (foxyRes && foxyRes.data && foxyRes.data.status === false) {
            const rejectErr = new Error(foxyRes.data.message || 'Provider menolak pesanan.');
            rejectErr.isExplicitRejection = true;
            throw rejectErr;
        }
        providerSucceeded = true;
    } catch (providerError) {
        console.error(`${logPrefix} Foxy order submission failed:`, safeAxiosError(providerError, 'Foxy'));
        isTimeoutOrAmbiguous = isProviderTimeoutOrAmbiguous(providerError);
    }
    return { providerSucceeded, isTimeoutOrAmbiguous };
}

/**
 * Eksekusi penuh alur 3-fase Web Order (POST /api/order).
 */
async function executeWebOrder({ pool, userId, productId, targetGameId, targetServerId, promoCode, idempotencyKey }) {
    if (!Number.isInteger(productId) || productId <= 0 || !targetGameId) {
        throw new Error('Produk dan ID Game wajib diisi.');
    }

    const preCheck = await preCheckOrderAndLookupProduct(pool, {
        channel: 'web', userId, idempotencyKey, keyLabel: 'Idempotency-Key',
        productId, targetGameId, targetServerId, useSubquery: true
    });
    if (preCheck.earlyIdempotent) return preCheck.earlyIdempotent;
    const { product } = preCheck;

    if (product.needs_server_id && !targetServerId) throw new Error('Server ID wajib diisi untuk game ini.');
    await validateOrderGameIdIfNeeded(product, targetGameId, targetServerId);
    const currentProviderCost = await fetchRealtimeFoxyCostForOrder(
        product, '[order]', '[order] Checking real-time price from Foxy...'
    );

    // === FASE (a): RESERVASI ATOMIK SINGKAT DI DATABASE ===
    let finalPrice;
    let appliedFlashSaleId = null;
    let invoiceId;
    let trx_id_provider;
    let newTransactionId = null;
    const client = await pool.connect();
    let inTransaction = false;
    try {
        await client.query('BEGIN');
        inTransaction = true;

        const { rows: users } = await client.query(
            'SELECT balance, role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1 FOR UPDATE',
            [userId]
        );
        if (!users || users.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = users[0];

        ({ finalPrice, appliedFlashSaleId } = await lockAndCalculateOrderSellingPrice(
            client, product, user.role_id, user.role_name.toLowerCase()
        ));

        if (currentProviderCost > finalPrice) {
            console.warn(`[order] Price risk: Provider cost (${currentProviderCost}) > Final user price (${finalPrice}). SKU ${product.provider_sku}.`);
            invalidateFoxyProductCache();
            throw new Error('Harga sedang diperbarui, coba lagi sebentar');
        }

        let appliedPromoId = null;
        ({ finalPrice, appliedPromoId } = await lockAndApplyOrderPromo(client, {
            promoCode, userId, product, targetGameId, finalPrice
        }));

        if (currentProviderCost > finalPrice) {
            if (appliedPromoId) {
                console.warn(`[order] Promo cost guard blocked order: Final price (${finalPrice}) < Provider cost (${currentProviderCost}). SKU ${product.provider_sku}.`);
                throw new Error('Kode promo tidak dapat digunakan karena membuat harga akhir di bawah harga modal produk.');
            }
            invalidateFoxyProductCache();
            throw new Error('Harga sedang diperbarui, coba lagi sebentar');
        }

        if (!isValidPriceAmount(finalPrice)) throw new Error('Harga produk tidak valid.');

        const txRes = await deductBalanceAndInsertOrderTx(client, {
            channel: 'web', userId, userBalance: user.balance,
            insufficientBalanceMessage: 'Saldo Anda tidak mencukupi.',
            product, targetGameId, targetServerId, finalPrice, appliedFlashSaleId, appliedPromoId,
            idempotencyKey, keyLabel: 'Idempotency-Key', invoicePrefix: 'TRX', providerPrefix: 'WEB',
            historyDescPrefix: 'Pembelian produk'
        });
        if (txRes.raceResolved) {
            inTransaction = false;
            return txRes.raceResolved;
        }
        ({ invoiceId, providerTrxId: trx_id_provider, newTransactionId } = txRes);

        await client.query('COMMIT');
        inTransaction = false;
    } catch (phaseAError) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        throw phaseAError;
    } finally {
        client.release();
    }

    // === FASE (b) & FASE (c) ===
    const { providerSucceeded, isTimeoutOrAmbiguous } = await submitOrderToFoxyProvider({
        productSku: product.provider_sku, targetGameId, targetServerId, providerTrxId: trx_id_provider, isH2H: false, logPrefix: '[order]'
    });
    const lockedTxStatus = await finalizeOrderAfterProviderCall({
        pool, invoiceId, providerTrxId: trx_id_provider, userId, finalPrice, appliedFlashSaleId, newTransactionId,
        shouldRollbackIfPending: !providerSucceeded && !isTimeoutOrAmbiguous, logPrefix: '[order]'
    });

    if (providerSucceeded || isTimeoutOrAmbiguous || lockedTxStatus === 'Success') {
        if (!providerSucceeded && isTimeoutOrAmbiguous) {
            console.warn(`[order] Timeout/ambiguous response for invoice ${invoiceId} (${trx_id_provider}). Keeping status Pending for cron reconciliation.`);
        }
        return { statusCode: 201, body: { message: 'Pesanan Anda sedang diproses!', invoiceId } };
    }
    throw new Error('Gagal mengirim pesanan ke provider. Saldo tidak dipotong.');
}

/**
 * Eksekusi penuh alur 3-fase H2H Order (POST /h2h/order).
 */
async function executeH2HOrder({ pool, h2hUser, productId, targetGameId, targetServerId, refId }) {
    if (!Number.isInteger(productId) || productId <= 0 || !targetGameId) {
        throw new Error('productId dan targetGameId wajib diisi.');
    }

    const preCheck = await preCheckOrderAndLookupProduct(pool, {
        channel: 'h2h', userId: h2hUser.id, idempotencyKey: refId, keyLabel: 'ref_id',
        productId, targetGameId, targetServerId, useSubquery: false
    });
    if (preCheck.earlyIdempotent) return preCheck.earlyIdempotent;
    const { product } = preCheck;

    if (product.needs_server_id && !targetServerId) throw new Error('Server ID wajib diisi untuk game ini.');
    await validateOrderGameIdIfNeeded(product, targetGameId, targetServerId);
    const currentProviderCost = await fetchRealtimeFoxyCostForOrder(
        product, '[h2h-order]', `[h2h-order] Checking real-time price for SKU ${product.provider_sku}...`
    );

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

        const { rows: users } = await client.query('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE', [h2hUser.id]);
        if (!users || users.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const userForTx = users[0];

        ({ finalPrice, appliedFlashSaleId } = await lockAndCalculateOrderSellingPrice(
            client, product, userForTx.role_id, h2hUser.role_name.toLowerCase()
        ));

        if (currentProviderCost > finalPrice) {
            console.warn(`[h2h-order] Price risk: Cost (${currentProviderCost}) > Final price (${finalPrice}). SKU ${product.provider_sku}.`);
            invalidateFoxyProductCache();
            throw new Error('Harga sedang diperbarui, coba lagi sebentar');
        }

        if (!isValidPriceAmount(finalPrice)) throw new Error('Harga produk tidak valid.');
        await enforceH2HDailyQuotaIfConfigured(client, h2hUser.id, finalPrice);

        const txRes = await deductBalanceAndInsertOrderTx(client, {
            channel: 'h2h', userId: h2hUser.id, userBalance: userForTx.balance,
            insufficientBalanceMessage: 'Saldo H2H Anda tidak mencukupi.',
            product, targetGameId, targetServerId, finalPrice, appliedFlashSaleId, appliedPromoId: null,
            idempotencyKey: refId, keyLabel: 'ref_id', invoicePrefix: 'H2H', providerPrefix: 'H2H-PROVIDER',
            historyDescPrefix: 'Pembelian H2H'
        });
        if (txRes.raceResolved) {
            inTransaction = false;
            return txRes.raceResolved;
        }
        ({ invoiceId, providerTrxId: trx_id_provider, newTransactionId: newH2hTransactionId, finalTargetForDB } = txRes);

        await client.query('COMMIT');
        inTransaction = false;
    } catch (phaseAError) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        throw phaseAError;
    } finally {
        client.release();
    }

    // === FASE (b) & FASE (c) ===
    const { providerSucceeded, isTimeoutOrAmbiguous } = await submitOrderToFoxyProvider({
        productSku: product.provider_sku, targetGameId, targetServerId, providerTrxId: trx_id_provider, isH2H: true, logPrefix: '[h2h-order]'
    });
    const lockedTxStatus = await finalizeOrderAfterProviderCall({
        pool, invoiceId, providerTrxId: trx_id_provider, userId: h2hUser.id, finalPrice, appliedFlashSaleId,
        newTransactionId: newH2hTransactionId, shouldRollbackIfPending: !providerSucceeded && !isTimeoutOrAmbiguous, logPrefix: '[h2h-order]'
    });

    if (providerSucceeded || isTimeoutOrAmbiguous || lockedTxStatus === 'Success') {
        if (!providerSucceeded && isTimeoutOrAmbiguous) {
            console.warn(`[h2h-order] Timeout/ambiguous response for invoice ${invoiceId} (${trx_id_provider}). Keeping status Pending for cron reconciliation.`);
        }
        return {
            statusCode: 201,
            body: {
                success: true,
                message: 'Pesanan H2H Anda sedang diproses!',
                data: {
                    invoiceId: invoiceId,
                    status: lockedTxStatus === 'Success' ? 'Success' : 'Pending',
                    productName: product.name,
                    target: finalTargetForDB,
                    price: finalPrice
                }
            }
        };
    }
    throw new Error('Gagal mengirim pesanan ke provider. Saldo tidak dipotong.');
}

module.exports = {
    getSafeOrderErrorMessage,
    isProviderTimeoutOrAmbiguous,
    finalizeOrderAfterProviderCall,
    executeWebOrder,
    executeH2HOrder,
};
