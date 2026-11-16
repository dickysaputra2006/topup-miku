require('dotenv').config();
const { createPool } = require('../config/db.js');
const axios = require('axios');
const { dispatchSafeH2HWebhook } = require('../utils/webhookClient.js');
const { rollbackTransactionResources } = require('../services/refundService');

// ============================================================
// === KONFIGURASI DATABASE ===
// ============================================================
const pool = createPool();

// ============================================================
// === KONFIGURASI FOXY API ===
// ============================================================
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY;
const PROVIDER_TIMEOUT_MS = 15000; // 15 detik

const foxyApiHeaders = {
    'Authorization': FOXY_API_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Referer': 'https://www.foxygamestore.com/'
};

// ============================================================
// === SAFE LOGGING HELPERS ===
// Jangan pernah log full Axios error, config, headers, atau Authorization.
// ============================================================

/**
 * Menghasilkan ringkasan aman dari Axios/provider error.
 * Tidak pernah mencetak Authorization, API key, token, password,
 * config.headers, request._header, atau response body penuh.
 */
function safeAxiosError(error, providerName = 'Provider') {
    if (!error) return { provider: providerName, message: 'Unknown error' };

    const safe = { provider: providerName };

    // Pesan error — sanitasi secret
    if (error.message) {
        safe.message = String(error.message)
            .replace(/(api[_-]?key|authorization|password|token|secret)=?[^\s,]*/gi, '$1=[REDACTED]');
    }

    // HTTP response metadata (AMAN — bukan body penuh atau headers)
    if (error.response) {
        safe.status = error.response.status;
        safe.statusText = error.response.statusText;

        // Method & URL dari request (tanpa headers)
        if (error.response.config) {
            safe.method = error.response.config.method ? error.response.config.method.toUpperCase() : undefined;
            safe.url = error.response.config.url;
        }

        // Deteksi Cloudflare challenge
        const cfHeader = error.response.headers && error.response.headers['cf-mitigated'];
        const bodyStr = typeof error.response.data === 'string' ? error.response.data : '';
        const isCloudflare =
            error.response.status === 403 &&
            (cfHeader === 'challenge' || bodyStr.includes('Just a moment'));

        safe.isCloudflareChallenge = isCloudflare;
        safe.responseContentType = error.response.headers && error.response.headers['content-type'];

        if (isCloudflare) {
            safe.note = 'Provider blocked request with Cloudflare challenge. IP may need whitelisting.';
        }
    } else if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
        safe.note = 'Request timed out. Provider did not respond in time.';
    } else if (error.code) {
        safe.code = error.code;
    }

    return safe;
}

/**
 * Ringkasan sederhana tanpa sensitif apapun — untuk DB error.
 */
function safeErrorDetail(error) {
    if (!error) return { message: 'Unknown error' };
    const detail = {};
    if (error.code) detail.code = error.code;
    if (error.response && error.response.status) detail.status = error.response.status;
    if (error.message) detail.message = String(error.message)
        .replace(/(api[_-]?key|authorization|password|token|secret)=?[^\s,]*/gi, '$1=[REDACTED]');
    return detail;
}

// ============================================================
// === FUNGSI: CEK STATUS TRANSAKSI PENDING ===
// ============================================================
const PENDING_IN_FLIGHT_GRACE_MS = 10 * 60 * 1000; // 10 menit

function isWithinInFlightGracePeriod(createdAt, nowMs = Date.now()) {
    if (!createdAt) return false;
    const createdAtMs = new Date(createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) return false;
    return (nowMs - createdAtMs) < PENDING_IN_FLIGHT_GRACE_MS;
}

