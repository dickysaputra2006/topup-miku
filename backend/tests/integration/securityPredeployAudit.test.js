const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, axios, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { createTransactionalMockDb } = require('../helpers/mockDb');
const { invalidateFoxyProductCache } = require('../../services/foxyClient');

function buildAlgNoneToken(payload) {
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${h}.${b}.`;
}

/**
 * In-memory mock DB dengan per-user async row mutex untuk mensimulasikan
 * `SELECT ... FOR UPDATE` PostgreSQL secara autentik pada uji race double-spend.
 */
function createRowLockOrderMockDb(initialUsers, initialProducts) {
    const users = new Map(initialUsers.map((u) => [u.id, { ...u }]));
    const products = new Map(initialProducts.map((p) => [p.id, { ...p }]));
    const transactions = [];
    const userQueues = new Map();
    let nextTxId = 1;

    const acquireLock = async (userId) => {
        const prev = userQueues.get(userId) || Promise.resolve();
        let releaseFn;
        const gate = new Promise((res) => { releaseFn = res; });
        const tail = prev.then(() => gate);
        userQueues.set(userId, tail);
        await prev;
        return () => releaseFn();
    };

    const runQuery = async (sql, params, state) => {
        if (typeof sql !== 'string') return { rows: [] };
        if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
            for (const u of users.values()) {
                if (u.api_key_hash === params[1]) return { rows: [{ ...u }] };
            }
            return { rows: [] };
        }
        if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ id: u.id, whitelisted_ips: u.whitelisted_ips || [] }] } : { rows: [] };
        }
        if (sql.includes('SELECT token_version FROM users WHERE id = $1')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ token_version: u.token_version ?? 1 }] } : { rows: [] };
        }
        if (sql.includes('JOIN games g') && (sql.includes('p.id = $1') || sql.includes('WHERE id = $1'))) {
            const p = products.get(params[0]);
            return { rows: p ? [{ ...p }] : [] };
        }
        if (sql.includes('FROM users u JOIN roles r') && sql.includes('FOR UPDATE')) {
            state.releaseLock = state.releaseLock || await acquireLock(params[0]);
            state.stagedBalance = new Map([...users.entries()].map(([k, v]) => [k, v.balance]));
            const u = users.get(params[0]);
            return u ? { rows: [{ balance: state.stagedBalance.get(u.id), role_id: u.role_id, role_name: u.role_name }] } : { rows: [] };
        }
        if (sql.includes('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE')) {
            state.releaseLock = state.releaseLock || await acquireLock(params[0]);
            state.stagedBalance = new Map([...users.entries()].map(([k, v]) => [k, v.balance]));
            const u = users.get(params[0]);
            return u ? { rows: [{ balance: state.stagedBalance.get(u.id), role_id: u.role_id }] } : { rows: [] };
        }
        if (sql.includes('FROM users u JOIN roles r') && sql.includes('u.id = $1')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ balance: u.balance, role_id: u.role_id, role_name: u.role_name }] } : { rows: [] };
        }
        if (sql.includes('SELECT margin_percent FROM roles WHERE id = $1')) return { rows: [{ margin_percent: 10 }] };
        if (sql.includes('FROM flash_sales')) return { rows: [] };
        if (sql.includes('SELECT id, status, provider_trx_id') && sql.includes('FOR UPDATE')) {
            const found = transactions.find((t) => t.invoice_id === params[0]);
            return { rows: found ? [{ ...found }] : [] };
        }
        if (sql.includes('UPDATE users SET balance = balance - $1')) {
            const amt = Number(params[0]);
            const uid = params[1];
            const cur = state.stagedBalance.get(uid);
            if (cur === undefined || cur < amt) return { rowCount: 0 };
            state.stagedBalance.set(uid, cur - amt);
            state.pendingUserUpdates.set(uid, cur - amt);
            return { rowCount: 1 };
        }
        if (sql.includes('INSERT INTO transactions')) {
            const row = {
                id: nextTxId++, invoice_id: params[0], user_id: params[1],
                product_id: params[2], price: Number(params[4]), status: params[5],
                provider_trx_id: params[6], flash_sale_id: null, flash_sale_restored: false
            };
            state.stagedTx.push(row);
            return { rows: [{ id: row.id }] };
        }
        return { rows: [] };
    };

    const releaseClientLock = (state) => {
        if (state.releaseLock) {
            const fn = state.releaseLock;
            state.releaseLock = null;
            fn();
        }
    };

    return {
        users,
        transactions,
        poolQuery: (sql, params = []) => runQuery(sql, params, { stagedBalance: new Map(), stagedTx: [], pendingUserUpdates: new Map() }),
        poolConnect: async () => {
            const state = { stagedBalance: new Map(), stagedTx: [], pendingUserUpdates: new Map(), releaseLock: null };
            return {
                query: async (sql, params = []) => {
                    if (sql === 'BEGIN') {
                        state.stagedTx = [];
                        state.pendingUserUpdates = new Map();
                        return {};
                    }
                    if (sql === 'COMMIT') {
                        for (const [uid, nextBal] of state.pendingUserUpdates.entries()) {
                            const u = users.get(uid);
                            if (u) u.balance = nextBal;
                        }
                        transactions.push(...state.stagedTx);
                        releaseClientLock(state);
                        return {};
                    }
                    if (sql === 'ROLLBACK') {
                        state.stagedTx = [];
                        state.pendingUserUpdates.clear();
                        releaseClientLock(state);
                        return {};
                    }
                    return runQuery(sql, params, state);
                },
                release: () => releaseClientLock(state)
            };
        }
    };
}

describe('Pre-Deploy Security Audit — Area 1 (Anti-Leak & Admin RBAC) & Area 2 (Anti-Sedot Saldo)', () => {
    const harness = createServerHarness({ withAxios: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    // === AREA 1 ===
    test('Area 1.1: endpoint publik tidak bocorkan PII, harga modal/base_price, margin_percent, atau tier Admin', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('transactions t') && sql.includes('t.invoice_id = $1')) {
                return {
                    rows: [{
                        invoice_id: 'TRX-PUB-1001', status: 'Success', price: 22000,
                        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                        product_name: '86 Diamonds', game_name: 'Mobile Legends'
                    }]
                };
            }
            if (sql.includes('transactions t') && sql.includes('ORDER BY t.created_at DESC')) {
                return {
                    rows: [{
                        invoice_id: 'TRX-998877665544', status: 'Success',
                        created_at: new Date().toISOString(), product_name: '86 Diamonds', game_name: 'Mobile Legends'
                    }]
                };
            }
            if (sql.includes("status = 'Success'") && sql.includes('GROUP BY')) {
                return { rows: [{ username: 'buyer_rahasia01', total_success_orders: 9, total_spent: '950000', last_order_at: null }] };
            }
            if (sql.includes('FROM products p') && sql.includes('JOIN games g')) {
                return {
                    rows: [{
                        id: 1, game_id: 1, name: '86 Diamonds', provider_sku: 'SKU-86', price: 20000,
                        game_name: 'Mobile Legends', use_manual_prices: false, manual_prices: null, use_custom_margin: false
                    }]
                };
            }
            if (sql.includes('SELECT name, margin_percent FROM roles')) {
                return {
                    rows: [
                        { name: 'BRONZE', margin_percent: 12 },
                        { name: 'PARTNER', margin_percent: 4 },
                        { name: 'Admin', margin_percent: 0 }
                    ]
                };
            }
            if (sql.includes("SELECT id, name FROM games WHERE status = 'Active'")) {
                return { rows: [{ id: 1, name: 'Mobile Legends' }] };
            }
            return { rows: [] };
        });

        try {
            const [txRes, recentRes, lbRes, cmpRes] = await Promise.all([
                fetch(`${baseUrl}/api/public/transaction/TRX-PUB-1001`),
                fetch(`${baseUrl}/api/public/recent-transactions`),
                fetch(`${baseUrl}/api/public/leaderboard`),
                fetch(`${baseUrl}/api/public/compare-prices`)
            ]);
            assert.strictEqual(txRes.status, 200);
            assert.strictEqual(recentRes.status, 200);
            assert.strictEqual(lbRes.status, 200);
            assert.strictEqual(cmpRes.status, 200);

            const [txData, recentData, lbData, cmpData] = await Promise.all([
                txRes.json(), recentRes.json(), lbRes.json(), cmpRes.json()
            ]);

            const combinedStr = JSON.stringify({ txData, recentData, lbData, cmpData });
            assert.doesNotMatch(combinedStr, /email|nomor_wa|balance|password|buy_price|cost_price|base_price|margin_percent|price_admin/i);
            assert.strictEqual(recentData[0].invoice_id, undefined);
            assert.ok(String(recentData[0].invoice_masked).includes('****'));
            assert.ok(!JSON.stringify(lbData).includes('buyer_rahasia01'));
            assert.strictEqual(cmpData.roles.some((r) => r.name.toLowerCase() === 'admin'), false, 'Tier Admin tidak boleh muncul di compare-prices');
            assert.strictEqual('margin_percent' in cmpData.roles[0], false, 'margin_percent wajib disanitasi dari publik');
            assert.strictEqual('price_admin' in cmpData.products[0], false, 'price_admin (harga modal) wajib tidak ada');
        } finally {
            pool.query.mock.restore();
        }
    });

    test('Area 1.2: anti-IDOR lintas user (invoice, transaksi, balance-history, deposits, H2H order)', async () => {
        const userAToken = fixtures.makeUserToken(10, 'BRONZE', 'user_a');
        const userAH2HKey = 'a'.repeat(64);
        const userAH2HHash = crypto.createHash('sha256').update(userAH2HKey).digest('hex');
        const userBOnlyRows = {
            transactions: [{ invoice_id: 'TRX-USERB-999', user_id: 20 }],
            h2h: [{ invoice_id: 'H2H-USERB-999', ref_id: 'REF-B-999', user_id: 20 }]
        };
        const boundUserIds = [];

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('SELECT token_version FROM users WHERE id = $1')) return { rows: [{ token_version: 1 }] };
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return params[1] === userAH2HHash
                    ? { rows: [{ id: 10, username: 'user_a', balance: 50000, role_id: 2, role_name: 'PARTNER', api_key_hash: userAH2HHash }] }
                    : { rows: [] };
            }
            if (sql.includes('WHERE t.invoice_id = $1 AND t.user_id = $2')) {
                boundUserIds.push(params[1]);
                return { rows: userBOnlyRows.transactions.filter((t) => t.invoice_id === params[0] && t.user_id === params[1]) };
            }
            if (sql.includes('FROM transactions t') && sql.includes('t.user_id = $1') && sql.includes('t.ref_id = $2')) {
                boundUserIds.push(params[0]);
                return { rows: userBOnlyRows.h2h.filter((t) => t.user_id === params[0] && (t.invoice_id === params[1] || t.ref_id === params[1])) };
            }
            if (sql.includes('FROM transactions t') && sql.includes('WHERE t.user_id = $1')) {
                boundUserIds.push(params[0]);
                return { rows: [] };
            }
            if (sql.includes('FROM balance_history WHERE user_id = $1') || sql.includes('FROM deposits')) {
                boundUserIds.push(params[0]);
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            const authH = { 'Authorization': `Bearer ${userAToken}` };
            const [invRes, txListRes, bhRes, depRes, h2hRes] = await Promise.all([
                fetch(`${baseUrl}/api/user/transaction/TRX-USERB-999`, { headers: authH }),
                fetch(`${baseUrl}/api/user/transactions`, { headers: authH }),
                fetch(`${baseUrl}/api/user/balance-history`, { headers: authH }),
                fetch(`${baseUrl}/api/user/deposits`, { headers: authH }),
                fetch(`${baseUrl}/h2h/order/H2H-USERB-999`, { headers: { 'X-API-Key': userAH2HKey } })
            ]);
            assert.strictEqual(invRes.status, 404);
            assert.strictEqual(txListRes.status, 200);
            assert.deepStrictEqual(await txListRes.json(), []);
            assert.strictEqual(bhRes.status, 200);
            assert.deepStrictEqual(await bhRes.json(), []);
            assert.strictEqual(depRes.status, 200);
            assert.deepStrictEqual(await depRes.json(), []);
            assert.strictEqual(h2hRes.status, 404);
            assert.ok(boundUserIds.length >= 5 && boundUserIds.every((id) => id === 10), 'Semua query wajib terikat user_id pemilik token/key (10)');
        } finally {
            pool.query.mock.restore();
        }
    });

    test('Area 1.3: profile/login tanpa field rahasia & blokir mass-assignment register/profile', async () => {
        const token = fixtures.makeUserToken(10, 'BRONZE', 'user_ma');
        const passHash = await bcrypt.hash('StrongPass123!', 4);
        let registerSql = '';
        let registerParams = [];
        let updateProfileSql = '';
        let updateProfileParams = [];

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('SELECT token_version FROM users WHERE id = $1')) return { rows: [{ token_version: 1 }] };
            if (sql.includes('SELECT u.id, u.full_name, u.username, u.email, u.nomor_wa, u.balance, r.name as role FROM users')) {
                return {
                    rows: [{
                        id: 10, full_name: 'User Normal', username: 'user_ma',
                        email: 'ma@example.com', nomor_wa: '+628123456789', balance: 50000, role: 'BRONZE'
                    }]
                };
            }
            if (sql.includes('SELECT username, email, nomor_wa FROM users WHERE')) return { rows: [] };
            if (sql.includes("SELECT id FROM roles WHERE name = 'BRONZE'")) return { rows: [{ id: 1 }] };
            if (sql.includes('INSERT INTO users')) {
                registerSql = sql;
                registerParams = params;
                return { rows: [] };
            }
            if (sql.includes('SELECT u.*, r.name as role_name FROM users u')) {
                return {
                    rows: [{
                        id: 10, username: 'user_ma', password: passHash, password_hash: 'secret_hash',
                        api_key_hash: 'secret_api_hash', h2h_webhook_secret: 'secret_wh',
                        token_version: 1, reset_token: 'secret_rst', role_name: 'BRONZE'
                    }]
                };
            }
            if (sql.includes('UPDATE users SET full_name = $1, email = $2, nomor_wa = $3 WHERE id = $4')) {
                updateProfileSql = sql;
                updateProfileParams = params;
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        try {
            const profRes = await fetch(`${baseUrl}/api/user/profile`, { headers: { 'Authorization': `Bearer ${token}` } });
            assert.strictEqual(profRes.status, 200);
            const profStr = JSON.stringify(await profRes.json());
            assert.doesNotMatch(profStr, /password|api_key_hash|h2h_webhook_secret|token_version|reset_token/i);

            const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'user_ma', password: 'StrongPass123!' })
            });
            assert.strictEqual(loginRes.status, 200);
            const loginData = await loginRes.json();
            assert.deepStrictEqual(Object.keys(loginData).sort(), ['message', 'token']);

            const regRes = await fetch(`${baseUrl}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fullName: 'Attacker', username: 'attacker01', email: 'att@example.com',
                    countryCode: '+62', nomorWa: '81299887766', password: 'Password123!',
                    role: 'Admin', role_id: 99, balance: 99999999, is_verified: true
                })
            });
            assert.strictEqual(regRes.status, 201);
            assert.ok(!registerSql.includes('balance') && !registerSql.includes('is_verified'));
            assert.strictEqual(registerParams[5], 1, 'Register wajib pakai role BRONZE id=1');

            const updRes = await fetch(`${baseUrl}/api/user/profile`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fullName: 'Updated Name', email: 'upd@example.com', nomorWa: '081234567890',
                    role: 'Admin', role_id: 99, balance: 99999999, is_verified: true
                })
            });
            assert.strictEqual(updRes.status, 200);
            assert.strictEqual(updateProfileParams.length, 4);
            assert.ok(!updateProfileSql.includes('balance') && !updateProfileSql.includes('role_id'));
        } finally {
            pool.query.mock.restore();
        }
    });

    test('Area 1.4: /api/admin/payment-methods fail-closed terhadap unauthorized token & tolak stored XSS', async () => {
        const userToken = fixtures.makeUserToken(10, 'PARTNER', 'reseller_1');
        const adminToken = fixtures.makeAdminToken(1, 'admin_1');
        const expiredAdminToken = jwt.sign({ id: 1, role: 'Admin', tokenVersion: 1 }, fixtures.TEST_JWT_SECRET, { expiresIn: '-10s' });
        const algNoneAdminToken = buildAlgNoneToken({ id: 1, role: 'Admin', tokenVersion: 1 });
        const staleAdminToken = jwt.sign({ id: 1, role: 'Admin', tokenVersion: 1 }, fixtures.TEST_JWT_SECRET, { expiresIn: '1h' });
        let writeCount = 0;

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('SELECT token_version FROM users WHERE id = $1')) {
                return { rows: [{ token_version: params[0] === 1 ? 2 : 1 }] }; // Admin token_version=2
            }
            if (sql.includes('SELECT r.name as role_name FROM users')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('INSERT INTO payment_methods') || sql.includes('UPDATE payment_methods') || sql.includes('DELETE FROM payment_methods')) {
                writeCount += 1;
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            const validAdminHeader = { 'Authorization': `Bearer ${jwt.sign({ id: 1, role: 'Admin', tokenVersion: 2 }, fixtures.TEST_JWT_SECRET, { expiresIn: '1h' })}` };
            const checks = [
                await fetch(`${baseUrl}/api/admin/payment-methods`),
                await fetch(`${baseUrl}/api/admin/payment-methods`, { method: 'POST', headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) }),
                await fetch(`${baseUrl}/api/admin/payment-methods`, { headers: { 'Authorization': `Bearer ${expiredAdminToken}` } }),
                await fetch(`${baseUrl}/api/admin/payment-methods`, { headers: { 'Authorization': `Bearer ${algNoneAdminToken}` } }),
                await fetch(`${baseUrl}/api/admin/payment-methods`, { headers: { 'Authorization': `Bearer ${staleAdminToken}` } }),
                await fetch(`${baseUrl}/api/admin/payment-methods/1`, { method: 'PUT', headers: { 'X-API-Key': 'a'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify({}) }),
                await fetch(`${baseUrl}/api/admin/payment-methods/1`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${userToken}` } })
            ];
            assert.deepStrictEqual(checks.map((r) => r.status), [401, 403, 401, 401, 401, 401, 403]);

            const xssPayloads = [
                { name: '<script>alert(1)</script>', code: 'BCA_XSS', type: 'bank', account_number: '123456', account_name: 'MIKU' },
                { name: 'Bank Aman', code: 'BCA_XSS2', type: 'bank', account_number: '123<script>', account_name: 'MIKU' },
                { name: 'Bank Aman 2', code: 'BCA_XSS3', type: 'bank', account_number: '12345678', account_name: '<img src=x onerror=alert(1)>' }
            ];
            for (const payload of xssPayloads) {
                const res = await fetch(`${baseUrl}/api/admin/payment-methods`, {
                    method: 'POST',
                    headers: { ...validAdminHeader, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                assert.strictEqual(res.status, 400, `Payload XSS wajib ditolak 400: ${JSON.stringify(payload)}`);
            }
            assert.strictEqual(writeCount, 0, 'Tidak boleh ada query tulis ke payment_methods saat ditolak');
            assert.ok(adminToken); // ensure adminToken helper stays used
        } finally {
            pool.query.mock.restore();
        }
    });

    // === AREA 2 ===
    test('Area 2.1: concurrent double-spend Web & H2H terkunci FOR UPDATE — saldo tidak pernah minus', async () => {
        const h2hKey = 'f'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createRowLockOrderMockDb(
            [
                { id: 7201, username: 'web_race', role_id: 1, role_name: 'BRONZE', balance: 15000, token_version: 1 },
                { id: 7202, username: 'h2h_race', role_id: 2, role_name: 'PARTNER', balance: 15000, api_key_hash: h2hKeyHash }
            ],
            [{
                id: 501, name: 'Diamond Race 100', provider_sku: 'SKU-RACE', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, use_manual_prices: false, use_custom_margin: false, validation_config: null
            }]
        );
        let foxyOrderPosts = 0;
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        axios.get = async () => {
            await new Promise((r) => setTimeout(r, 15));
            return { data: { data: [{ product_code: 'SKU-RACE', product_price: 10000 }] } };
        };
        axios.post = async () => {
            foxyOrderPosts += 1;
            return { data: { status: true } };
        };

        try {
            invalidateFoxyProductCache();
            const webToken = fixtures.makeUserToken(7201, 'BRONZE', 'web_race');
            const webHdr = (uuid) => ({ 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': uuid });
            const [w1, w2] = await Promise.all([
                fetch(`${baseUrl}/api/order`, { method: 'POST', headers: webHdr('22222222-2222-4222-8222-222222222001'), body: JSON.stringify({ productId: 501, targetGameId: '112233' }) }),
                fetch(`${baseUrl}/api/order`, { method: 'POST', headers: webHdr('22222222-2222-4222-8222-222222222002'), body: JSON.stringify({ productId: 501, targetGameId: '112234' }) })
            ]);
            assert.deepStrictEqual([w1.status, w2.status].sort((a, b) => a - b), [201, 400]);
            assert.strictEqual(db.users.get(7201).balance, 4000);

            invalidateFoxyProductCache();
            const [h1, h2] = await Promise.all([
                fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 501, targetGameId: '445566', ref_id: 'RACE-H2H-1' }) }),
                fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 501, targetGameId: '445567', ref_id: 'RACE-H2H-2' }) })
            ]);
            assert.deepStrictEqual([h1.status, h2.status].sort((a, b) => a - b), [201, 400]);
            assert.strictEqual(db.users.get(7202).balance, 4000);
            assert.strictEqual(foxyOrderPosts, 2, 'Hanya maksimal 1 /v1/order per channel yang lolos');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('Area 2.2 & 2.3: tolak input tampering, abaikan price/user_id klien, & blokir deposit self-approve', async () => {
        const key = 'b'.repeat(64);
        const keyHash = crypto.createHash('sha256').update(key).digest('hex');
        const db = createTransactionalMockDb(
            [{ id: 7301, username: 'tamper_u', role_id: 1, role_name: 'BRONZE', balance: 50000, api_key_hash: keyHash }],
            [{ id: 601, name: 'Diamond 100', provider_sku: 'SKU-TAMP', price: 10000, status: 'Active', game_id: 1, needs_server_id: false, use_manual_prices: false, use_custom_margin: false, validation_config: null }]
        );
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        axios.get = async () => ({ data: { data: [{ product_code: 'SKU-TAMP', product_price: 10000 }] } });
        axios.post = async () => ({ data: { status: true } });

        try {
            const token = fixtures.makeUserToken(7301, 'BRONZE', 'tamper_u');
            const authH = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
            for (const badProd of [-1, 0, 'NaN', 'Infinity', true, [601]]) {
                const rWeb = await fetch(`${baseUrl}/api/order`, { method: 'POST', headers: authH, body: JSON.stringify({ productId: badProd, targetGameId: '12345' }) });
                const rH2h = await fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: badProd, targetGameId: '12345' }) });
                assert.strictEqual(rWeb.status, 400);
                assert.strictEqual(rH2h.status, 400);
            }
            for (const badAmt of [-10000, 0, 'NaN', 'Infinity', true, [50000], 50000.99]) {
                const rDep = await fetch(`${baseUrl}/api/deposit/request`, { method: 'POST', headers: authH, body: JSON.stringify({ amount: badAmt, method: 'BCA' }) });
                assert.strictEqual(rDep.status, 400);
            }

            // Client tries injecting price=1, user_id=999
            const ordRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST', headers: authH,
                body: JSON.stringify({ productId: 601, targetGameId: '778899', price: 1, total_price: 0, user_id: 999 })
            });
            assert.strictEqual(ordRes.status, 201);
            assert.strictEqual(db.users.get(7301).balance, 39000, 'Saldo terpotong sesuai harga DB (11000), bukan 1');
            assert.strictEqual(db.transactions[0].user_id, 7301);

            // Deposit self-approve attempt
            const depRes = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST', headers: authH,
                body: JSON.stringify({ amount: 50000, method: 'BCA', status: 'Approved', user_id: 999 })
            });
            assert.strictEqual(depRes.status, 201);
            const depBody = await depRes.json();
            assert.strictEqual(depBody.deposit.status, 'Pending');
            assert.strictEqual(db.deposits[0].user_id, 7301);
            assert.strictEqual(db.deposits[0].status, 'Pending');
            assert.strictEqual(db.users.get(7301).balance, 39000, 'Request deposit tidak boleh menambah saldo');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('Area 2.4: rotasi H2H API key cabut key lama, IP whitelist tolak IP asing, & ref_id idempoten', async () => {
        const origNodeEnv = process.env.NODE_ENV;
        const db = createTransactionalMockDb(
            [{ id: 7401, username: 'h2h_rot', role_id: 2, role_name: 'PARTNER', balance: 50000, api_key: null, api_key_hash: null, whitelisted_ips: ['203.0.113.0/24'] }],
            [{ id: 701, name: 'Diamond 140', provider_sku: 'SKU-ROT', price: 10000, status: 'Active', game_id: 1, needs_server_id: false, use_manual_prices: false, use_custom_margin: false, validation_config: null }]
        );

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql === 'string' && sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                for (const u of db.users.values()) {
                    if (u.api_key_hash === params[1]) {
                        return { rows: [{ id: u.id, whitelisted_ips: u.whitelisted_ips || [], api_key: null, api_key_hash: u.api_key_hash }] };
                    }
                }
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE users') && sql.includes('api_key_hash = $1')) {
                const u = db.users.get(params[3]);
                u.api_key = null;
                u.api_key_hash = params[0];
                u.api_key_prefix = params[1];
                u.h2h_webhook_secret = u.h2h_webhook_secret || params[2];
                return { rows: [{ api_key_prefix: params[1], webhook_secret_created: true }] };
            }
            return db.poolQuery(sql, params);
        });
        mock.method(pool, 'connect', db.poolConnect);
        axios.get = async () => ({ data: { data: [{ product_code: 'SKU-ROT', product_price: 10000 }] } });
        axios.post = async () => ({ data: { status: true } });

        try {
            const token = fixtures.makeUserToken(7401, 'PARTNER', 'h2h_rot');
            const gen1 = await (await fetch(`${baseUrl}/api/user/generate-apikey`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } })).json();
            const rot = await (await fetch(`${baseUrl}/api/user/apikey/regenerate`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } })).json();
            assert.notStrictEqual(rot.apiKey, gen1.apiKey);

            process.env.NODE_ENV = 'production';
            assert.strictEqual((await fetch(`${baseUrl}/h2h/profile`, { headers: { 'X-Forwarded-For': '203.0.113.10' } })).status, 401);
            assert.strictEqual((await fetch(`${baseUrl}/h2h/profile`, { headers: { 'X-API-Key': gen1.apiKey, 'X-Forwarded-For': '203.0.113.10' } })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/h2h/profile`, { headers: { 'X-API-Key': rot.apiKey, 'X-Forwarded-For': '198.51.100.55' } })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/h2h/profile`, { headers: { 'X-API-Key': rot.apiKey, 'X-Forwarded-For': '203.0.113.10' } })).status, 200);

            const ord1 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': rot.apiKey, 'X-Forwarded-For': '203.0.113.10', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 701, targetGameId: '990011', ref_id: 'IDEM-REF-01' })
            });
            assert.strictEqual(ord1.status, 201);
            const ordReplay = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': rot.apiKey, 'X-Forwarded-For': '203.0.113.10', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 701, targetGameId: '990011', ref_id: 'IDEM-REF-01' })
            });
            assert.strictEqual(ordReplay.status, 200);
            assert.strictEqual((await ordReplay.json()).idempotent, true);
            assert.strictEqual(db.users.get(7401).balance, 39000, 'Saldo hanya dipotong 1x pada replay ref_id');

            const ordConflict = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': rot.apiKey, 'X-Forwarded-For': '203.0.113.10', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 701, targetGameId: '999999', ref_id: 'IDEM-REF-01' })
            });
            assert.strictEqual(ordConflict.status, 409);
        } finally {
            process.env.NODE_ENV = origNodeEnv;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });
});
