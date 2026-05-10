const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');

// Use an ephemeral test port before requiring server.
process.env.PORT = '0';
process.env.JWT_SECRET = 'test-secret';
process.env.FOXY_API_KEY = 'test-foxy-key';

const { pool, startServer } = require('../server.js');

let h2hOrderUrl;

describe('Security: Error Exposure Tests', () => {
    let originalQuery;
    let originalConnect;
    let server;

    before(() => {
        server = startServer(0);
        h2hOrderUrl = `http://127.0.0.1:${server.address().port}/h2h/order`;
        originalQuery = pool.query;
        originalConnect = pool.connect;
    });

    after(async () => {
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await new Promise(resolve => server.close(resolve));
    });

    test('should not expose sensitive error message in H2H order endpoint', async () => {
        // Mock API Key validation (protectH2H middleware)
        // First call is in protectH2H
        // We need to mock pool.query to return a valid user for the API key
        const validApiKey = 'a'.repeat(48);
        const mockUser = {
            id: 1,
            username: 'h2huser',
            role_id: 1,
            role_name: 'PARTNER',
            api_key: validApiKey
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('u.api_key = $1')) {
                return { rows: [mockUser] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            // Trigger error in the main transaction block
            throw new Error('Sensitive database error details that should not be leaked');
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                throw new Error('Sensitive database error details that should not be leaked');
            },
            release: () => {}
        }));

        const res = await fetch(h2hOrderUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': validApiKey
            },
            body: JSON.stringify({
                productId: 1,
                targetGameId: '123456'
            })
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();

        // Assert that the sensitive message is NOT in the response
        assert.strictEqual(data.success, false);
        assert.strictEqual(data.message, 'Gagal memproses transaksi H2H.');
        assert.ok(!JSON.stringify(data).includes('Sensitive database error details'), 'Response should not contain sensitive error details');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    test('should not expose sensitive error message in standard order endpoint', async () => {
        const orderUrl = `http://127.0.0.1:${server.address().port}/api/order`;

        // Mock jwt.verify indirectly by setting up req.user if possible,
        // but since we use real fetch, we need a real token or mock protect middleware.
        // Easiest is to mock pool.query to fail during the order process after protect passes.

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                throw new Error('Another sensitive error');
            },
            release: () => {}
        }));

        // We need a token. Let's sign one.
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: 1, username: 'testuser', role: 'BRONZE' }, process.env.JWT_SECRET);

        const res = await fetch(orderUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                productId: 1,
                targetGameId: '123456'
            })
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();

        assert.strictEqual(data.message, 'Gagal memproses transaksi.');
        assert.ok(!JSON.stringify(data).includes('Another sensitive error'), 'Response should not contain sensitive error details');

        pool.connect.mock.restore();
    });

    test('should reject admin access if user role is changed in DB', async () => {
        const adminUrl = `http://127.0.0.1:${server.address().port}/api/admin/roles`;
        
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'User' }] };
            }
            return { rows: [] };
        });

        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: 1, username: 'adminuser', role: 'Admin' }, process.env.JWT_SECRET);

        const res = await fetch(adminUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        assert.strictEqual(res.status, 403);
        const data = await res.json();
        assert.strictEqual(data.message, 'Akses ditolak: Hanya untuk Admin.');

        pool.query.mock.restore();
    });

    test('should reject invalid H2H API key', async () => {
        const res = await fetch(h2hOrderUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'invalid-key-format'
            },
            body: JSON.stringify({ productId: 1, targetGameId: '123' })
        });

        assert.strictEqual(res.status, 403);
    });

    test('should reject invalid callback status', async () => {
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback`;
        
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trx_id: '123', status: 'HACKED' })
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.strictEqual(data.message, 'Status tidak valid.');
        
        pool.connect.mock.restore();
    });

    test('should apply rate limiter to register endpoint', async () => {
        const regUrl = `http://127.0.0.1:${server.address().port}/api/auth/register`;
        const reqs = Array.from({ length: 6 }).map(() => fetch(regUrl, { method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'} }));
        const responses = await Promise.all(reqs);
        
        const has429 = responses.some(r => r.status === 429);
        assert.ok(has429, 'Rate limiter should kick in and return 429');
    });

    test('should save provider_sn on successful callback', async () => {
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback`;
        
        let updateQueryExecuted = false;
        
        mock.method(pool, 'query', async () => ({ rows: [] }));
        
        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('SELECT * FROM transactions')) {
                    return { rows: [{ id: 1, invoice_id: 'TRX-123', user_id: 1, status: 'Pending', price: 1000 }] };
                }
                if (sql.includes("UPDATE transactions SET status = 'Success', provider_sn = $1")) {
                    if (params && params[0] === 'VOUCHER123') {
                        updateQueryExecuted = true;
                    }
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trx_id: '123', status: 'SUCCESS', sn: 'VOUCHER123' })
        });

        assert.strictEqual(res.status, 200);
        assert.ok(updateQueryExecuted, 'UPDATE query with provider_sn should be executed');
        
        pool.connect.mock.restore();
        pool.query.mock.restore();
    });

    test('should accept PARTIAL_REFUND callback with HTTP 200', async () => {
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback`;

        let partialRefundUpdateExecuted = false;
        let balanceModified = false;

        mock.method(pool, 'query', async () => ({ rows: [] }));

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('SELECT * FROM transactions')) {
                    return { rows: [{ id: 1, invoice_id: 'TRX-PR1', user_id: 1, status: 'Pending', price: 5000 }] };
                }
                if (sql.includes("status = 'Partial Refund'")) {
                    partialRefundUpdateExecuted = true;
                }
                if (sql.includes('UPDATE users SET balance')) {
                    balanceModified = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trx_id: 'PR-TRX-001', status: 'PARTIAL_REFUND' })
        });

        assert.strictEqual(res.status, 200, 'PARTIAL_REFUND callback should return 200');
        assert.ok(partialRefundUpdateExecuted, "DB should be updated to 'Partial Refund'");
        assert.strictEqual(balanceModified, false, 'Balance should NOT be modified on PARTIAL_REFUND');

        pool.connect.mock.restore();
        pool.query.mock.restore();
    });

    test('should reject admin resolve on final status (Success)', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: 1, username: 'adminuser', role: 'Admin' }, process.env.JWT_SECRET);
        const resolveUrl = `http://127.0.0.1:${server.address().port}/api/admin/transactions/TRX-DONE/resolve`;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 99, invoice_id: 'TRX-DONE', user_id: 1, status: 'Success', price: 5000 }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(resolveUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ action: 'refund' })
        });

        assert.strictEqual(res.status, 400, 'Should reject resolve on already-final transaction');
        const data = await res.json();
        assert.ok(data.message.includes('Success') || data.message.includes('Tidak bisa'),
            'Error message should mention final status');

        pool.connect.mock.restore();
        pool.query.mock.restore();
    });

    test('should block double refund with 409', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: 1, username: 'adminuser', role: 'Admin' }, process.env.JWT_SECRET);
        const resolveUrl = `http://127.0.0.1:${server.address().port}/api/admin/transactions/TRX-PR2/resolve`;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 10, invoice_id: 'TRX-PR2', user_id: 2, status: 'Partial Refund', price: 8000 }] };
                }
                if (sql.includes("type = 'Refund'") && sql.includes('reference_id')) {
                    // Simulasikan sudah ada refund sebelumnya
                    return { rows: [{ id: 1 }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(resolveUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ action: 'refund' })
        });

        assert.strictEqual(res.status, 409, 'Double refund should return 409 Conflict');
        const data = await res.json();
        assert.ok(data.message.includes('sudah pernah direfund'), 'Should explain double refund blocked');

        pool.connect.mock.restore();
        pool.query.mock.restore();
    });

    test('should reject success/refund action from Pending status (must be Partial Refund first)', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign({ id: 1, username: 'adminuser', role: 'Admin' }, process.env.JWT_SECRET);
        const resolveUrl = `http://127.0.0.1:${server.address().port}/api/admin/transactions/TRX-PEND/resolve`;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('FOR UPDATE')) {
                    // Transaksi masih Pending
                    return { rows: [{ id: 55, invoice_id: 'TRX-PEND', user_id: 3, status: 'Pending', price: 10000 }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(resolveUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ action: 'success' })
        });

        assert.strictEqual(res.status, 400, 'Should reject success action on Pending transaction');
        const data = await res.json();
        assert.ok(data.message.includes('Partial Refund'), 'Error message should require Partial Refund status first');

        pool.connect.mock.restore();
        pool.query.mock.restore();
    });
});