async function checkPendingTransactions() {
    console.log('[cron][pending] Starting checkPendingTransactions...');
    let pendingTx;
    try {
        const res = await pool.query(
            `SELECT t.id, t.invoice_id, t.user_id, t.price, t.provider_trx_id, t.check_attempts,
                    t.flash_sale_id, t.flash_sale_restored, t.created_at,
                    p.name as product_name, u.h2h_callback_url, u.h2h_webhook_secret
             FROM transactions t
             JOIN products p ON t.product_id = p.id
             JOIN users u ON t.user_id = u.id
             WHERE t.status IN ('Pending', 'Processing')`
        );
        pendingTx = res.rows;
    } catch (err) {
        console.error('[cron][pending] DB error on initial fetch:', safeErrorDetail(err));
        return;
    }

    if (pendingTx.length === 0) {
        console.log('[cron][pending] No pending transactions found.');
        return;
    }

    console.log(`[cron][pending] Found ${pendingTx.length} pending transaction(s). Processing...`);

    for (const tx of pendingTx) {
        if (!tx.provider_trx_id) {
            // Data lama sebelum perubahan Fase (a) yang belum memiliki provider_trx_id:
            // pertahankan aturan lama (lewati tanpa memanggil /v1/status atau refund).
            continue;
        }

        let foxyStatus = null;
        let serialNumber = 'Tidak ada SN';
        let isNotFound = false;

        try {
            const foxyResponse = await axios.get(
                `${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`,
                { headers: foxyApiHeaders, timeout: PROVIDER_TIMEOUT_MS }
            );
            const foxyData = foxyResponse.data.data;
            foxyStatus = foxyData.status.toUpperCase();
            serialNumber = foxyData.sn || 'Tidak ada SN';
        } catch (foxyError) {
            if (foxyError.response && foxyError.response.status === 404) {
                isNotFound = true;
            } else {
                // Safe logging — tidak mencetak headers atau Authorization
                console.error(
                    `[cron][pending] Error checking status for trx ${tx.provider_trx_id.slice(-8)}:`,
                    safeAxiosError(foxyError, 'Foxy')
                );
                continue;
            }
        }

        // Jika /v1/status mengembalikan 404 saat transaksi berumur < 10 menit,
        // lewati tanpa menaikkan check_attempts dan tanpa refund (order mungkin masih di Fase (b)).
        if (isNotFound && isWithinInFlightGracePeriod(tx.created_at)) {
            console.log(`[cron][pending] Invoice ${tx.invoice_id}: not found at provider yet (< 10 min grace period), skipping.`);
            continue;
        }

        const client = await pool.connect();
        let finalStatus = null;
        let committedStatus = null;
        try {
            await client.query('BEGIN');

            const checkRes = await client.query(
                'SELECT status, check_attempts, flash_sale_id, flash_sale_restored, created_at FROM transactions WHERE id = $1 FOR UPDATE',
                [tx.id]
            );
            if (checkRes.rows.length === 0) {
                await client.query('ROLLBACK');
                continue;
            }
            const currentDbTx = checkRes.rows[0];

            if (!['Pending', 'Processing'].includes(currentDbTx.status)) {
                await client.query('ROLLBACK');
                continue;
            }

            const txForRollback = {
                ...tx,
                status: currentDbTx.status,
                flash_sale_id: currentDbTx.flash_sale_id !== undefined ? currentDbTx.flash_sale_id : tx.flash_sale_id,
                flash_sale_restored: currentDbTx.flash_sale_restored !== undefined ? currentDbTx.flash_sale_restored : tx.flash_sale_restored
            };

            if (isNotFound) {
                const txCreatedAt = currentDbTx.created_at !== undefined ? currentDbTx.created_at : tx.created_at;
                if (isWithinInFlightGracePeriod(txCreatedAt)) {
                    await client.query('ROLLBACK');
                    continue;
                }
                const MAX_ATTEMPTS = 5;
                if (currentDbTx.check_attempts < MAX_ATTEMPTS) {
                    await client.query(
                        'UPDATE transactions SET check_attempts = check_attempts + 1 WHERE id = $1',
                        [tx.id]
                    );
                    console.log(`[cron][pending] Invoice ${tx.invoice_id}: not found at provider (attempt ${currentDbTx.check_attempts + 1}/${MAX_ATTEMPTS}).`);
                } else {
                    finalStatus = 'Failed';
                    await rollbackTransactionResources(client, txForRollback, {
                        refundDescription: `Pengembalian dana untuk invoice ${tx.invoice_id} karena: Transaksi kadaluarsa di provider (Cron)`
                    });
                    console.log(`[cron][pending] Invoice ${tx.invoice_id}: marked Failed (max attempts). Refunded.`);
                }
            } else if (foxyStatus === 'SUCCESS') {
                finalStatus = 'Success';
                await client.query(
                    'UPDATE transactions SET status = $1, provider_sn = $2, updated_at = NOW() WHERE id = $3',
                    [finalStatus, serialNumber, tx.id]
                );
                console.log(`[cron][pending] Invoice ${tx.invoice_id}: resolved as Success.`);
            } else if (foxyStatus === 'FAILED' || foxyStatus === 'REFUNDED') {
                finalStatus = 'Failed';
                await rollbackTransactionResources(client, txForRollback, {
                    refundDescription: `Pengembalian dana untuk invoice ${tx.invoice_id} karena: Gagal/Refund dari provider (Cron)`
                });
                console.log(`[cron][pending] Invoice ${tx.invoice_id}: resolved as Failed. Refunded.`);
            } else if (foxyStatus === 'PARTIAL_REFUND') {
                // Tidak auto-refund — butuh review manual admin
                finalStatus = 'Partial Refund';
                await client.query(
                    'UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2',
                    [finalStatus, tx.id]
                );
                console.log(`[cron][pending] Invoice ${tx.invoice_id}: set to Partial Refund (needs admin review). No auto-refund.`);
            }

            await client.query('COMMIT');
            committedStatus = finalStatus;
        } catch (dbError) {
            await client.query('ROLLBACK');
            console.error(`[cron][pending] DB error resolving invoice ${tx.invoice_id}:`, safeErrorDetail(dbError));
        } finally {
            client.release();
        }

        // Kirim H2H webhook HANYA setelah DB COMMIT berhasil (non-throwing, SSRF + HMAC SEC-007)
        if (committedStatus && tx.h2h_callback_url) {
            const webhookPayload = {
                invoice_id: tx.invoice_id,
                status: finalStatus,
                product_name: tx.product_name,
                price: tx.price,
                serial_number: serialNumber,
                timestamp: new Date().toISOString()
            };
            await dispatchSafeH2HWebhook({
                dbPool: pool,
                userId: tx.user_id,
                callbackUrl: tx.h2h_callback_url,
                webhookSecret: tx.h2h_webhook_secret,
                payload: webhookPayload,
                invoiceId: tx.invoice_id,
                source: 'cron][pending'
            });
        }
    }

    console.log('[cron][pending] checkPendingTransactions finished.');
}

module.exports = {
    pool,
    FOXY_BASE_URL,
    FOXY_API_KEY,
    PROVIDER_TIMEOUT_MS,
    foxyApiHeaders,
    safeAxiosError,
    safeErrorDetail,
    PENDING_IN_FLIGHT_GRACE_MS,
    isWithinInFlightGracePeriod,
    checkPendingTransactions,
};
