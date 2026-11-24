const express = require('express');
const axios = require('axios');
const { FOXY_API_KEY } = require('../config/env');
const {
    FOXY_BASE_URL,
    PROVIDER_TIMEOUT_MS,
    CALLBACK_VERIFY_COOLDOWN_MS,
    CALLBACK_SUCCESS_RESPONSE,
} = require('../config/constants');
const { logSafeError, safeAxiosError } = require('../utils/logger');
const { normalizeString, sanitizePublicErrorMessage } = require('../utils/strings');
const { timingSafeStringEqual } = require('../utils/crypto');
const { dispatchSafeH2HWebhook } = require('../utils/webhookClient.js');
const { rollbackTransactionResources } = require('../services/refundService');

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

/**
 * Daftarkan route POST /api/foxy/callback beserta verifikasi autentikasi, cooldown, dan rekonsiliasi status.
 */
function createFoxyCallbackRoutes(deps) {
    const { pool, createNotification } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createFoxyCallbackRoutes requires a valid pool');
    }
    if (typeof createNotification !== 'function') {
        throw new TypeError('createFoxyCallbackRoutes requires a createNotification function');
    }

    const router = express.Router();

    router.post('/api/foxy/callback', async (req, res) => {
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
            callbackVerificationCooldown.delete(trx_id);
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
                const safeRefundReason = sanitizePublicErrorMessage(verifiedMessage, 'Transaksi gagal diproses');
                await rollbackTransactionResources(client, tx, {
                    refundDescription: `Pengembalian dana untuk invoice ${tx.invoice_id} karena: ${safeRefundReason}`
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

    return router;
}

createFoxyCallbackRoutes.callbackClock = callbackClock;
createFoxyCallbackRoutes.clearCallbackCooldownCache = clearCallbackCooldownCache;

module.exports = createFoxyCallbackRoutes;
