/**
 * Manual PostgreSQL Concurrency Test (SEC-002)
 * Menjalankan tiga skenario konkurensi terhadap PostgreSQL lokal dengan fixture
 * berawalan CONCTEST- yang terisolasi dan dibersihkan di blok try/finally:
 *   A. Success dulu -> 20x refund + 20x callback FAILED bersamaan
 *   B. Refund dulu (20x bersamaan) -> 20x callback SUCCESS
 *   C. Balapan acak (20x callback SUCCESS + 20x refund bersamaan, jeda acak 0-30 ms) x 15 putaran
 *
 * Cara menjalankan (dari folder backend/):
 *   node tests/manual/concurrency.js
 *   (atau tambahkan --i-know-this-is-local jika DB_NAME tidak mengandung dev/local/test)
 *
 * Catatan keamanan:
 * - Script ini TIDAK dijalankan oleh `npm test`.
 * - Menolak berjalan jika NODE_ENV === 'production'.
 * - Menolak berjalan jika DB_HOST bukan localhost / 127.0.0.1.
 * - Menolak berjalan jika DB_NAME tidak mengandung dev/local/test tanpa flag --i-know-this-is-local.
 * - Tidak pernah memanggil API Foxy sungguhan: /v1/status dilayani oleh server tiruan lokal,
 *   dan seluruh panggilan lain ke foxygamestore.com diblokir.
 */

const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// === SAFETY GUARDS SEBELUM MENYENTUH DATABASE ATAU MEMUAT SERVER ===
if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] Script concurrency test tidak boleh dijalankan pada NODE_ENV=production.');
    process.exit(1);
}

const dbHost = String(process.env.DB_HOST || '').trim().toLowerCase();
if (!['localhost', '127.0.0.1'].includes(dbHost)) {
    console.error(`[FATAL] Ditolak: DB_HOST ("${dbHost || 'kosong'}") bukan localhost atau 127.0.0.1.`);
    process.exit(1);
}

const dbName = String(process.env.DB_NAME || '').trim();
const hasSafeDbName = /(dev|local|test)/i.test(dbName);
const hasLocalFlag = process.argv.includes('--i-know-this-is-local');
if (!dbName || (!hasSafeDbName && !hasLocalFlag)) {
    console.error(
        `[FATAL] Ditolak: DB_NAME ("${dbName || 'kosong'}") tidak mengandung "dev", "local", atau "test". ` +
        'Jika ini benar-benar database lokal, jalankan ulang dengan flag --i-know-this-is-local.'
    );
    process.exit(1);
}

const axios = require('axios');
const { pool } = require('../../config/db.js');
const { startServer } = require('../../server.js');
const { rollbackTransactionResources } = require('../../services/refundService.js');

const CONCURRENT_COUNT = 20;
const RANDOM_RACE_ROUNDS = 15;
const INITIAL_BALANCE = 100000;
const ORDER_PRICE = 25000;
const BALANCE_AFTER_ORDER = INITIAL_BALANCE - ORDER_PRICE; // 75000

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelayMs = () => Math.floor(Math.random() * 31); // 0 - 30 ms

async function runRefundAttempt(invoiceId, delayMs = 0) {
    if (delayMs > 0) await sleep(delayMs);
    const client = await pool.connect();
    let inTx = false;
    try {
        await client.query('BEGIN');
        inTx = true;
        const { rows } = await client.query(
            'SELECT id, invoice_id, user_id, price, status, flash_sale_id, flash_sale_restored FROM transactions WHERE invoice_id = $1 FOR UPDATE',
            [invoiceId]
        );
        if (rows.length !== 1 || !['Pending', 'Processing'].includes(rows[0].status)) {
            await client.query('ROLLBACK');
            inTx = false;
            return { outcome: `skipped:${rows[0] ? rows[0].status : 'missing'}` };
        }
        const tx = rows[0];
        await rollbackTransactionResources(client, tx, {
            refundDescription: `CONCTEST Refund (${invoiceId})`
        });
        await client.query('COMMIT');
        inTx = false;
        return { outcome: 'refunded' };
    } catch (err) {
        if (inTx) {
            await client.query('ROLLBACK').catch(() => {});
        }
        return { outcome: `rejected:${err.message}` };
    } finally {
        client.release();
    }
}

