/**
 * Manual PostgreSQL Connection Pool & 3-Phase Order Test (SEC-013)
 * Menguji bahwa refaktor 3-fase (/api/order & /h2h/order) tidak menahan koneksi DB
 * selama panggilan HTTP eksternal ke Foxy:
 *   - pool.options.max dipastikan 10 koneksi
 *   - Mock Foxy lokal menahan POST /v1/order selama 2.000 ms
 *   - 30 order paralel (15 Web /api/order + 15 H2H /h2h/order) dijalankan bersamaan
 *   - Selama panggilan Foxy masih berlangsung, query DB independen tetap responsif (tanpa pool exhaustion)
 *   - Semua 30 order selesai HTTP 201 tanpa error pool, saldo terpotong tepat, dan
 *     0 transaksi 'Pending' yang tertinggal dengan provider_trx_id IS NULL
 *
 * Cara menjalankan (dari folder backend/):
 *   node tests/manual/pool.js
 *   (atau tambahkan --i-know-this-is-local jika DB_NAME tidak mengandung dev/local/test)
 *
 * Catatan keamanan:
 * - Script ini TIDAK dijalankan oleh `npm test`.
 * - Menolak berjalan jika NODE_ENV === 'production'.
 * - Menolak berjalan jika DB_HOST bukan localhost / 127.0.0.1.
 * - Menolak berjalan jika DB_NAME tidak mengandung dev/local/test tanpa flag --i-know-this-is-local.
 * - Seluruh fixture memakai awalan CONCTEST- dan dibersihkan di blok finally.
 * - Tidak pernah memanggil jaringan eksternal/Foxy sungguhan: /v1/products & /v1/order
 *   dilayani server tiruan lokal, dan panggilan ke host non-loopback diblokir.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// === SAFETY GUARDS SEBELUM MENYENTUH DATABASE ATAU MEMUAT SERVER ===
if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] Script pool test tidak boleh dijalankan pada NODE_ENV=production.');
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

// Pastikan batas pool eksplisit max = 10 sebelum koneksi pertama dibuat
if (pool && pool.options) {
    pool.options.max = 10;
}

const POOL_MAX = 10;
const PARALLEL_TOTAL = 30;
const WEB_ORDER_COUNT = 15;
const H2H_ORDER_COUNT = 15;
const FOXY_ORDER_DELAY_MS = 2000;
const INITIAL_BALANCE = 1000000;
const PROD_BASE_PRICE = 10000;
const PROD_COST = 9000;

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    if (!pool || !pool.options || pool.options.max !== POOL_MAX) {
        throw new Error(`pool.options.max harus ${POOL_MAX}, terdeteksi: ${pool && pool.options && pool.options.max}`);
    }

    const origAxiosGet = axios.get;
    const origAxiosPost = axios.post;
    const origAxiosRequest = axios.request;

    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const trackedIds = {
        userIds: [],
        productIds: [],
        categoryIds: [],
        gameIds: []
    };

    const mockProducts = [];
    let currentInFlightFoxyOrders = 0;
    let peakInFlightFoxyOrders = 0;
    let totalFoxyOrderCalls = 0;
    let probeDuringFoxyOk = false;
    let probeLatencyMs = null;
    let probeTriggered = false;
    let probePromise = null;

    let mockFoxyServer = null;
    let appServer = null;

    const adminClient = await pool.connect();
    let adminReleased = false;
    let cleanupClient = null;

    try {
        // 1. Jalankan mock Foxy HTTP server lokal dengan delay 2 detik pada POST /v1/order
        mockFoxyServer = http.createServer(async (req, res) => {
            const pathname = (req.url || '').split('?')[0];
            if (req.method === 'GET' && pathname === '/v1/products') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: true, data: mockProducts }));
                return;
            }
            if (req.method === 'POST' && pathname === '/v1/order') {
                await readJsonRequestBody(req);
                totalFoxyOrderCalls += 1;
                currentInFlightFoxyOrders += 1;
                if (currentInFlightFoxyOrders > peakInFlightFoxyOrders) {
                    peakInFlightFoxyOrders = currentInFlightFoxyOrders;
                }

                // Saat > pool.options.max request sedang menunggu di Fase (b), buktikan pool DB tidak habis
                if (!probeTriggered && currentInFlightFoxyOrders > POOL_MAX) {
                    probeTriggered = true;
                    const probeStart = Date.now();
                    probePromise = pool.query('SELECT 1 AS alive')
                        .then((r) => {
                            probeLatencyMs = Date.now() - probeStart;
                            probeDuringFoxyOk = Boolean(r && r.rows && r.rows[0] && r.rows[0].alive === 1);
                        })
                        .catch(() => {
                            probeDuringFoxyOk = false;
                        });
                }

                await sleep(FOXY_ORDER_DELAY_MS);
                currentInFlightFoxyOrders -= 1;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: true, message: 'CONCTEST slow Foxy accepted' }));
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

        // 2. Buat fixture produk & user dengan awalan CONCTEST-
        const { rows: roleRows } = await adminClient.query(
            'SELECT id, name, margin_percent FROM roles ORDER BY id ASC LIMIT 1'
        );
        if (roleRows.length === 0) {
            throw new Error('Tabel roles kosong. Jalankan setup_db.sql / seeder terlebih dahulu.');
        }
        const roleId = roleRows[0].id;
        const roleName = roleRows[0].name;
        const roleMargin = Number(roleRows[0].margin_percent || 0);
        const expectedUnitPrice = Math.ceil(PROD_BASE_PRICE * (1 + (roleMargin / 100)));

        const { rows: gameRows } = await adminClient.query(
            `INSERT INTO games (name, category, image_url, needs_server_id, status)
             VALUES ($1, 'Testing', 'https://via.placeholder.com/200', FALSE, 'Active') RETURNING id`,
            [`CONCTEST-PoolGame-${uniqueSuffix}`]
        );
        const testGameId = gameRows[0].id;
        trackedIds.gameIds.push(testGameId);

        const { rows: catRows } = await adminClient.query(
            'INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id',
            [testGameId, `CONCTEST-PoolCat-${uniqueSuffix}`]
        );
        const testCategoryId = catRows[0].id;
        trackedIds.categoryIds.push(testCategoryId);

        const sku = `CONCTEST-POOLSKU-${uniqueSuffix}`;
        const { rows: prodRows } = await adminClient.query(
            `INSERT INTO products (game_id, category_id, name, provider_sku, price, status, validation_config, use_manual_prices, manual_prices)
             VALUES ($1, $2, $3, $4, $5, 'Active', NULL, FALSE, '{}'::jsonb) RETURNING id`,
            [testGameId, testCategoryId, `CONCTEST-PoolProd-${uniqueSuffix}`, sku, PROD_BASE_PRICE]
        );
        const productId = prodRows[0].id;
        trackedIds.productIds.push(productId);
        mockProducts.push({ product_code: sku, product_price: PROD_COST });

        const createFixtureUser = async (label) => {
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
                    INITIAL_BALANCE,
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

        const webUser = await createFixtureUser('POOLWEB');
        const h2hUser = await createFixtureUser('POOLH2H');

        // Lepas adminClient sebelum uji konkurensi agar 10 slot pool murni untuk uji beban
        adminReleased = true;
        adminClient.release();

        // 3. Jalankan Express app pada port ephemeral lokal & panaskan cache produk Foxy
        appServer = startServer(0);
        const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
        invalidateFoxyProductCache();

        console.log(`[pool-test] Database target  : ${dbName}@${dbHost}`);
        console.log(`[pool-test] pool.options.max : ${pool.options.max}`);
        console.log(`[pool-test] Mock Foxy URL    : ${mockFoxyBaseUrl} (delay ${FOXY_ORDER_DELAY_MS}ms)`);
        console.log(`[pool-test] Firing ${PARALLEL_TOTAL} parallel orders (${WEB_ORDER_COUNT} Web + ${H2H_ORDER_COUNT} H2H)...`);

        // 4. Eksekusi 30 order paralel bersamaan
        const startTime = Date.now();
        const webTasks = Array.from({ length: WEB_ORDER_COUNT }, (_, idx) =>
            fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webUser.token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': crypto.randomUUID()
                },
                body: JSON.stringify({
                    productId,
                    targetGameId: `CONCTEST-W-${idx}-${uniqueSuffix}`
                })
            }).then(async (res) => ({ channel: 'web', status: res.status, body: await res.json() }))
        );

        const h2hTasks = Array.from({ length: H2H_ORDER_COUNT }, (_, idx) =>
            fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: {
                    'X-API-Key': h2hUser.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    productId,
                    targetGameId: `CONCTEST-H-${idx}-${uniqueSuffix}`,
                    ref_id: `CONCTEST-POOL-REF-${idx}-${uniqueSuffix}`
                })
            }).then(async (res) => ({ channel: 'h2h', status: res.status, body: await res.json() }))
        );

        const responses = await Promise.all([...webTasks, ...h2hTasks]);
        const elapsedMs = Date.now() - startTime;
        if (probePromise) {
            await probePromise;
        }

        const successCount = responses.filter((r) => r.status === 201).length;
        const failedResponses = responses.filter((r) => r.status !== 201);

        // 5. Verifikasi hasil DB akhir
        const verifyClient = await pool.connect();
        let txStats;
        let webFinalBalance;
        let h2hFinalBalance;
        let purchaseHistoryCount;
        try {
            const { rows: statRows } = await verifyClient.query(
                `SELECT
                    COUNT(*)::int AS total_rows,
                    COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending_rows,
                    COUNT(*) FILTER (WHERE status = 'Pending' AND provider_trx_id IS NULL)::int AS orphan_pending_rows,
                    COUNT(*) FILTER (WHERE provider_trx_id IS NOT NULL)::int AS with_provider_trx_id,
                    COUNT(DISTINCT provider_trx_id)::int AS unique_provider_trx_ids
                 FROM transactions
                 WHERE user_id = ANY($1::int[])`,
                [[webUser.userId, h2hUser.userId]]
            );
            txStats = statRows[0];

            const { rows: userBalRows } = await verifyClient.query(
                'SELECT id, balance FROM users WHERE id = ANY($1::int[])',
                [[webUser.userId, h2hUser.userId]]
            );
            const balMap = new Map(userBalRows.map((u) => [u.id, Number(u.balance)]));
            webFinalBalance = balMap.get(webUser.userId);
            h2hFinalBalance = balMap.get(h2hUser.userId);

            const { rows: histRows } = await verifyClient.query(
                "SELECT COUNT(*)::int AS cnt FROM balance_history WHERE user_id = ANY($1::int[]) AND type = 'Purchase'",
                [[webUser.userId, h2hUser.userId]]
            );
            purchaseHistoryCount = histRows[0].cnt;
        } finally {
            verifyClient.release();
        }

        const expectedWebBalance = INITIAL_BALANCE - (WEB_ORDER_COUNT * expectedUnitPrice);
        const expectedH2hBalance = INITIAL_BALANCE - (H2H_ORDER_COUNT * expectedUnitPrice);

        const ok = (
            pool.options.max === POOL_MAX &&
            successCount === PARALLEL_TOTAL &&
            failedResponses.length === 0 &&
            totalFoxyOrderCalls === PARALLEL_TOTAL &&
            peakInFlightFoxyOrders > POOL_MAX &&
            probeTriggered &&
            probeDuringFoxyOk &&
            elapsedMs < (FOXY_ORDER_DELAY_MS * 2.5) &&
            txStats.total_rows === PARALLEL_TOTAL &&
            txStats.pending_rows === PARALLEL_TOTAL &&
            txStats.orphan_pending_rows === 0 &&
            txStats.with_provider_trx_id === PARALLEL_TOTAL &&
            txStats.unique_provider_trx_ids === PARALLEL_TOTAL &&
            purchaseHistoryCount === PARALLEL_TOTAL &&
            webFinalBalance === expectedWebBalance &&
            h2hFinalBalance === expectedH2hBalance
        );

        console.log(
            `[${ok ? 'PASS' : 'FAIL'}] 30 Parallel Orders vs Pool max=${POOL_MAX} & ${FOXY_ORDER_DELAY_MS}ms Foxy delay: ` +
            `http201=${successCount}/${PARALLEL_TOTAL}, elapsed=${elapsedMs}ms, peakInFlightFoxy=${peakInFlightFoxyOrders}, ` +
            `dbProbeDuringFoxy=${probeDuringFoxyOk}(${probeLatencyMs}ms), txTotal=${txStats.total_rows}, ` +
            `orphanNullProvider=${txStats.orphan_pending_rows}, withProviderTrxId=${txStats.with_provider_trx_id}, ` +
            `uniqueProviderTrxIds=${txStats.unique_provider_trx_ids}, ` +
            `webBalance=${webFinalBalance}/${expectedWebBalance}, h2hBalance=${h2hFinalBalance}/${expectedH2hBalance}`
        );

        if (failedResponses.length > 0) {
            console.error('[FAIL] Contoh response gagal:', failedResponses.slice(0, 3));
        }

        if (!ok) {
            process.exitCode = 1;
        }
    } finally {
        if (!adminReleased) {
            adminReleased = true;
            adminClient.release();
        }

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
    console.error('[ERROR] Pool manual test gagal:', err);
    process.exit(1);
});