// =============================================================
// Public Transaction Endpoint Tests
// =============================================================
describe('Public Transaction Endpoints', () => {
    let server;

    before(() => {
        server = startServer(0);
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    const baseUrl = () => `http://127.0.0.1:${server.address().port}`;

    test('GET /api/public/transaction/:id — found, returns safe fields only', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-1234567890',
                        status:       'Success',
                        price:        15000,
                        created_at:   new Date().toISOString(),
                        updated_at:   new Date().toISOString(),
                        product_name: 'Diamond 100',
                        game_name:    'Mobile Legends'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/transaction/TRX-1234567890`);
        assert.strictEqual(res.status, 200, 'Should return 200 for found invoice');
        const data = await res.json();

        // Field aman harus ada
        assert.ok(data.invoice_id,   'invoice_id should be present');
        assert.ok(data.status,       'status should be present');
        assert.ok(data.status_label, 'status_label should be present');
        assert.ok(data.game_name,    'game_name should be present');
        assert.ok(data.product_name, 'product_name should be present');
        assert.ok(data.price !== undefined, 'price should be present');
        assert.ok(data.created_at,   'created_at should be present');

        // Field sensitif tidak boleh ada
        const raw = JSON.stringify(data);
        assert.ok(!('user_id'        in data), 'user_id must not be exposed');
        assert.ok(!('username'       in data), 'username must not be exposed');
        assert.ok(!('email'          in data), 'email must not be exposed');
        assert.ok(!('nomor_wa'       in data), 'nomor_wa must not be exposed');
        assert.ok(!('provider_trx_id' in data), 'provider_trx_id must not be exposed');
        assert.ok(!('provider_sn'    in data), 'provider_sn must not be exposed');
        assert.ok(!('target_game_id' in data), 'target_game_id must not be exposed');

        // Status label harus benar
        assert.strictEqual(data.status_label, 'Berhasil', 'Success status_label should be Berhasil');

        pool.query.mock.restore();
    });

    test('GET /api/public/transaction/:id — not found returns 404', async () => {
        mock.method(pool, 'query', async () => ({ rows: [] }));

        const res = await fetch(`${baseUrl()}/api/public/transaction/TRX-NOTEXIST`);
        assert.strictEqual(res.status, 404, 'Should return 404 for missing invoice');
        const data = await res.json();
        assert.ok(data.message, 'Should have a message');

        pool.query.mock.restore();
    });

    test('GET /api/public/transaction/:id — invalid chars returns 400', async () => {
        // Karakter tidak aman: titik, slash, spasi
        const res = await fetch(`${baseUrl()}/api/public/transaction/../../etc`);
        // Tergantung express routing — bisa 400 atau 404 karena path traversal
        assert.ok(res.status === 400 || res.status === 404, 'Should reject invalid/unsafe invoice');
    });

    test('GET /api/public/transaction/:id — Partial Refund status_label correct', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-PR-TEST',
                        status:       'Partial Refund',
                        price:        20000,
                        created_at:   new Date().toISOString(),
                        updated_at:   new Date().toISOString(),
                        product_name: 'Diamonds 200',
                        game_name:    'PUBG Mobile'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/transaction/TRX-PR-TEST`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status_label, 'Perlu Review Admin', 'Partial Refund label must be "Perlu Review Admin"');

        pool.query.mock.restore();
    });

    test('GET /api/public/recent-transactions — invoice is masked', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-17781619937353',
                        status:       'Success',
                        created_at:   new Date().toISOString(),
                        product_name: 'Diamond 86',
                        game_name:    'Mobile Legends'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/recent-transactions`);
        assert.strictEqual(res.status, 200);
        const list = await res.json();
        assert.ok(Array.isArray(list), 'Should return array');
        assert.ok(list.length > 0, 'Should have at least one item');

        const item = list[0];
        // Harus ada invoice_masked, bukan invoice_id asli
        assert.ok('invoice_masked' in item,  'invoice_masked should be present');
        assert.ok(!('invoice_id'   in item), 'invoice_id (full) must NOT be present');
        // Masking: tidak boleh expose invoice lengkap
        assert.ok(item.invoice_masked.includes('****'), 'Invoice must be masked with ****');
        assert.ok(!item.invoice_masked.includes('17781619937353'), 'Full invoice number must not appear');

        pool.query.mock.restore();
    });

    test('GET /api/public/recent-transactions — no sensitive fields', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-SAFE-001',
                        status:       'Pending',
                        created_at:   new Date().toISOString(),
                        product_name: 'UC 325',
                        game_name:    'PUBG Mobile'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/recent-transactions`);
        const list = await res.json();
        assert.ok(Array.isArray(list) && list.length > 0);

        const item = list[0];
        const raw = JSON.stringify(item);
        // Field sensitif harus tidak ada
        assert.ok(!('user_id'         in item), 'user_id must not be in recent list');
        assert.ok(!('username'        in item), 'username must not be in recent list');
        assert.ok(!('email'           in item), 'email must not be in recent list');
        assert.ok(!('nomor_wa'        in item), 'nomor_wa must not be in recent list');
        assert.ok(!('provider_trx_id' in item), 'provider_trx_id must not be in recent list');
        assert.ok(!('provider_sn'     in item), 'provider_sn must not be in recent list');
        assert.ok(!('target_game_id'  in item), 'target_game_id must not be in recent list');
        assert.ok(!('invoice_id'      in item), 'full invoice_id must not be in recent list');

        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 4A — Deposit Endpoint Tests
// ============================================================
describe('Phase 4A: Deposit Endpoints', () => {
    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    // Generate valid user token for tests
    function makeToken(userId = 99) {
        return jwt.sign({ id: userId, role_name: 'User' }, JWT_SECRET, { expiresIn: '1h' });
    }

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { pool.query.mock.restore(); } catch (_) {}
        try { pool.connect.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    test('POST /api/deposit/request — rejects unauthenticated request', async () => {
        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000 })
        });
        assert.strictEqual(res.status, 401);
    });

    test('POST /api/deposit/request — rejects amount below minimum (< 10000)', async () => {
        // protect middleware hanya verify JWT — tidak query DB
        // amount validation terjadi sebelum query DB
        const token = makeToken(99);
        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 5000 })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.message.includes('tidak valid'));
    });

    test('POST /api/deposit/request — rejects amount above maximum (> 100000000)', async () => {
        const token = makeToken(99);
        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 999999999 })
        });
        assert.strictEqual(res.status, 400);
    });

    test('POST /api/deposit/request — valid request creates Pending deposit, no balance change', async () => {
        const token = makeToken(99);
        const insertedRows = [];
        const updatedBalance = [];

        // Mock protect middleware (pool.query for user lookup)
        const originalQuery = pool.query;
        const originalConnect = pool.connect;

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && (sql.includes('u.id = $1') || sql.includes('WHERE id = $1'))) {
                return { rows: [{ id: 99, role_name: 'User', username: 'testuser' }] };
            }
            return { rows: [] };
        });

        // Mock pool.connect for the transaction
        const fakeClient = {
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (sql.includes('INSERT INTO deposits')) {
                    insertedRows.push({ sql, params });
                    return { rows: [{ id: 1001, created_at: new Date() }] };
                }
                if (sql.includes('UPDATE users SET balance')) {
                    updatedBalance.push({ sql, params });
                }
                return { rows: [] };
            },
            release: () => {}
        };
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000 })
        });

        assert.strictEqual(res.status, 201, 'Should return 201 Created');
        const body = await res.json();
        assert.ok(body.deposit, 'Should have deposit field');
        assert.strictEqual(body.deposit.status, 'Pending', 'Status must be Pending');
        assert.ok(body.deposit.id, 'Should have deposit id');
        assert.ok(body.deposit.unique_code, 'Should have unique_code');

        // Verify INSERT used status='Pending', not any success status
        assert.ok(insertedRows.length === 1, 'Should have exactly one INSERT');
        assert.ok(insertedRows[0].params.includes('Pending'), 'Status param must be Pending');

        // CRITICAL: verify no balance UPDATE was called
        assert.strictEqual(updatedBalance.length, 0, 'CRITICAL: balance must NOT be updated on deposit request');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    test('POST /api/deposit/request — response does not expose fake bank info', async () => {
        const token = makeToken(99);
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('u.id = $1') || sql.includes('WHERE id = $1')) return { rows: [{ id: 99, role_name: 'User' }] };
            return { rows: [] };
        });
        const fakeClient = {
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') return {};
                if (sql.includes('INSERT INTO deposits')) return { rows: [{ id: 1002, created_at: new Date() }] };
                return { rows: [] };
            },
            release: () => {}
        };
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000 })
        });
        const body = await res.json();
        const instrText = body.deposit?.paymentInstructions || '';
        // Pastikan tidak ada nomor rekening palsu lama
        assert.ok(!instrText.includes('123-456-7890'), 'Must not expose fake bank account');
        assert.ok(!instrText.includes('Bank ABC'), 'Must not expose fake bank name');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    test('GET /api/user/deposits — rejects unauthenticated request', async () => {
        const res = await fetch(`${baseUrl}/api/user/deposits`);
        assert.strictEqual(res.status, 401);
    });

    test('GET /api/user/deposits — returns only deposits for authenticated user', async () => {
        const token = makeToken(99);
        let queriedUserId = null;

        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('u.id = $1') || (sql.includes('WHERE id = $1') && !sql.includes('deposits'))) {
                return { rows: [{ id: 99, role_name: 'User' }] };
            }
            if (sql.includes('FROM deposits') && sql.includes('user_id = $1')) {
                queriedUserId = params[0];
                return { rows: [
                    { id: 1, amount: 50123, unique_code: 123, status: 'Pending', created_at: new Date() },
                    { id: 2, amount: 100456, unique_code: 456, status: 'Success', created_at: new Date() }
                ]};
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/user/deposits`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(res.status, 200);
        const list = await res.json();
        assert.ok(Array.isArray(list), 'Should return array');
        assert.strictEqual(list.length, 2, 'Should return 2 deposits');
        // Verify query was filtered by this user's ID
        assert.strictEqual(queriedUserId, 99, 'Query must filter by authenticated user_id');
        // Verify no sensitive fields exposed
        list.forEach(d => {
            assert.ok(!('user_id' in d), 'user_id must not be exposed in deposit list');
        });

        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 4B — Admin Deposit Approval Tests
// ============================================================
describe('Phase 4B: Admin Deposit Approval', () => {
    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    function makeAdminToken() {
        return jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
    }
    function makeUserToken(userId = 99) {
        return jwt.sign({ id: userId, username: 'user', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
    }

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { pool.query.mock.restore(); } catch (_) {}
        try { pool.connect.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    // Helper: mock protectAdmin DB check to return Admin role
    function mockAdminAuth() {
        return mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });
    }

    // TEST 1: Non-admin tidak bisa list deposit
    test('GET /api/admin/deposits — non-admin (user token) ditolak 403', async () => {
        const token = makeUserToken();
        // pool.query will check role and return non-admin
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/deposits`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(res.status, 403);
        pool.query.mock.restore();
    });

    // TEST 2: Admin bisa list deposit
    test('GET /api/admin/deposits — admin dapat list deposit', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('FROM deposits d')) {
                return { rows: [
                    { id: 1, user_id: 5, username: 'dicky', email: 'd@d.com', nomor_wa: '+628xxx', amount: 50123, unique_code: 123, status: 'Pending', created_at: new Date(), updated_at: new Date() },
                    { id: 2, user_id: 6, username: 'miku', email: 'm@m.com', nomor_wa: '+628yyy', amount: 100456, unique_code: 456, status: 'Approved', created_at: new Date(), updated_at: new Date() }
                ]};
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/deposits`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(res.status, 200);
        const list = await res.json();
        assert.ok(Array.isArray(list), 'Should return array');
        assert.strictEqual(list.length, 2, 'Should return 2 deposits');
        // Jangan expose password_hash
        list.forEach(d => {
            assert.ok(!('password' in d), 'password must not be exposed');
            assert.ok(!('password_hash' in d), 'password_hash must not be exposed');
        });

        pool.query.mock.restore();
    });

    // TEST 3: Approve Pending → saldo bertambah dan status Approved
    test('POST /api/admin/deposits/approve — Pending berhasil diapprove, saldo bertambah', async () => {
        const token = makeAdminToken();
        let balanceUpdated = false;
        let statusSetToApproved = false;
        let balanceHistoryInserted = false;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 10, user_id: 5, amount: 50123, unique_code: 123, status: 'Pending' }] };
                }
                if (sql.includes("SET status = 'Approved'")) {
                    statusSetToApproved = true;
                }
                if (sql.includes('UPDATE users SET balance = balance + $1')) {
                    balanceUpdated = true;
                }
                if (sql.includes('INSERT INTO balance_history')) {
                    balanceHistoryInserted = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 10 })
        });

        assert.strictEqual(res.status, 200, 'Should return 200 on success');
        const data = await res.json();
        assert.ok(data.message.includes('disetujui'), 'Message should confirm approval');
        assert.ok(statusSetToApproved, 'Status must be set to Approved');
        assert.ok(balanceUpdated, 'Balance must be updated');
        assert.ok(balanceHistoryInserted, 'Balance history must be inserted');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    // TEST 4: Double approve — ditolak 409, saldo tidak double
    test('POST /api/admin/deposits/approve — double approve ditolak 409, saldo tidak double', async () => {
        const token = makeAdminToken();
        let balanceUpdateCount = 0;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    // Deposit sudah Approved
                    return { rows: [{ id: 10, user_id: 5, amount: 50123, unique_code: 123, status: 'Approved' }] };
                }
                if (sql.includes('UPDATE users SET balance = balance + $1')) {
                    balanceUpdateCount++;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 10 })
        });

        assert.strictEqual(res.status, 409, 'Double approve must return 409 Conflict');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Error message must indicate already processed');
        assert.strictEqual(balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated on double approve');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    // TEST 5: Reject Pending → status Rejected, saldo tidak bertambah
    test('POST /api/admin/deposits/reject — Pending berhasil direject, saldo tidak bertambah', async () => {
        const token = makeAdminToken();
        let balanceUpdated = false;
        let statusSetToRejected = false;
        let balanceHistoryInserted = false;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 20, user_id: 7, amount: 75456, unique_code: 456, status: 'Pending' }] };
                }
                if (sql.includes("SET status = 'Rejected'")) {
                    statusSetToRejected = true;
                }
                if (sql.includes('UPDATE users SET balance')) {
                    balanceUpdated = true;
                }
                if (sql.includes('INSERT INTO balance_history')) {
                    balanceHistoryInserted = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 20 })
        });

        assert.strictEqual(res.status, 200, 'Should return 200 on reject');
        const data = await res.json();
        assert.ok(data.message.includes('ditolak'), 'Message should confirm rejection');
        assert.ok(statusSetToRejected, 'Status must be set to Rejected');
        assert.strictEqual(balanceUpdated, false, 'CRITICAL: balance must NOT be updated on reject');
        assert.strictEqual(balanceHistoryInserted, false, 'balance_history must NOT be inserted on reject');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    // TEST 6: Reject deposit yang sudah Approved → ditolak 409
    test('POST /api/admin/deposits/reject — reject deposit Approved ditolak 409', async () => {
        const token = makeAdminToken();

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 20, user_id: 7, amount: 75456, unique_code: 456, status: 'Approved' }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 20 })
        });

        assert.strictEqual(res.status, 409, 'Reject of Approved deposit must return 409');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Error must explain deposit is already processed');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    // TEST 7: User biasa tidak bisa approve/reject
    test('POST /api/admin/deposits/approve — user biasa (BRONZE) ditolak 403', async () => {
        const token = makeUserToken(88);
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 1 })
        });

        assert.strictEqual(res.status, 403, 'Regular user must be rejected with 403');
        pool.query.mock.restore();
    });

    // TEST 8: Approve deposit legacy status "Success" → ditolak 409, saldo tidak bertambah
    test('POST /api/admin/deposits/approve — legacy status "Success" ditolak 409, saldo tidak double', async () => {
        const token = makeAdminToken();
        let balanceUpdateCount = 0;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    // Deposit lama dari versi sebelum Phase 4B — statusnya 'Success'
                    return { rows: [{ id: 99, user_id: 10, amount: 25100, unique_code: 100, status: 'Success' }] };
                }
                if (sql.includes('UPDATE users SET balance = balance + $1')) {
                    balanceUpdateCount++;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 99 })
        });

        assert.strictEqual(res.status, 409, 'Legacy Success deposit must return 409 Conflict');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Error message must indicate already processed');
        assert.strictEqual(balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated for legacy Success deposit');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });
});