async function sendCallback(callbackUrl, providerTrxId, status, sn, delayMs = 0) {
    if (delayMs > 0) await sleep(delayMs);
    const headers = { 'Content-Type': 'application/json' };
    const configuredSecret = (process.env.FOXY_CALLBACK_SECRET || '').trim();
    if (configuredSecret) {
        headers['x-callback-token'] = configuredSecret;
    }
    const res = await fetch(callbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            trx_id: providerTrxId,
            status,
            sn
        })
    });
    return { status: res.status };
}

/**
 * Menjalankan satu putaran terisolasi lengkap dengan pembuatan fixture & pembersihan try/finally.
 */
async function withIsolatedFixture(label, callbackFn) {
    const uniqueSuffix = `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const invoiceId = `CONCTEST-TRX-${uniqueSuffix}`;
    const providerTrxId = `CONCTEST-FOXY-${uniqueSuffix}`;
    const targetGameId = `CONCTEST-UID-${uniqueSuffix}`;

    const client = await pool.connect();
    let testUserId = null;
    let testGameId = null;
    let testCategoryId = null;
    let testProductId = null;
    let testFlashSaleId = null;
    let testPromoCodeId = null;
    let testTransactionId = null;

    try {
        const { rows: roleRows } = await client.query('SELECT id FROM roles ORDER BY id ASC LIMIT 1');
        if (roleRows.length === 0) {
            throw new Error('Tabel roles kosong. Jalankan setup_db.sql / seeder terlebih dahulu.');
        }
        const roleId = roleRows[0].id;

        const { rows: userRows } = await client.query(
            `INSERT INTO users (full_name, username, email, nomor_wa, password, balance, role_id)
             VALUES ($1, $2, $3, NULL, $4, $5, $6) RETURNING id`,
            [
                `CONCTEST User ${uniqueSuffix}`,
                `CONCTEST-user-${uniqueSuffix}`,
                `CONCTEST-${uniqueSuffix}@example.local`,
                'CONCTEST-hash-not-for-login',
                BALANCE_AFTER_ORDER,
                roleId
            ]
        );
        testUserId = userRows[0].id;

        const { rows: gameRows } = await client.query(
            `INSERT INTO games (name, category, image_url, needs_server_id, status)
             VALUES ($1, $2, $3, FALSE, 'Active') RETURNING id`,
            [`CONCTEST-Game-${uniqueSuffix}`, 'Testing', 'https://via.placeholder.com/200']
        );
        testGameId = gameRows[0].id;

        const { rows: catRows } = await client.query(
            `INSERT INTO product_categories (game_id, name)
             VALUES ($1, $2) RETURNING id`,
            [testGameId, `CONCTEST-Cat-${uniqueSuffix}`]
        );
        testCategoryId = catRows[0].id;

        const { rows: prodRows } = await client.query(
            `INSERT INTO products (game_id, category_id, name, provider_sku, price, status)
             VALUES ($1, $2, $3, $4, $5, 'Active') RETURNING id`,
            [testGameId, testCategoryId, `CONCTEST-Product-${uniqueSuffix}`, `CONCTEST-SKU-${uniqueSuffix}`, ORDER_PRICE]
        );
        testProductId = prodRows[0].id;

        const { rows: fsRows } = await client.query(
            `INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, uses_count, is_active)
             VALUES ($1, $2, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour', 10, 1, TRUE) RETURNING id`,
            [testProductId, ORDER_PRICE]
        );
        testFlashSaleId = fsRows[0].id;

        const { rows: promoRows } = await client.query(
            `INSERT INTO promo_codes (code, description, type, value, max_uses, uses_count, is_active)
             VALUES ($1, $2, 'fixed', 1000, 10, 1, TRUE) RETURNING id`,
            [`CONCTEST-PROMO-${uniqueSuffix}`, 'CONCTEST manual concurrency promo']
        );
        testPromoCodeId = promoRows[0].id;

        const { rows: txRows } = await client.query(
            `INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id, flash_sale_id, flash_sale_restored)
             VALUES ($1, $2, $3, $4, $5, 'Pending', $6, $7, FALSE) RETURNING id`,
            [invoiceId, testUserId, testProductId, targetGameId, ORDER_PRICE, providerTrxId, testFlashSaleId]
        );
        testTransactionId = txRows[0].id;

        await client.query(
            `INSERT INTO promo_usages (promo_code_id, user_id, product_id, transaction_id, customer_game_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [testPromoCodeId, testUserId, testProductId, testTransactionId, targetGameId]
        );

        await client.query(
            `INSERT INTO balance_history (user_id, amount, type, description, reference_id)
             VALUES ($1, $2, 'Purchase', $3, $4)`,
            [testUserId, -ORDER_PRICE, `CONCTEST Purchase (${invoiceId})`, invoiceId]
        );

        const fixture = {
            uniqueSuffix,
            invoiceId,
            providerTrxId,
            testUserId,
            testFlashSaleId,
            testPromoCodeId,
            testTransactionId
        };

        const readState = async () => {
            const { rows: uRows } = await client.query('SELECT balance FROM users WHERE id = $1', [testUserId]);
            const { rows: tRows } = await client.query('SELECT status, flash_sale_restored FROM transactions WHERE invoice_id = $1', [invoiceId]);
            const { rows: rRows } = await client.query("SELECT COUNT(*)::int AS cnt FROM balance_history WHERE reference_id = $1 AND type = 'Refund'", [invoiceId]);
            const { rows: fRows } = await client.query('SELECT uses_count FROM flash_sales WHERE id = $1', [testFlashSaleId]);
            const { rows: pRows } = await client.query('SELECT uses_count FROM promo_codes WHERE id = $1', [testPromoCodeId]);
            const { rows: puRows } = await client.query('SELECT COUNT(*)::int AS cnt FROM promo_usages WHERE transaction_id = $1', [testTransactionId]);
            return {
                finalBalance: Number(uRows[0].balance),
                finalStatus: tRows[0].status,
                flashSaleRestored: Boolean(tRows[0].flash_sale_restored),
                refundRowCount: rRows[0].cnt,
                flashSaleUsesCount: Number(fRows[0].uses_count),
                promoUsesCount: Number(pRows[0].uses_count),
                promoUsageRowCount: puRows[0].cnt
            };
        };

        return await callbackFn(fixture, readState);
    } finally {
        try {
            if (testUserId) {
                await client.query('DELETE FROM notifications WHERE user_id = $1', [testUserId]).catch(() => {});
            }
            if (testTransactionId || testPromoCodeId) {
                await client.query(
                    'DELETE FROM promo_usages WHERE transaction_id = $1 OR promo_code_id = $2',
                    [testTransactionId, testPromoCodeId]
                ).catch(() => {});
            }
            if (testUserId) {
                await client.query(
                    'DELETE FROM balance_history WHERE user_id = $1 OR reference_id = $2',
                    [testUserId, invoiceId]
                ).catch(() => {});
            }
            if (testTransactionId) {
                await client.query('DELETE FROM transactions WHERE id = $1', [testTransactionId]).catch(() => {});
            }
            if (testFlashSaleId) {
                await client.query('DELETE FROM flash_sales WHERE id = $1', [testFlashSaleId]).catch(() => {});
            }
            if (testPromoCodeId) {
                await client.query('DELETE FROM promo_codes WHERE id = $1', [testPromoCodeId]).catch(() => {});
            }
            if (testProductId) {
                await client.query('DELETE FROM products WHERE id = $1', [testProductId]).catch(() => {});
            }
            if (testCategoryId) {
                await client.query('DELETE FROM product_categories WHERE id = $1', [testCategoryId]).catch(() => {});
            }
            if (testGameId) {
                await client.query('DELETE FROM games WHERE id = $1', [testGameId]).catch(() => {});
            }
            if (testUserId) {
                await client.query('DELETE FROM users WHERE id = $1', [testUserId]).catch(() => {});
            }
        } finally {
            client.release();
        }
    }
}

function isSuccessStateValid(state) {
    return (
        state.finalStatus === 'Success' &&
        state.refundRowCount === 0 &&
        state.finalBalance === BALANCE_AFTER_ORDER &&
        state.flashSaleRestored === false &&
        state.flashSaleUsesCount === 1 &&
        state.promoUsesCount === 1 &&
        state.promoUsageRowCount === 1
    );
}

function isFailedStateValid(state) {
    return (
        state.finalStatus === 'Failed' &&
        state.refundRowCount === 1 &&
        state.finalBalance === INITIAL_BALANCE &&
        state.flashSaleRestored === true &&
        state.flashSaleUsesCount === 0 &&
        state.promoUsesCount === 0 &&
        state.promoUsageRowCount === 0
    );
}

async function main() {
    const origAxiosGet = axios.get;
    const origAxiosPost = axios.post;
    const origAxiosRequest = axios.request;

    const mockStatusByTrxId = new Map();
    let mockFoxyServer = null;
    let appServer = null;

    try {
        // 1. Jalankan mock HTTP server Foxy lokal agar /v1/status tidak pernah memanggil Foxy sungguhan
        mockFoxyServer = http.createServer((req, res) => {
            if (req.url && req.url.startsWith('/v1/status/')) {
                const reqTrxId = decodeURIComponent(req.url.slice('/v1/status/'.length).split('?')[0]);
                const targetStatus = mockStatusByTrxId.get(reqTrxId) || 'SUCCESS';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: true,
                    data: {
                        status: targetStatus,
                        sn: targetStatus === 'SUCCESS' ? `CONCTEST-SN-${reqTrxId}` : ''
                    }
                }));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: false, message: 'Mock Foxy: endpoint not mocked' }));
        });
        await new Promise(resolve => mockFoxyServer.listen(0, '127.0.0.1', resolve));
        const mockFoxyBaseUrl = `http://127.0.0.1:${mockFoxyServer.address().port}`;

        axios.get = async (url, config) => {
            if (typeof url === 'string' && url.includes('foxygamestore.com')) {
                const parsed = new URL(url);
                if (parsed.pathname.startsWith('/v1/status/')) {
                    return origAxiosGet(`${mockFoxyBaseUrl}${parsed.pathname}${parsed.search}`, config);
                }
                throw new Error(`[CONCTEST] Panggilan ke Foxy sungguhan diblokir: ${parsed.pathname}`);
            }
            return origAxiosGet(url, config);
        };
        axios.post = async (url, data, config) => {
            if (typeof url === 'string' && url.includes('foxygamestore.com')) {
                throw new Error(`[CONCTEST] Panggilan POST ke Foxy sungguhan diblokir: ${url}`);
            }
            return origAxiosPost(url, data, config);
        };
        axios.request = async (config) => {
            const reqUrl = config && config.url ? String(config.url) : '';
            if (reqUrl.includes('foxygamestore.com')) {
                throw new Error(`[CONCTEST] Panggilan request ke Foxy sungguhan diblokir: ${reqUrl}`);
            }
            return origAxiosRequest(config);
        };

        // 2. Jalankan Express app pada port ephemeral lokal
        appServer = startServer(0);
        const callbackUrl = `http://127.0.0.1:${appServer.address().port}/api/foxy/callback`;

        console.log(`[concurrency] Database target: ${dbName}@${dbHost}`);
        console.log(`[concurrency] Mock Foxy URL  : ${mockFoxyBaseUrl}`);

        // === SKENARIO A: Success dulu -> 20 refund + 20 callback FAILED bersamaan ===
        const passA = await withIsolatedFixture('A', async (fx, readState) => {
            mockStatusByTrxId.set(fx.providerTrxId, 'SUCCESS');
            const initialCb = await sendCallback(callbackUrl, fx.providerTrxId, 'SUCCESS', `CONCTEST-SN-${fx.uniqueSuffix}`);
            const midState = await readState();
            if (initialCb.status !== 200 || midState.finalStatus !== 'Success') {
                console.log(`[FAIL] Skenario A (Success dulu): prasyarat callback Success gagal (http=${initialCb.status}, status=${midState.finalStatus})`);
                return false;
            }

            // Setelah status Success terkonfirmasi di DB, kirim 20 refund + 20 callback FAILED bersamaan
            mockStatusByTrxId.set(fx.providerTrxId, 'FAILED');
            const tasks = [];
            for (let i = 0; i < CONCURRENT_COUNT; i++) {
                tasks.push(runRefundAttempt(fx.invoiceId));
                tasks.push(sendCallback(callbackUrl, fx.providerTrxId, 'FAILED', ''));
            }
            await Promise.all(tasks);

            const endState = await readState();
            const ok = isSuccessStateValid(endState);
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario A (Success dulu): status=${endState.finalStatus}, ` +
                `refundRows=${endState.refundRowCount}, balance=${endState.finalBalance}, ` +
                `flashSaleRestored=${endState.flashSaleRestored}, fsUses=${endState.flashSaleUsesCount}, ` +
                `promoUses=${endState.promoUsesCount}, promoUsages=${endState.promoUsageRowCount}`
            );
            return ok;
        });

        // === SKENARIO B: Refund dulu (20x bersamaan) -> 20 callback Success ===
        const passB = await withIsolatedFixture('B', async (fx, readState) => {
            const refundTasks = [];
            for (let i = 0; i < CONCURRENT_COUNT; i++) {
                refundTasks.push(runRefundAttempt(fx.invoiceId));
            }
            await Promise.all(refundTasks);

            mockStatusByTrxId.set(fx.providerTrxId, 'SUCCESS');
            const cbTasks = [];
            for (let i = 0; i < CONCURRENT_COUNT; i++) {
                cbTasks.push(sendCallback(callbackUrl, fx.providerTrxId, 'SUCCESS', `CONCTEST-SN-${fx.uniqueSuffix}`));
            }
            await Promise.all(cbTasks);

            const endState = await readState();
            const ok = isFailedStateValid(endState);
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario B (Refund dulu): status=${endState.finalStatus}, ` +
                `refundRows=${endState.refundRowCount}, balance=${endState.finalBalance}, ` +
                `flashSaleRestored=${endState.flashSaleRestored}, fsUses=${endState.flashSaleUsesCount}, ` +
                `promoUses=${endState.promoUsesCount}, promoUsages=${endState.promoUsageRowCount}`
            );
            return ok;
        });

        // === SKENARIO C: Balapan acak (20 callback Success + 20 refund bersamaan, jeda acak 0-30 ms) x 15 putaran ===
        let cSuccessWins = 0;
        let cFailedWins = 0;
        let cViolations = 0;

        for (let round = 1; round <= RANDOM_RACE_ROUNDS; round++) {
            const roundOk = await withIsolatedFixture(`C${round}`, async (fx, readState) => {
                mockStatusByTrxId.set(fx.providerTrxId, 'SUCCESS');
                const raceTasks = [];
                for (let i = 0; i < CONCURRENT_COUNT; i++) {
                    raceTasks.push(
                        sendCallback(
                            callbackUrl,
                            fx.providerTrxId,
                            'SUCCESS',
                            `CONCTEST-SN-${fx.uniqueSuffix}`,
                            randomDelayMs()
                        )
                    );
                    raceTasks.push(runRefundAttempt(fx.invoiceId, randomDelayMs()));
                }
                await Promise.all(raceTasks);

                const endState = await readState();
                if (isSuccessStateValid(endState)) {
                    cSuccessWins += 1;
                    return true;
                }
                if (isFailedStateValid(endState)) {
                    cFailedWins += 1;
                    return true;
                }
                console.error(
                    `  [FAIL] Putaran C#${round}: invarian dilanggar -> status=${endState.finalStatus}, ` +
                    `refundRows=${endState.refundRowCount}, balance=${endState.finalBalance}, ` +
                    `flashSaleRestored=${endState.flashSaleRestored}, fsUses=${endState.flashSaleUsesCount}, ` +
                    `promoUses=${endState.promoUsesCount}, promoUsages=${endState.promoUsageRowCount}`
                );
                return false;
            });
            if (!roundOk) cViolations += 1;
        }

        const passC = cViolations === 0;
        console.log(
            `[${passC ? 'PASS' : 'FAIL'}] Skenario C (Balapan acak ${RANDOM_RACE_ROUNDS}x): ` +
            `Success=${cSuccessWins}, Failed=${cFailedWins}, Pelanggaran=${cViolations}`
        );

        if (!passA || !passB || !passC) {
            process.exitCode = 1;
        }
    } finally {
        axios.get = origAxiosGet;
        axios.post = origAxiosPost;
        axios.request = origAxiosRequest;

        if (appServer) {
            await new Promise(resolve => appServer.close(resolve)).catch(() => {});
        }
        if (mockFoxyServer) {
            await new Promise(resolve => mockFoxyServer.close(resolve)).catch(() => {});
        }
        await pool.end().catch(() => {});
    }
}

main().catch(err => {
    console.error('[ERROR] Concurrency test gagal:', err);
    process.exit(1);
});
