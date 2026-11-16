/**
 * Manual PostgreSQL Idempotency Test (SEC-009)
 * Menguji idempotency key & race protection pada PostgreSQL lokal asli dengan fixture
 * berawalan CONCTEST- yang terisolasi dan dibersihkan di blok try/finally:
 *   A. 20 POST /h2h/order paralel dengan ref_id sama -> 1 baris transactions, 1 potong saldo, semua 201/200 sama
 *   B. 20 POST /api/order paralel dengan Idempotency-Key sama -> 1 baris transactions, 1 potong saldo, semua 201/200 sama
 *   C. 20 POST /api/deposit/request paralel dengan Idempotency-Key sama -> 1 deposit
 *   D. ref_id sama tetapi produk berbeda -> 409 Conflict, tanpa transaksi tambahan
 *   E. Setelah order Failed (refund provider), ref_id sama mengembalikan hasil lama; ref_id baru memproses normal
 *
 * Cara menjalankan (dari folder backend/):
 *   node tests/manual/idempotency.js
 *   (atau tambahkan --i-know-this-is-local jika DB_NAME tidak mengandung dev/local/test)
 *
 * Catatan keamanan:
 * - Script ini TIDAK dijalankan oleh `npm test`.
 * - Menolak berjalan jika NODE_ENV === 'production'.
 * - Menolak berjalan jika DB_HOST bukan localhost / 127.0.0.1.
 * - Menolak berjalan jika DB_NAME tidak mengandung dev/local/test tanpa flag --i-know-this-is-local.
 * - Tidak pernah memanggil jaringan eksternal/Foxy sungguhan: /v1/products & /v1/order
 *   dilayani server tiruan lokal, dan panggilan ke host non-loopback diblokir.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// === SAFETY GUARDS SEBELUM MENYENTUH DATABASE ATAU MEMUAT SERVER ===
if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] Script idempotency test tidak boleh dijalankan pada NODE_ENV=production.');
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

if (!(process.env.JWT_SECRET || '').trim()) {
    process.env.JWT_SECRET = 'conctest-local-jwt-secret';
}
if (!(process.env.FOXY_API_KEY || '').trim()) {
    process.env.FOXY_API_KEY = 'conctest-local-foxy-key';
}

const axios = require('axios');
const jwt = require('jsonwebtoken');
const { pool } = require('../../config/db.js');
const { startServer } = require('../../server.js');
const { invalidateFoxyProductCache } = require('../../services/foxyClient.js');

const PARALLEL_COUNT = 20;
const INITIAL_BALANCE = 500000;
const PROD1_BASE_PRICE = 10000;
const PROD2_BASE_PRICE = 20000;
const PROD1_COST = 9000;
const PROD2_COST = 18000;

function readJsonRequestBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (_) {
                resolve({});
            }
        });
    });
}

function isLoopbackUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
    } catch (_) {
        return false;
    }
}

async function main() {
    const origAxiosGet = axios.get;
    const origAxiosPost = axios.post;
    const origAxiosRequest = axios.request;

    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const trackedIds = {
        userIds: [],
        productIds: [],
        categoryIds: [],
        gameIds: [],
        paymentMethodIds: []
    };

    const mockProducts = [];
    let foxyOrderCalls = 0;
    let foxyRejectNextOrder = false;

    let mockFoxyServer = null;
    let appServer = null;

    const adminClient = await pool.connect();
    let cleanupClient = null;

    try {
        // 0. Pastikan migrasi 011 sudah diterapkan pada DB target
        const { rows: schemaCols } = await adminClient.query(
            `SELECT table_name, column_name
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND ((table_name = 'transactions' AND column_name = 'ref_id')
                 OR (table_name = 'deposits' AND column_name = 'idempotency_key'))`
        );
        const { rows: schemaIdx } = await adminClient.query(
            `SELECT indexname
             FROM pg_indexes
             WHERE schemaname = 'public'
               AND indexname IN ('uq_transactions_user_ref_id', 'uq_deposits_user_idempotency_key')`
        );
        if (schemaCols.length < 2 || schemaIdx.length < 2) {
            throw new Error(
                'Skema DB belum memiliki kolom/index migrasi 011 (transactions.ref_id / deposits.idempotency_key). ' +
                'Jalankan terlebih dahulu: psql -U <user> -d <db> -f migrations/011_add_idempotency_keys.sql'
            );
        }

        // 1. Jalankan mock Foxy HTTP server lokal & blokir seluruh panggilan jaringan eksternal
        mockFoxyServer = http.createServer(async (req, res) => {
            const pathname = (req.url || '').split('?')[0];
            if (req.method === 'GET' && pathname === '/v1/products') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: true, data: mockProducts }));
                return;
            }
            if (req.method === 'POST' && pathname === '/v1/order') {
                await readJsonRequestBody(req);
                foxyOrderCalls += 1;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (foxyRejectNextOrder) {
                    res.end(JSON.stringify({ status: false, message: 'CONCTEST mock Foxy rejection' }));
                } else {
                    res.end(JSON.stringify({ status: true, message: 'CONCTEST mock Foxy accepted' }));
                }
                return;
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: false, message: 'Mock Foxy: endpoint not mocked' }));
        });
        await new Promise((resolve) => mockFoxyServer.listen(0, '127.0.0.1', resolve));
        const mockFoxyBaseUrl = `http://127.0.0.1:${mockFoxyServer.address().port}`;

        const rewriteOrBlockUrl = (url) => {
            const strUrl = String(url || '');
            let parsed;
            try {
                parsed = new URL(strUrl);
            } catch (_) {
                throw new Error(`[CONCTEST] URL tidak valid diblokir: ${strUrl}`);
            }
            if (parsed.hostname.toLowerCase().endsWith('foxygamestore.com')) {
                if (parsed.pathname === '/v1/products' || parsed.pathname === '/v1/order') {
                    return `${mockFoxyBaseUrl}${parsed.pathname}${parsed.search}`;
                }
                throw new Error(`[CONCTEST] Endpoint Foxy tidak dimock diblokir: ${parsed.pathname}`);
            }
            if (!isLoopbackUrl(strUrl)) {
                throw new Error(`[CONCTEST] Panggilan jaringan eksternal diblokir: ${parsed.hostname}`);
            }
            return strUrl;
        };

        axios.get = async (url, config) => origAxiosGet(rewriteOrBlockUrl(url), config);
        axios.post = async (url, data, config) => origAxiosPost(rewriteOrBlockUrl(url), data, config);
        axios.request = async (config) => {
            const nextUrl = rewriteOrBlockUrl(config && config.url);
            return origAxiosRequest({ ...config, url: nextUrl });
        };

        // 2. Buat fixture bersama (role, game, category, 2 produk aktif, 1 payment_method aktif)
        const { rows: roleRows } = await adminClient.query(
            'SELECT id, name, margin_percent FROM roles ORDER BY id ASC LIMIT 1'
        );
        if (roleRows.length === 0) {
            throw new Error('Tabel roles kosong. Jalankan setup_db.sql / seeder terlebih dahulu.');
        }
        const roleId = roleRows[0].id;
        const roleName = roleRows[0].name;
        const roleMargin = Number(roleRows[0].margin_percent || 0);
        const expectedPrice1 = Math.ceil(PROD1_BASE_PRICE * (1 + (roleMargin / 100)));

        const { rows: gameRows } = await adminClient.query(
            `INSERT INTO games (name, category, image_url, needs_server_id, status)
             VALUES ($1, 'Testing', 'https://via.placeholder.com/200', FALSE, 'Active') RETURNING id`,
            [`CONCTEST-Game-${uniqueSuffix}`]
        );
        const testGameId = gameRows[0].id;
        trackedIds.gameIds.push(testGameId);

        const { rows: catRows } = await adminClient.query(
            `INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id`,
            [testGameId, `CONCTEST-Cat-${uniqueSuffix}`]
        );
        const testCategoryId = catRows[0].id;
        trackedIds.categoryIds.push(testCategoryId);

        const sku1 = `CONCTEST-SKU1-${uniqueSuffix}`;
        const sku2 = `CONCTEST-SKU2-${uniqueSuffix}`;
        const { rows: prod1Rows } = await adminClient.query(
            `INSERT INTO products (game_id, category_id, name, provider_sku, price, status, validation_config, use_manual_prices, manual_prices)
             VALUES ($1, $2, $3, $4, $5, 'Active', NULL, FALSE, '{}'::jsonb) RETURNING id`,
            [testGameId, testCategoryId, `CONCTEST-Prod1-${uniqueSuffix}`, sku1, PROD1_BASE_PRICE]
        );
        const prod1Id = prod1Rows[0].id;
        trackedIds.productIds.push(prod1Id);

        const { rows: prod2Rows } = await adminClient.query(
            `INSERT INTO products (game_id, category_id, name, provider_sku, price, status, validation_config, use_manual_prices, manual_prices)
             VALUES ($1, $2, $3, $4, $5, 'Active', NULL, FALSE, '{}'::jsonb) RETURNING id`,
            [testGameId, testCategoryId, `CONCTEST-Prod2-${uniqueSuffix}`, sku2, PROD2_BASE_PRICE]
        );
        const prod2Id = prod2Rows[0].id;
        trackedIds.productIds.push(prod2Id);

        mockProducts.push(
            { product_code: sku1, product_price: PROD1_COST },
            { product_code: sku2, product_price: PROD2_COST }
        );

        const pmCode = `CONCTEST-QRIS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const pmName = `CONCTEST QRIS ${uniqueSuffix}`;
        const { rows: pmRows } = await adminClient.query(
            `INSERT INTO payment_methods (code, name, type, account_number, account_name, is_qris, min_amount, is_active, sort_order)
             VALUES ($1, $2, 'qris', NULL, 'CONCTEST Admin', TRUE, 10000, TRUE, 999) RETURNING id`,
            [pmCode, pmName]
        );
        trackedIds.paymentMethodIds.push(pmRows[0].id);

        const createFixtureUser = async (label, initialBalance = INITIAL_BALANCE) => {
            const rawApiKey = crypto.randomBytes(32).toString('hex');
            const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
            const apiKeyPrefix = rawApiKey.slice(0, 8);
            const userSuffix = `${label}-${uniqueSuffix}`;
            const username = `CONCTEST-${userSuffix}`;
            const { rows: uRows } = await adminClient.query(
                `INSERT INTO users (
                    full_name, username, email, nomor_wa, password, balance, role_id,
                    api_key, api_key_hash, api_key_prefix, whitelisted_ips, h2h_callback_url, h2h_webhook_secret
                 ) VALUES ($1, $2, $3, NULL, $4, $5, $6, NULL, $7, $8, '{}', NULL, $9) RETURNING id`,
                [
                    `CONCTEST ${userSuffix}`,
                    username,
                    `CONCTEST-${userSuffix}@example.local`,
                    'CONCTEST-hash-not-for-login',
                    initialBalance,
                    roleId,
                    apiKeyHash,
                    apiKeyPrefix,
                    `CONCTEST-whsec-${userSuffix}`
                ]
            );
            const userId = uRows[0].id;
            trackedIds.userIds.push(userId);
            const token = jwt.sign(
                { id: userId, username, role: roleName },
                process.env.JWT_SECRET,
                { expiresIn: '1h' }
            );
            return { userId, apiKey: rawApiKey, token };
        };

        // 3. Jalankan Express app pada port ephemeral lokal
        appServer = startServer(0);
        const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
        invalidateFoxyProductCache();

        console.log(`[idempotency] Database target: ${dbName}@${dbHost}`);
        console.log(`[idempotency] Mock Foxy URL  : ${mockFoxyBaseUrl}`);

        // === SKENARIO A: 20 POST /h2h/order paralel dengan ref_id sama ===
        const runScenarioA = async () => {
            const userA = await createFixtureUser('A');
            const refA = `CONCTEST-REF-A-${uniqueSuffix}`;
            const callsBefore = foxyOrderCalls;
            const responses = await Promise.all(
                Array.from({ length: PARALLEL_COUNT }, () =>
                    fetch(`${baseUrl}/h2h/order`, {
                        method: 'POST',
                        headers: { 'X-API-Key': userA.apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            productId: prod1Id,
                            targetGameId: `CONCTEST-UID-A-${uniqueSuffix}`,
                            ref_id: refA
                        })
                    }).then(async (res) => ({ status: res.status, body: await res.json() }))
                )
            );
            const callsDelta = foxyOrderCalls - callsBefore;
            const count201 = responses.filter((r) => r.status === 201).length;
            const count200 = responses.filter((r) => r.status === 200).length;
            const idempotentFlags = responses.filter((r) => r.body && r.body.idempotent === true).length;
            const invoices = [...new Set(responses.map((r) => r.body && r.body.data && r.body.data.invoiceId).filter(Boolean))];

            const { rows: txRows } = await adminClient.query(
                'SELECT invoice_id, price, status, ref_id FROM transactions WHERE user_id = $1',
                [userA.userId]
            );
            const { rows: histRows } = await adminClient.query(
                "SELECT COUNT(*)::int AS cnt FROM balance_history WHERE user_id = $1 AND type = 'Purchase'",
                [userA.userId]
            );
            const { rows: userRows } = await adminClient.query(
                'SELECT balance FROM users WHERE id = $1',
                [userA.userId]
            );
            const finalBalance = Number(userRows[0].balance);

            const ok = (
                count201 === 1 &&
                count200 === PARALLEL_COUNT - 1 &&
                idempotentFlags === PARALLEL_COUNT - 1 &&
                invoices.length === 1 &&
                /^H2H-[A-F0-9]{16,}$/.test(invoices[0]) &&
                txRows.length === 1 &&
                txRows[0].invoice_id === invoices[0] &&
                txRows[0].ref_id === refA &&
                histRows[0].cnt === 1 &&
                finalBalance === INITIAL_BALANCE - expectedPrice1 &&
                callsDelta === 1
            );
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario A (20x H2H paralel ref_id sama): ` +
                `201=${count201}, 200=${count200}, uniqueInvoices=${invoices.length}, ` +
                `txRows=${txRows.length}, purchaseRows=${histRows[0].cnt}, balance=${finalBalance}, foxyCalls=${callsDelta}`
            );
            return ok;
        };

        // === SKENARIO B: 20 POST /api/order paralel dengan Idempotency-Key sama ===
        const runScenarioB = async () => {
            const userB = await createFixtureUser('B');
            const keyB = crypto.randomUUID();
            const callsBefore = foxyOrderCalls;
            const responses = await Promise.all(
                Array.from({ length: PARALLEL_COUNT }, () =>
                    fetch(`${baseUrl}/api/order`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${userB.token}`,
                            'Content-Type': 'application/json',
                            'Idempotency-Key': keyB
                        },
                        body: JSON.stringify({
                            productId: prod1Id,
                            targetGameId: `CONCTEST-UID-B-${uniqueSuffix}`
                        })
                    }).then(async (res) => ({ status: res.status, body: await res.json() }))
                )
            );
            const callsDelta = foxyOrderCalls - callsBefore;
            const count201 = responses.filter((r) => r.status === 201).length;
            const count200 = responses.filter((r) => r.status === 200).length;
            const idempotentFlags = responses.filter((r) => r.body && r.body.idempotent === true).length;
            const invoices = [...new Set(responses.map((r) => r.body && r.body.invoiceId).filter(Boolean))];

            const { rows: txRows } = await adminClient.query(
                'SELECT invoice_id, price, status, ref_id FROM transactions WHERE user_id = $1',
                [userB.userId]
            );
            const { rows: histRows } = await adminClient.query(
                "SELECT COUNT(*)::int AS cnt FROM balance_history WHERE user_id = $1 AND type = 'Purchase'",
                [userB.userId]
            );
            const { rows: userRows } = await adminClient.query(
                'SELECT balance FROM users WHERE id = $1',
                [userB.userId]
            );
            const finalBalance = Number(userRows[0].balance);

            const ok = (
                count201 === 1 &&
                count200 === PARALLEL_COUNT - 1 &&
                idempotentFlags === PARALLEL_COUNT - 1 &&
                invoices.length === 1 &&
                /^TRX-[A-F0-9]{16,}$/.test(invoices[0]) &&
                txRows.length === 1 &&
                txRows[0].invoice_id === invoices[0] &&
                txRows[0].ref_id === keyB.toLowerCase() &&
                histRows[0].cnt === 1 &&
                finalBalance === INITIAL_BALANCE - expectedPrice1 &&
                callsDelta === 1
            );
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario B (20x Web /api/order paralel Idempotency-Key sama): ` +
                `201=${count201}, 200=${count200}, uniqueInvoices=${invoices.length}, ` +
                `txRows=${txRows.length}, purchaseRows=${histRows[0].cnt}, balance=${finalBalance}, foxyCalls=${callsDelta}`
            );
            return ok;
        };

        // === SKENARIO C: 20 POST /api/deposit/request paralel dengan Idempotency-Key sama ===
        const runScenarioC = async () => {
            const userC = await createFixtureUser('C', 0);
            const keyC = crypto.randomUUID();
            const responses = await Promise.all(
                Array.from({ length: PARALLEL_COUNT }, () =>
                    fetch(`${baseUrl}/api/deposit/request`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${userC.token}`,
                            'Content-Type': 'application/json',
                            'Idempotency-Key': keyC
                        },
                        body: JSON.stringify({
                            amount: 50000,
                            method: pmCode,
                            note: `CONCTEST-DEP-${uniqueSuffix}`
                        })
                    }).then(async (res) => ({ status: res.status, body: await res.json() }))
                )
            );
            const count201 = responses.filter((r) => r.status === 201).length;
            const count200 = responses.filter((r) => r.status === 200).length;
            const idempotentFlags = responses.filter((r) => r.body && r.body.idempotent === true).length;
            const depIds = [...new Set(responses.map((r) => r.body && r.body.deposit && r.body.deposit.id).filter(Boolean))];

            const { rows: depRows } = await adminClient.query(
                'SELECT id, idempotency_key FROM deposits WHERE user_id = $1',
                [userC.userId]
            );

            const ok = (
                count201 === 1 &&
                count200 === PARALLEL_COUNT - 1 &&
                idempotentFlags === PARALLEL_COUNT - 1 &&
                depIds.length === 1 &&
                depRows.length === 1 &&
                depRows[0].id === depIds[0] &&
                depRows[0].idempotency_key === keyC.toLowerCase()
            );
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario C (20x Deposit paralel Idempotency-Key sama): ` +
                `201=${count201}, 200=${count200}, uniqueDepositIds=${depIds.length}, depRows=${depRows.length}`
            );
            return ok;
        };

        // === SKENARIO D: ref_id sama tetapi produk berbeda -> 409, tanpa transaksi tambahan ===
        const runScenarioD = async () => {
            const userD = await createFixtureUser('D');
            const refD = `CONCTEST-REF-D-${uniqueSuffix}`;
            const targetUid = `CONCTEST-UID-D-${uniqueSuffix}`;
            const callsBefore = foxyOrderCalls;

            const res1 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': userD.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: prod1Id, targetGameId: targetUid, ref_id: refD })
            });
            const res2 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': userD.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: prod2Id, targetGameId: targetUid, ref_id: refD })
            });
            const callsDelta = foxyOrderCalls - callsBefore;

            const { rows: txRows } = await adminClient.query(
                'SELECT product_id FROM transactions WHERE user_id = $1',
                [userD.userId]
            );
            const { rows: userRows } = await adminClient.query(
                'SELECT balance FROM users WHERE id = $1',
                [userD.userId]
            );
            const finalBalance = Number(userRows[0].balance);

            const ok = (
                res1.status === 201 &&
                res2.status === 409 &&
                txRows.length === 1 &&
                Number(txRows[0].product_id) === prod1Id &&
                finalBalance === INITIAL_BALANCE - expectedPrice1 &&
                callsDelta === 1
            );
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario D (ref_id sama, produk berbeda -> 409): ` +
                `first=${res1.status}, conflict=${res2.status}, txRows=${txRows.length}, ` +
                `balance=${finalBalance}, foxyCalls=${callsDelta}`
            );
            return ok;
        };

        // === SKENARIO E: Setelah order Failed (refund), ref_id sama kembalikan hasil lama; ref_id baru proses normal ===
        const runScenarioE = async () => {
            const userE = await createFixtureUser('E');
            const refFail = `CONCTEST-REF-E1-${uniqueSuffix}`;
            const refNew = `CONCTEST-REF-E2-${uniqueSuffix}`;
            const targetUid = `CONCTEST-UID-E-${uniqueSuffix}`;

            foxyRejectNextOrder = true;
            const resFail = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': userE.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: prod1Id, targetGameId: targetUid, ref_id: refFail })
            });
            foxyRejectNextOrder = false;

            const { rows: afterFailTx } = await adminClient.query(
                'SELECT invoice_id, status FROM transactions WHERE user_id = $1 AND ref_id = $2',
                [userE.userId, refFail]
            );
            const { rows: afterFailUser } = await adminClient.query(
                'SELECT balance FROM users WHERE id = $1',
                [userE.userId]
            );
            const { rows: refundRows } = await adminClient.query(
                "SELECT COUNT(*)::int AS cnt FROM balance_history WHERE user_id = $1 AND type = 'Refund'",
                [userE.userId]
            );

            const callsBeforeReplay = foxyOrderCalls;
            const resReplay = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': userE.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: prod1Id, targetGameId: targetUid, ref_id: refFail })
            });
            const bodyReplay = await resReplay.json();
            const replayFoxyCalls = foxyOrderCalls - callsBeforeReplay;

            const resNew = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': userE.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: prod1Id, targetGameId: targetUid, ref_id: refNew })
            });
            const bodyNew = await resNew.json();

            const { rows: finalTxRows } = await adminClient.query(
                'SELECT invoice_id, status, ref_id FROM transactions WHERE user_id = $1 ORDER BY id ASC',
                [userE.userId]
            );
            const { rows: finalUserRows } = await adminClient.query(
                'SELECT balance FROM users WHERE id = $1',
                [userE.userId]
            );
            const finalBalance = Number(finalUserRows[0].balance);

            const failedInvoice = afterFailTx[0] && afterFailTx[0].invoice_id;
            const ok = (
                resFail.status === 400 &&
                afterFailTx.length === 1 &&
                afterFailTx[0].status === 'Failed' &&
                Number(afterFailUser[0].balance) === INITIAL_BALANCE &&
                refundRows[0].cnt === 1 &&
                resReplay.status === 200 &&
                bodyReplay.idempotent === true &&
                bodyReplay.data &&
                bodyReplay.data.invoiceId === failedInvoice &&
                bodyReplay.data.status === 'Failed' &&
                replayFoxyCalls === 0 &&
                resNew.status === 201 &&
                bodyNew.data &&
                bodyNew.data.invoiceId !== failedInvoice &&
                finalTxRows.length === 2 &&
                finalBalance === INITIAL_BALANCE - expectedPrice1
            );
            console.log(
                `[${ok ? 'PASS' : 'FAIL'}] Skenario E (Failed/refund replay vs ref_id baru): ` +
                `failHttp=${resFail.status}, replayHttp=${resReplay.status}(status=${bodyReplay.data && bodyReplay.data.status}), ` +
                `replayFoxyCalls=${replayFoxyCalls}, newHttp=${resNew.status}, txCount=${finalTxRows.length}, balance=${finalBalance}`
            );
            return ok;
        };

        const passA = await runScenarioA();
        const passB = await runScenarioB();
        const passC = await runScenarioC();
        const passD = await runScenarioD();
        const passE = await runScenarioE();

        if (!passA || !passB || !passC || !passD || !passE) {
            process.exitCode = 1;
        }
    } finally {
        adminClient.release();

        axios.get = origAxiosGet;
        axios.post = origAxiosPost;
        axios.request = origAxiosRequest;

        if (appServer) {
            await new Promise((resolve) => appServer.close(resolve)).catch(() => {});
        }
        if (mockFoxyServer) {
            await new Promise((resolve) => mockFoxyServer.close(resolve)).catch(() => {});
        }

        // Bersihkan seluruh fixture CONCTEST- di DB lokal pada blok finally
        try {
            cleanupClient = await pool.connect();
            if (trackedIds.userIds.length > 0) {
                await cleanupClient.query('DELETE FROM notifications WHERE user_id = ANY($1::int[])', [trackedIds.userIds]).catch(() => {});
                await cleanupClient.query('DELETE FROM promo_usages WHERE user_id = ANY($1::int[])', [trackedIds.userIds]).catch(() => {});
                await cleanupClient.query('DELETE FROM balance_history WHERE user_id = ANY($1::int[])', [trackedIds.userIds]).catch(() => {});
                await cleanupClient.query('DELETE FROM deposits WHERE user_id = ANY($1::int[])', [trackedIds.userIds]).catch(() => {});
                await cleanupClient.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [trackedIds.userIds]).catch(() => {});
            }
            if (trackedIds.productIds.length > 0) {
                await cleanupClient.query('DELETE FROM products WHERE id = ANY($1::int[])', [trackedIds.productIds]).catch(() => {});
            }
            if (trackedIds.categoryIds.length > 0) {
                await cleanupClient.query('DELETE FROM product_categories WHERE id = ANY($1::int[])', [trackedIds.categoryIds]).catch(() => {});
            }
            if (trackedIds.gameIds.length > 0) {
                await cleanupClient.query('DELETE FROM games WHERE id = ANY($1::int[])', [trackedIds.gameIds]).catch(() => {});
            }
            if (trackedIds.paymentMethodIds.length > 0) {
                await cleanupClient.query('DELETE FROM payment_methods WHERE id = ANY($1::int[])', [trackedIds.paymentMethodIds]).catch(() => {});
            }
            if (trackedIds.userIds.length > 0) {
                await cleanupClient.query('DELETE FROM users WHERE id = ANY($1::int[])', [trackedIds.userIds]).catch(() => {});
            }
        } catch (cleanupErr) {
            console.error('[WARN] Cleanup fixture CONCTEST gagal sebagian:', cleanupErr.message);
        } finally {
            if (cleanupClient) cleanupClient.release();
        }

        await pool.end().catch(() => {});
    }
}

main().catch((err) => {
    console.error('[ERROR] Idempotency manual test gagal:', err);
    process.exit(1);
});
