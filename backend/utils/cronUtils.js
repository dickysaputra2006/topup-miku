require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
// === KONFIGURASI DATABASE ===
// ============================================================
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
async function checkPendingTransactions() {
    console.log('[cron][pending] Starting checkPendingTransactions...');
    let pendingTx;
    try {
        const res = await pool.query(
            `SELECT t.id, t.invoice_id, t.user_id, t.price, t.provider_trx_id, t.check_attempts,
                    p.name as product_name, u.h2h_callback_url
             FROM transactions t
             JOIN products p ON t.product_id = p.id
             JOIN users u ON t.user_id = u.id
             WHERE t.status = 'Pending'`
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
        if (!tx.provider_trx_id) continue;

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

        const client = await pool.connect();
        let finalStatus = null;
        let committedStatus = null;
        try {
            await client.query('BEGIN');

            const checkRes = await client.query(
                'SELECT status, check_attempts FROM transactions WHERE id = $1 FOR UPDATE',
                [tx.id]
            );
            if (checkRes.rows.length === 0) {
                await client.query('ROLLBACK');
                continue;
            }
            const currentDbTx = checkRes.rows[0];

            if (currentDbTx.status !== 'Pending') {
                await client.query('ROLLBACK');
                continue;
            }

            if (isNotFound) {
                const MAX_ATTEMPTS = 5;
                if (currentDbTx.check_attempts < MAX_ATTEMPTS) {
                    await client.query(
                        'UPDATE transactions SET check_attempts = check_attempts + 1 WHERE id = $1',
                        [tx.id]
                    );
                    console.log(`[cron][pending] Invoice ${tx.invoice_id}: not found at provider (attempt ${currentDbTx.check_attempts + 1}/${MAX_ATTEMPTS}).`);
                } else {
                    finalStatus = 'Failed';
                    await client.query(
                        'UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2',
                        [finalStatus, tx.id]
                    );
                    await client.query(
                        'UPDATE users SET balance = balance + $1 WHERE id = $2',
                        [tx.price, tx.user_id]
                    );
                    const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: Transaksi kadaluarsa di provider (Cron)`;
                    await client.query(
                        'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                        [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]
                    );
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
                await client.query(
                    'UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2',
                    [finalStatus, tx.id]
                );
                await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE id = $2',
                    [tx.price, tx.user_id]
                );
                const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: Gagal/Refund dari provider (Cron)`;
                await client.query(
                    'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                    [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]
                );
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

        // Kirim H2H webhook HANYA setelah DB COMMIT berhasil
        if (committedStatus && tx.h2h_callback_url) {
            const webhookPayload = {
                invoice_id: tx.invoice_id,
                status: finalStatus,
                product_name: tx.product_name,
                price: tx.price,
                serial_number: serialNumber,
                timestamp: new Date().toISOString()
            };
            axios.post(tx.h2h_callback_url, webhookPayload, { timeout: PROVIDER_TIMEOUT_MS })
                .catch(err => console.error(
                    `[cron][pending] Webhook failed for invoice ${tx.invoice_id}:`,
                    safeAxiosError(err, 'H2H Webhook')
                ));
        }
    }

    console.log('[cron][pending] checkPendingTransactions finished.');
}


// ============================================================
// === FUNGSI: SINKRONISASI PRODUK ===
// ============================================================
async function syncProductsWithFoxy() {
    console.log('[cron][sync] Starting smart product sync...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const axiosConfig = {
            headers: foxyApiHeaders,
            timeout: PROVIDER_TIMEOUT_MS
        };

        // 1. Ambil semua produk dari Foxy
        let providerProducts;
        try {
            const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, axiosConfig);
            providerProducts = response.data.data;
        } catch (foxyError) {
            // Safe log — tidak cetak headers atau body HTML Cloudflare
            const safeErr = safeAxiosError(foxyError, 'Foxy');
            if (safeErr.isCloudflareChallenge) {
                console.warn('[cron][sync] Foxy API blocked by Cloudflare challenge. Sync skipped. Check VPS IP whitelist with Foxy support.');
            } else {
                console.error('[cron][sync] Failed to fetch Foxy products:', safeErr);
            }
            await client.query('ROLLBACK');
            throw foxyError;
        }

        if (!Array.isArray(providerProducts)) {
            throw new Error('[cron][sync] Foxy API response format invalid — expected array.');
        }

        const providerSkus = new Set(providerProducts.map(p => p.product_code));

        // 2. Ambil semua produk, game, dan kategori dari DB
        const { rows: localProducts } = await client.query('SELECT id, provider_sku, price, status FROM products');
        const { rows: localGames } = await client.query('SELECT id, name FROM games');
        const localGameMap = new Map(localGames.map(g => [g.name.toLowerCase(), g.id]));
        const { rows: localCategories } = await client.query('SELECT id, game_id, name FROM product_categories');
        const localCategoryMap = new Map(localCategories.map(c => [`${c.game_id}:${c.name.toLowerCase()}`, c.id]));

        const productBatch = {
            gameIds: [],
            categoryIds: [],
            names: [],
            skus: [],
            prices: [],
            statuses: []
        };

        // 3. Loop produk dari Foxy untuk kumpulkan data batch
        for (const product of providerProducts) {
            const gameName = product.category_title;
            const categoryName = product.category_type;
            const productName = product.product_name;
            const productCode = product.product_code;
            const basePriceFoxy = product.product_price;

            if (!gameName || !productName || !productCode || basePriceFoxy === undefined) continue;

            let gameId = localGameMap.get(gameName.toLowerCase());
            if (!gameId) {
                const { rows: newGame } = await client.query(
                    'INSERT INTO games (name, category, image_url, status) VALUES ($1, $2, $3, $4) RETURNING id',
                    [gameName, categoryName, 'https://via.placeholder.com/200', 'Active']
                );
                gameId = newGame[0].id;
                localGameMap.set(gameName.toLowerCase(), gameId);
            }

            const categoryKey = `${gameId}:${categoryName.toLowerCase()}`;
            let categoryId = localCategoryMap.get(categoryKey);
            if (!categoryId) {
                const { rows: newCat } = await client.query(
                    'INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id',
                    [gameId, categoryName]
                );
                categoryId = newCat[0].id;
                localCategoryMap.set(categoryKey, categoryId);
            }

            productBatch.gameIds.push(gameId);
            productBatch.categoryIds.push(categoryId);
            productBatch.names.push(productName);
            productBatch.skus.push(productCode);
            productBatch.prices.push(basePriceFoxy);
            productBatch.statuses.push('Active');
        }

        // 4. Jalankan UPSERT batch
        if (productBatch.skus.length > 0) {
            await client.query(`
                INSERT INTO products (game_id, category_id, name, provider_sku, price, status)
                SELECT * FROM unnest($1::int[], $2::int[], $3::varchar[], $4::varchar[], $5::decimal[], $6::varchar[])
                ON CONFLICT (provider_sku) DO UPDATE SET
                    game_id = EXCLUDED.game_id,
                    category_id = EXCLUDED.category_id,
                    name = EXCLUDED.name,
                    price = EXCLUDED.price,
                    status = EXCLUDED.status,
                    updated_at = NOW()
            `, [
                productBatch.gameIds,
                productBatch.categoryIds,
                productBatch.names,
                productBatch.skus,
                productBatch.prices,
                productBatch.statuses
            ]);
            console.log(`[cron][sync] Upserted ${productBatch.skus.length} product(s).`);
        }

        // 5. Nonaktifkan produk lokal yang tidak ada di Foxy
        const deactivateIds = localProducts
            .filter(lp => lp.status === 'Active' && !providerSkus.has(lp.provider_sku))
            .map(lp => lp.id);

        if (deactivateIds.length > 0) {
            await client.query(
                'UPDATE products SET status = $1, updated_at = NOW() WHERE id = ANY($2::int[])',
                ['Inactive', deactivateIds]
            );
            console.log(`[cron][sync] Deactivated ${deactivateIds.length} product(s) no longer at provider.`);
        }

        await client.query('COMMIT');
        console.log('[cron][sync] Smart product sync finished successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        // Hindari double-log jika sudah di-log di atas (Cloudflare case)
        if (!error._cronLogged) {
            console.error('[cron][sync] Product sync failed:', safeErrorDetail(error));
        }
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================
// === FUNGSI UTAMA: JALANKAN SEMUA CRON JOBS ===
// Setiap job dibungkus try/catch agar satu gagal tidak hentikan yang lain.
// ============================================================
async function runAllCronJobs() {
    console.log('[cron] Starting all cron jobs...');
    const results = { pending: 'skipped', sync: 'skipped' };

    // Job 1: Cek pending transactions (kritis — selalu jalankan duluan)
    try {
        await checkPendingTransactions();
        results.pending = 'success';
    } catch (err) {
        results.pending = 'failed';
        console.error('[cron] checkPendingTransactions failed:', safeErrorDetail(err));
    }

    // Job 2: Sync produk (non-kritis — gagal tidak stop job lain)
    try {
        await syncProductsWithFoxy();
        results.sync = 'success';
    } catch (err) {
        results.sync = 'failed';
        // Tidak re-throw — cron exit 0 meski sync gagal
        const safeErr = safeAxiosError(err, 'Foxy');
        if (safeErr.isCloudflareChallenge) {
            console.warn('[cron] Product sync blocked by Cloudflare. Pending check still completed.');
        } else {
            console.error('[cron] syncProductsWithFoxy failed:', safeErrorDetail(err));
        }
    }

    console.log(`[cron] All jobs completed. Summary: pending=${results.pending}, sync=${results.sync}`);
    return results;
}

module.exports = { checkPendingTransactions, syncProductsWithFoxy, runAllCronJobs };
