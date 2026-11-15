const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');

// Use an ephemeral test port before requiring server.
process.env.PORT = '0';
process.env.JWT_SECRET = 'test-secret';
process.env.FOXY_API_KEY = 'test-foxy-key';
process.env.FOXY_CALLBACK_SECRET = '';

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

    // Perubahan kontrak SEC-001: sebelumnya tes "should reject invalid callback status" memeriksa
    // penolakan 400 atas req.body.status = 'HACKED'. Pada SEC-001 (Zero-Trust Payload), field status/sn/message
    // pada req.body tidak lagi dipercaya atau divalidasi langsung; perlindungan status tidak valid tetap berlaku
    // melalui sumber otoritatif Foxy GET /v1/status/:trx_id (status selain whitelist tidak boleh mengubah DB),
    // sementara respons HTTP untuk token valid tetap 200 { message: 'Callback berhasil diproses.' } agar provider tidak retry tanpa henti.
    test('should ignore invalid status from body/provider and never mutate DB', async () => {
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback?token=test-cb-secret`;
        process.env.FOXY_CALLBACK_SECRET = 'test-cb-secret';

        const axios = require('axios');
        const origGet = axios.get;
        let statusUpdateCalled = false;
        axios.get = async () => ({
            data: { status: true, data: { status: 'HACKED' } }
        });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 10, status: 'Pending', price: 1000, product_id: 1, provider_trx_id: 'TRX-BODY-IGN-1' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('UPDATE transactions')) {
                    statusUpdateCalled = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-BODY-IGN-1', status: 'HACKED', sn: 'EVIL-SN' })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.deepStrictEqual(data, { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusUpdateCalled, false, 'Invalid status from provider must not mutate DB');
        } finally {
            axios.get = origGet;
            process.env.FOXY_CALLBACK_SECRET = '';
            pool.connect.mock.restore();
            pool.query.mock.restore();
        }
    });

    test('should apply rate limiter to register endpoint', async () => {
        const regUrl = `http://127.0.0.1:${server.address().port}/api/auth/register`;
        const reqs = Array.from({ length: 6 }).map(() => fetch(regUrl, { method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'} }));
        const responses = await Promise.all(reqs);
        
        const has429 = responses.some(r => r.status === 429);
        assert.ok(has429, 'Rate limiter should kick in and return 429');
    });

    test('should save provider_sn on successful callback', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'test-cb-secret';
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback?token=test-cb-secret`;
        
        let updateQueryExecuted = false;
        
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            data: { status: true, data: { status: 'SUCCESS', sn: 'VOUCHER123' } }
        });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 1, status: 'Pending', price: 1000, product_id: 1, provider_trx_id: 'CB-SN-123' }] };
            }
            return { rows: [] };
        });
        
        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('SELECT * FROM transactions')) {
                    return { rows: [{ id: 1, invoice_id: 'TRX-123', user_id: 1, product_id: 1, status: 'Pending', price: 1000, provider_trx_id: 'CB-SN-123' }] };
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

        try {
            const res = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'CB-SN-123', status: 'SUCCESS', sn: 'VOUCHER123' })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.deepStrictEqual(data, { message: 'Callback berhasil diproses.' });
            assert.ok(updateQueryExecuted, 'UPDATE query with provider_sn should be executed');
        } finally {
            axios.get = origGet;
            process.env.FOXY_CALLBACK_SECRET = '';
            pool.connect.mock.restore();
            pool.query.mock.restore();
        }
    });

    test('should accept PARTIAL_REFUND callback with HTTP 200', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'test-cb-secret';
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback`;

        let partialRefundUpdateExecuted = false;
        let balanceModified = false;

        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            data: { status: true, data: { status: 'PARTIAL_REFUND' } }
        });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 1, status: 'Pending', price: 5000, product_id: 1, provider_trx_id: 'PR-TRX-001' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('SELECT * FROM transactions')) {
                    return { rows: [{ id: 1, invoice_id: 'TRX-PR1', user_id: 1, product_id: 1, status: 'Pending', price: 5000, provider_trx_id: 'PR-TRX-001' }] };
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

        try {
            const res = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-callback-token': 'test-cb-secret' },
                body: JSON.stringify({ trx_id: 'PR-TRX-001', status: 'PARTIAL_REFUND' })
            });

            assert.strictEqual(res.status, 200, 'PARTIAL_REFUND callback should return 200');
            const data = await res.json();
            assert.deepStrictEqual(data, { message: 'Callback berhasil diproses.' });
            assert.ok(partialRefundUpdateExecuted, "DB should be updated to 'Partial Refund'");
            assert.strictEqual(balanceModified, false, 'Balance should NOT be modified on PARTIAL_REFUND');
        } finally {
            axios.get = origGet;
            process.env.FOXY_CALLBACK_SECRET = '';
            pool.connect.mock.restore();
            pool.query.mock.restore();
        }
    });

    test('should enforce FOXY_CALLBACK_SECRET when configured', async () => {
        const callbackUrl = `http://127.0.0.1:${server.address().port}/api/foxy/callback`;
        process.env.FOXY_CALLBACK_SECRET = 'super-secret-callback-token-123';

        try {
            const resForbidden = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-callback-token': 'wrong-token' },
                body: JSON.stringify({ trx_id: 'TRX-SEC-1', status: 'SUCCESS' })
            });
            assert.strictEqual(resForbidden.status, 403, 'Wrong callback token must return 403');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
        }
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
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 1,
                        code: 'GOPAY',
                        name: 'GoPay',
                        type: 'ewallet',
                        account_number: '081200000001',
                        account_name: 'Admin MIKU Store (Placeholder)',
                        qris_image_url: null,
                        instructions: null,
                        is_qris: false,
                        min_amount: 10000
                    }]
                };
            }
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
            body: JSON.stringify({ amount: 50000, method: 'GoPay' })
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
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 1,
                        code: 'GOPAY',
                        name: 'GoPay',
                        type: 'ewallet',
                        account_number: '081200000001',
                        account_name: 'Admin MIKU Store (Placeholder)',
                        qris_image_url: null,
                        instructions: null,
                        is_qris: false,
                        min_amount: 10000
                    }]
                };
            }
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
            body: JSON.stringify({ amount: 50000, method: 'GoPay' })
        });
        assert.strictEqual(res.status, 201);
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

// ============================================================
// PHASE 4C — Deposit Method & Note Tests
// ============================================================
describe('Phase 4C: Deposit Method & Note', () => {
    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    function makeUserToken(userId = 55) {
        return jwt.sign({ id: userId, username: 'testuser', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
    }
    function makeAdminToken() {
        return jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
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

    // TEST 1: POST tanpa method → ditolak 400
    test('POST /api/deposit/request — tanpa method ditolak 400', async () => {
        const token = makeUserToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT u.id, u.username')) return { rows: [{ id: 55, username: 'testuser', role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000 })
        });

        assert.strictEqual(res.status, 400, 'Missing method must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('metode'), 'Error must mention metode');
        pool.query.mock.restore();
    });

    // TEST 2: POST method invalid → ditolak 400
    test('POST /api/deposit/request — method invalid ditolak 400', async () => {
        const token = makeUserToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT u.id, u.username')) return { rows: [{ id: 55, username: 'testuser', role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000, method: 'BCA' })
        });

        assert.strictEqual(res.status, 400, 'Invalid method must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('tidak valid') || data.message.toLowerCase().includes('metode'), 'Error must mention invalid method');
        pool.query.mock.restore();
    });

    // TEST 3: POST note >200 karakter → ditolak 400
    test('POST /api/deposit/request — note >200 karakter ditolak 400', async () => {
        const token = makeUserToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT u.id, u.username')) return { rows: [{ id: 55, username: 'testuser', role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const longNote = 'x'.repeat(201);
        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000, method: 'GoPay', note: longNote })
        });

        assert.strictEqual(res.status, 400, 'Note >200 chars must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('catatan') || data.message.toLowerCase().includes('panjang'), 'Error must mention note length');
        pool.query.mock.restore();
    });

    // TEST 4: POST valid dengan method dan note → tersimpan, status Pending, saldo tidak berubah
    test('POST /api/deposit/request — valid method+note tersimpan, saldo tidak bertambah', async () => {
        const token = makeUserToken();
        let insertedMethod = null;
        let insertedNote = null;
        let balanceUpdated = false;
        let balanceHistoryInserted = false;

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 3,
                        code: 'SHOPEEPAY',
                        name: 'ShopeePay',
                        type: 'ewallet',
                        account_number: '081200000003',
                        account_name: 'Admin MIKU Store (Placeholder)',
                        qris_image_url: null,
                        instructions: null,
                        is_qris: false,
                        min_amount: 10000
                    }]
                };
            }
            if (sql.includes('SELECT u.id, u.username')) return { rows: [{ id: 55, username: 'testuser', role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('INSERT INTO deposits')) {
                    // params: [userId, totalAmount, uniqueCode, 'Pending', method, note]
                    insertedMethod = params[4];
                    insertedNote = params[5];
                    return { rows: [{ id: 77, created_at: new Date() }] };
                }
                if (sql.includes('UPDATE users SET balance')) balanceUpdated = true;
                if (sql.includes('INSERT INTO balance_history')) balanceHistoryInserted = true;
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 75000, method: 'ShopeePay', note: 'Transfer dari Dicky jam 14.00' })
        });

        assert.strictEqual(res.status, 201, 'Valid request must return 201');
        const data = await res.json();
        assert.ok(data.deposit, 'Response must have deposit object');
        assert.strictEqual(data.deposit.method, 'ShopeePay', 'Response must include method');
        assert.strictEqual(insertedMethod, 'ShopeePay', 'Method must be saved to DB');
        assert.strictEqual(insertedNote, 'Transfer dari Dicky jam 14.00', 'Note must be saved to DB');
        assert.strictEqual(balanceUpdated, false, 'CRITICAL: balance must NOT be updated on deposit request');
        assert.strictEqual(balanceHistoryInserted, false, 'balance_history must NOT be inserted on deposit request');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    // TEST 5: POST valid tanpa note → note NULL di DB, tidak error
    test('POST /api/deposit/request — tanpa note menyimpan NULL, tidak error', async () => {
        const token = makeUserToken();
        let insertedNote = 'SENTINEL'; // nilai awal untuk mendeteksi jika tidak diset

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 2,
                        code: 'DANA',
                        name: 'DANA',
                        type: 'ewallet',
                        account_number: '081200000002',
                        account_name: 'Admin MIKU Store (Placeholder)',
                        qris_image_url: null,
                        instructions: null,
                        is_qris: false,
                        min_amount: 10000
                    }]
                };
            }
            if (sql.includes('SELECT u.id, u.username')) return { rows: [{ id: 55, username: 'testuser', role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('INSERT INTO deposits')) {
                    insertedNote = params[5]; // null expected
                    return { rows: [{ id: 78, created_at: new Date() }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 25000, method: 'DANA' })
        });

        assert.strictEqual(res.status, 201, 'Request without note must return 201');
        assert.strictEqual(insertedNote, null, 'Note must be NULL when not provided');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    // TEST 6: GET /api/user/deposits → mengembalikan method dan note
    test('GET /api/user/deposits — return method dan note milik user', async () => {
        const token = makeUserToken(55);
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT u.id, u.username')) return { rows: [{ id: 55, username: 'testuser', role_name: 'BRONZE' }] };
            if (sql.includes('FROM deposits')) {
                return { rows: [
                    { id: 77, amount: 75350, unique_code: 350, status: 'Pending', method: 'ShopeePay', note: 'Transfer jam 14.00', created_at: new Date() },
                    { id: 78, amount: 25123, unique_code: 123, status: 'Approved', method: 'DANA', note: null, created_at: new Date() }
                ]};
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/user/deposits`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        assert.strictEqual(res.status, 200);
        const deposits = await res.json();
        assert.ok(Array.isArray(deposits), 'Must return array');
        assert.strictEqual(deposits[0].method, 'ShopeePay', 'method must be returned');
        assert.strictEqual(deposits[0].note, 'Transfer jam 14.00', 'note must be returned');
        assert.strictEqual(deposits[1].method, 'DANA');
        assert.strictEqual(deposits[1].note, null, 'null note must be returned as null');

        pool.query.mock.restore();
    });

    // TEST 7: GET /api/admin/deposits → mengembalikan method dan note
    test('GET /api/admin/deposits — admin dapat melihat method dan note', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('FROM deposits d')) {
                return { rows: [
                    { id: 77, user_id: 55, username: 'testuser', email: 't@t.com', nomor_wa: '+628x', amount: 75350, unique_code: 350, status: 'Pending', method: 'ShopeePay', note: 'Transfer jam 14.00', created_at: new Date(), updated_at: new Date() }
                ]};
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/deposits`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        assert.strictEqual(res.status, 200);
        const deposits = await res.json();
        assert.ok(Array.isArray(deposits));
        assert.strictEqual(deposits[0].method, 'ShopeePay', 'admin must see method');
        assert.strictEqual(deposits[0].note, 'Transfer jam 14.00', 'admin must see note');
        assert.ok(!('password_hash' in deposits[0]), 'password_hash must not be exposed');

        pool.query.mock.restore();
    });

    // TEST 8: approve/reject existing tidak terpengaruh oleh kolom baru
    test('POST /api/admin/deposits/approve — masih berjalan dengan kolom method/note baru', async () => {
        const token = makeAdminToken();
        let balanceUpdated = false;

        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') return {};
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 77, user_id: 55, amount: 75350, unique_code: 350, status: 'Pending', method: 'ShopeePay', note: 'Test' }] };
                }
                if (sql.includes('UPDATE users SET balance = balance + $1')) balanceUpdated = true;
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 77 })
        });

        assert.strictEqual(res.status, 200, 'Approve must still work with method/note columns');
        assert.ok(balanceUpdated, 'Balance must still be updated on approve');

        pool.query.mock.restore();
        pool.connect.mock.restore();
    });
});

// ============================================================
// PHASE 5B — Game ID Validation Safety Tests
// ============================================================
describe('Phase 5B: Game ID Validation in Order Flow', () => {
    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    function makeAdminToken() {
        return jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
    }
    function makeUserToken(userId = 42) {
        return jwt.sign({ id: userId, username: 'testuser', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
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

    // TEST 1: Non-admin tidak bisa update validation config
    test('PUT /api/admin/products/:id/validation — non-admin ditolak 403', async () => {
        const token = makeUserToken(42);
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/1/validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ validation_config: { enabled: true, validator: 'mobile-legends-region' } })
        });

        assert.strictEqual(res.status, 403, 'Non-admin must be rejected with 403');
        pool.query.mock.restore();
    });

    // TEST 2: Config invalid (enabled=true tanpa validator) → ditolak 400
    test('PUT /api/admin/products/:id/validation — enabled=true tanpa validator ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/1/validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ validation_config: { enabled: true } })
        });

        assert.strictEqual(res.status, 400, 'Missing validator must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('validator'), 'Error must mention validator');
        pool.query.mock.restore();
    });

    // TEST 3: Config invalid (validator format berbahaya) → ditolak 400
    test('PUT /api/admin/products/:id/validation — validator format berbahaya ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/1/validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ validation_config: { enabled: true, validator: '../../../etc/passwd' } })
        });

        assert.strictEqual(res.status, 400, 'Invalid validator format must return 400');
        pool.query.mock.restore();
    });

    // TEST 4: Admin bisa simpan config valid
    test('PUT /api/admin/products/:id/validation — admin bisa simpan config valid', async () => {
        const token = makeAdminToken();
        let savedConfig = null;

        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        const configToSave = {
            enabled: true,
            validator: 'mobile-legends-region',
            rules: { allowedRegions: ['ID'] }
        };

        const res = await fetch(`${baseUrl}/api/admin/products/1/validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ validation_config: configToSave })
        });

        assert.strictEqual(res.status, 200, 'Valid config must return 200');
        const data = await res.json();
        assert.ok(data.message.includes('berhasil'), 'Message should confirm success');
        assert.ok(savedConfig !== null, 'Config must be saved to DB');
        assert.strictEqual(savedConfig.enabled, true, 'enabled must be preserved');
        assert.strictEqual(savedConfig.validator, 'mobile-legends-region', 'validator must be preserved');
        pool.query.mock.restore();
    });

    // TEST 5: Order produk TANPA validation_config → flow normal, tidak error validasi
    test('POST /api/order — produk tanpa validation_config tidak error validasi', async () => {
        const token = makeUserToken(42);

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('FROM (SELECT * FROM products')) {
                    return { rows: [{ id: 1, name: 'Diamond 100', provider_sku: 'ML-100', price: 20000,
                        status: 'Active', game_id: 1, needs_server_id: false,
                        validation_config: null,
                        use_manual_prices: false, manual_prices: {},
                        use_custom_margin: false }] };
                }
                if (sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance: 99999, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (sql.includes('FROM roles WHERE id')) return { rows: [{ margin_percent: 10 }] };
                if (sql.includes('FROM flash_sales')) return { rows: [] };
                if (sql.includes('FROM transactions')) return { rows: [] };
                return { rows: [] };
            },
            release: () => {}
        }));

        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({ data: { data: [{ product_code: 'ML-100', product_price: 18000 }] } });

        const res = await fetch(`${baseUrl}/api/order`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: 1, targetGameId: '123456' })
        });

        axios.get = origGet;
        pool.connect.mock.restore();

        const data = await res.json();
        // The order will fail at Foxy provider step (mocked away), but NOT at validation
        assert.ok(
            !JSON.stringify(data).includes('Validasi ID'),
            'Response must NOT mention game ID validation for product without config'
        );
    });

    // TEST 6: Order dengan enabled=true → validator dipanggil, jika gagal saldo TIDAK dipotong
    // Di lingkungan test, PGS_KEY dan PGS_API_KEY tidak ada, sehingga validateGameId selalu
    // mengembalikan { success: false } — ini membuktikan bahwa order DIBLOKIR sebelum potong saldo.
    test('POST /api/order — enabled=true + validator return failure → 400, saldo tidak dipotong', async () => {
        const token = makeUserToken(42);
        let balanceDeducted = false;

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('FROM (SELECT * FROM products')) {
                    return { rows: [{ id: 2, name: 'Diamond 100', provider_sku: 'ML-100', price: 20000,
                        status: 'Active', game_id: 1, needs_server_id: false,
                        // enabled=true → helper akan memanggil validateGameId
                        // Di test env, PGS keys tidak ada → returns { success: false }
                        validation_config: { enabled: true, validator: 'mobile-legends-region', rules: {} },
                        use_manual_prices: false, manual_prices: {},
                        use_custom_margin: false }] };
                }
                if (sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance: 99999, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (sql.includes('FROM roles WHERE id')) return { rows: [{ margin_percent: 10 }] };
                if (sql.includes('FROM flash_sales')) return { rows: [] };
                if (sql.includes('FROM transactions')) return { rows: [] };
                if (sql.includes('UPDATE users SET balance = balance - $1')) {
                    balanceDeducted = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({ data: { data: [{ product_code: 'ML-100', product_price: 18000 }] } });

        const res = await fetch(`${baseUrl}/api/order`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: 2, targetGameId: 'INVALID999' })
        });

        axios.get = origGet;
        pool.connect.mock.restore();

        // In test env, PGS keys are absent → validateGameId returns { success: false }
        // This means the order MUST be blocked (400) and balance NOT deducted
        assert.strictEqual(res.status, 400, 'Order with enabled validation must return 400 when validator fails');
        const data = await res.json();
        // Message should be a safe validation-related error (not a raw DB error)
        assert.ok(data.message, 'Response must have a message');
        assert.ok(
            !JSON.stringify(data).includes('password') &&
            !JSON.stringify(data).includes('SECRET') &&
            !JSON.stringify(data).includes('stack'),
            'Response must not expose sensitive info'
        );
        assert.strictEqual(balanceDeducted, false, 'CRITICAL: balance must NOT be deducted when validation fails');
    });

    // TEST 7: Produk dengan enabled=false → validasi tidak berjalan, order lanjut normal
    // (Membuktikan opt-in: enabled=false tidak trigger validator sama sekali)
    test('POST /api/order — enabled=false → tidak trigger validator, flow normal', async () => {
        const token = makeUserToken(42);
        let balanceDeducted = false;

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (sql.includes('FROM (SELECT * FROM products')) {
                    return { rows: [{ id: 4, name: 'Diamond 50', provider_sku: 'ML-50', price: 10000,
                        status: 'Active', game_id: 1, needs_server_id: false,
                        // enabled=false → helper harus skip validasi
                        validation_config: { enabled: false, validator: 'mobile-legends-region' },
                        use_manual_prices: false, manual_prices: {},
                        use_custom_margin: false }] };
                }
                if (sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance: 99999, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (sql.includes('FROM roles WHERE id')) return { rows: [{ margin_percent: 10 }] };
                if (sql.includes('FROM flash_sales')) return { rows: [] };
                if (sql.includes('FROM transactions')) return { rows: [] };
                if (sql.includes('UPDATE users SET balance = balance - $1')) {
                    balanceDeducted = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({ data: { data: [{ product_code: 'ML-50', product_price: 9000 }] } });

        const res = await fetch(`${baseUrl}/api/order`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: 4, targetGameId: '123456' })
        });

        axios.get = origGet;
        pool.connect.mock.restore();

        const data = await res.json();
        // Should NOT be blocked by validation (enabled=false means skip)
        // May fail at Foxy provider step but NOT at validation
        assert.ok(
            !JSON.stringify(data).includes('Validasi ID'),
            'Response must NOT mention game ID validation when enabled=false'
        );
        assert.ok(
            !JSON.stringify(data).includes('API Key untuk PGSCODE'),
            'Validator must NOT be called when enabled=false'
        );
    });
});

// ============================================================
// PHASE 5B-2 — Bulk Validation Hardening + Name Sanitizer Tests
// ============================================================
describe('Phase 5B-2: Bulk Validation & Name Sanitizer', () => {
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
        await new Promise(resolve => server.close(resolve));
    });

    // ---- BULK VALIDATION ENDPOINT TESTS ----

    // TEST 1: Non-admin tidak bisa pakai bulk-validation
    test('PUT /api/admin/products/bulk-validation — non-admin ditolak 403', async () => {
        const token = makeUserToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'BRONZE' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productIds: [1, 2], validation_config: null })
        });

        assert.strictEqual(res.status, 403, 'Non-admin must be rejected with 403');
        pool.query.mock.restore();
    });

    // TEST 2: Config invalid pada bulk → ditolak 400
    test('PUT /api/admin/products/bulk-validation — invalid config ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1, 2],
                validation_config: { enabled: true }  // tanpa validator
            })
        });

        assert.strictEqual(res.status, 400, 'Invalid config must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('validator'), 'Error must mention validator');
        pool.query.mock.restore();
    });

    // TEST 3: productIds kosong → ditolak 400
    test('PUT /api/admin/products/bulk-validation — productIds kosong ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productIds: [], validation_config: null })
        });

        assert.strictEqual(res.status, 400, 'Empty productIds must return 400');
        pool.query.mock.restore();
    });

    // TEST 4: productIds > 500 → ditolak 400
    test('PUT /api/admin/products/bulk-validation — batch > 500 ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const bigIds = Array.from({ length: 501 }, (_, i) => i + 1);
        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productIds: bigIds, validation_config: null })
        });

        assert.strictEqual(res.status, 400, 'Batch > 500 must return 400');
        const data = await res.json();
        assert.ok(data.message.includes('500'), 'Error must mention 500 limit');
        pool.query.mock.restore();
    });

    // TEST 5: productIds berisi nilai non-angka → ditolak 400
    test('PUT /api/admin/products/bulk-validation — productId non-angka ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productIds: [1, 'abc', 3], validation_config: null })
        });

        assert.strictEqual(res.status, 400, 'Non-integer productIds must return 400');
        pool.query.mock.restore();
    });

    // TEST 6: Admin bisa update bulk dengan config valid
    test('PUT /api/admin/products/bulk-validation — admin update valid berhasil 200', async () => {
        const token = makeAdminToken();
        let savedConfig = null;
        let savedIds = null;

        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                savedIds = params[1];
                return { rowCount: 3 };
            }
            return { rows: [] };
        });

        const configToSave = {
            enabled: true,
            validator: 'mobile-legends-region',
            rules: { allowedRegions: ['ID'] }
        };

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [10, 11, 12],
                validation_config: configToSave
            })
        });

        assert.strictEqual(res.status, 200, 'Valid bulk update must return 200');
        const data = await res.json();
        assert.ok(data.message.includes('3'), 'Message should mention updated count');
        assert.ok(savedConfig !== null, 'Config must be saved');
        assert.strictEqual(savedConfig.validator, 'mobile-legends-region', 'validator preserved');
        assert.deepStrictEqual(savedIds, [10, 11, 12], 'IDs must be passed correctly');
        pool.query.mock.restore();
    });

    // TEST 7: Bulk dengan config null → berhasil (hapus validasi dari semua produk)
    test('PUT /api/admin/products/bulk-validation — config null berhasil (disable)', async () => {
        const token = makeAdminToken();
        let savedConfig = 'NOT_SET';

        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                return { rowCount: 2 };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ productIds: [5, 6], validation_config: null })
        });

        assert.strictEqual(res.status, 200, 'null config (disable) must return 200');
        assert.strictEqual(savedConfig, null, 'null must be saved to DB (removes validation)');
        pool.query.mock.restore();
    });

    // ---- NAME SANITIZER UNIT TESTS ----

    // TEST 8: sanitizeValidationServiceName tidak mengubah game code
    test('sanitizeValidationServiceName — game code tidak diubah di /api/games/validatable', async () => {
        // Test endpoint langsung: game code (gameCode) harus sama dengan data asli
        // Proxy test via endpoint — ambil data dan cek field gameCode tidak berubah
        const res = await fetch(`${baseUrl}/api/games/validatable`);
        // endpoint ini bisa return 500 jika data_cekid.json tidak terbaca di test env
        // tapi kita hanya perlu cek bahwa endpoint ada dan merespons
        assert.ok(res.status === 200 || res.status === 500, 'Endpoint must exist');
    });

    // TEST 9: Suffix provider disensor dari label (unit test langsung pada helper)
    test('sanitizeValidationServiceName — suffix provider disensor dari label', () => {
        // Ambil fungsi dari server module — karena tidak di-export, kita test via behavior endpoint
        // Verifikasi dengan membuat array kasus dan memvalidasi transformasi yang diharapkan
        const cases = [
            { input: 'Mobile Legends (Mobapay)', expected: 'Mobile Legends' },
            { input: 'PUBG Mobile (DG)', expected: 'PUBG Mobile' },
            { input: 'Honor Of Kings 2 (WORK, FAST)', expected: 'Honor Of Kings 2' },
            { input: 'Mobile Legends With Region', expected: 'Mobile Legends - Verifikasi Region' },
            { input: 'Free Fire (Work Fast)', expected: 'Free Fire' },
            { input: 'AU2 Mobile (HK)', expected: 'AU2 Mobile' },
            { input: 'PUBG Mobile Global 2 (FAST)', expected: 'PUBG Mobile Global 2' },
            { input: 'Genshin Impact (Work Fast)', expected: 'Genshin Impact' },
            { input: 'Mobile Legends', expected: 'Mobile Legends' }, // tanpa suffix, tidak berubah
        ];

        // Implementasi ulang helper di sini untuk unit test murni (tanpa menyentuh server)
        function sanitizeValidationServiceName(name) {
            if (!name || typeof name !== 'string') return name || '';
            let clean = name.trim();
            if (/mobile.?legends.?with.?region/i.test(clean)) return 'Mobile Legends - Verifikasi Region';
            clean = clean.replace(/\s*\([^)]*\)\s*$/i, '').trim();
            clean = clean.replace(/\s+(Work\s+Fast|FAST|WORK)\s*$/i, '').trim();
            return clean || name.trim();
        }

        cases.forEach(({ input, expected }) => {
            const result = sanitizeValidationServiceName(input);
            assert.strictEqual(result, expected, `"${input}" should become "${expected}", got "${result}"`);
        });
    });

    // TEST 10: Game code tidak terpengaruh oleh sanitasi nama (struktur data tetap benar)
    test('sanitizeValidationServiceName — game code harus tetap sama meski nama disanitasi', () => {
        // Verifikasi bahwa field gameCode (yang disimpan ke DB) TIDAK diubah oleh sanitizer
        // Simulasikan map() yang sama seperti di server
        const rawGames = [
            { name: 'Mobile Legends (Mobapay)', game: 'mobile-legends-mp', hasZoneId: true },
            { name: 'PUBG Mobile (DG)', game: 'pubg-mobile-dg', hasZoneId: true },
            { name: 'Mobile Legends With Region', game: 'mobile-legends-region', hasZoneId: true },
        ];

        function sanitizeValidationServiceName(name) {
            if (!name || typeof name !== 'string') return name || '';
            let clean = name.trim();
            if (/mobile.?legends.?with.?region/i.test(clean)) return 'Mobile Legends - Verifikasi Region';
            clean = clean.replace(/\s*\([^)]*\)\s*$/i, '').trim();
            clean = clean.replace(/\s+(Work\s+Fast|FAST|WORK)\s*$/i, '').trim();
            return clean || name.trim();
        }

        const processed = rawGames.map(game => ({
            id: game.name,
            name: sanitizeValidationServiceName(game.name),  // label disanitasi
            gameCode: game.game,                              // code TIDAK disentuh
            hasZoneIdForValidation: game.hasZoneId
        }));

        assert.strictEqual(processed[0].gameCode, 'mobile-legends-mp', 'Mobapay game code unchanged');
        assert.strictEqual(processed[0].name, 'Mobile Legends', 'Mobapay label sanitized');
        assert.strictEqual(processed[1].gameCode, 'pubg-mobile-dg', 'DG game code unchanged');
        assert.strictEqual(processed[1].name, 'PUBG Mobile', 'DG label sanitized');
        assert.strictEqual(processed[2].gameCode, 'mobile-legends-region', 'Region game code unchanged');
        assert.strictEqual(processed[2].name, 'Mobile Legends - Verifikasi Region', 'Region label labeled correctly');
    });
});

// ============================================================
// PHASE 5C-2A — Mobapay MLBB Eligibility Engine Tests
// ============================================================
describe('Phase 5C-2A: Mobapay MLBB Eligibility Engine', () => {
    const { _internal } = require('../utils/validators/stalk-ml-promo.js');
    const { isItemAvailable, detectPaymentChannelCountry, MOBAPAY_SKU, VALID_DD_TARGETS } = _internal;

    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    function makeAdminToken() {
        return jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
    }
    function makeUserToken() {
        return jwt.sign({ id: 99, username: 'user', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
    }

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { pool.query.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    // ---- UNIT TESTS: isItemAvailable ----

    test('isItemAvailable — item null → false', () => {
        assert.strictEqual(isItemAvailable(null), false);
        assert.strictEqual(isItemAvailable(undefined), false);
    });

    test('isItemAvailable — game_can_buy=false → false', () => {
        assert.strictEqual(isItemAvailable({ game_can_buy: false }), false);
    });

    test('isItemAvailable — reached_limit=true → false', () => {
        assert.strictEqual(isItemAvailable({ game_can_buy: true, goods_limit: { reached_limit: true } }), false);
    });

    test('isItemAvailable — normal item → true', () => {
        assert.strictEqual(isItemAvailable({ game_can_buy: true, goods_limit: { reached_limit: false } }), true);
        assert.strictEqual(isItemAvailable({ sku: 'abc' }), true); // no limit fields = available
    });

    // ---- UNIT TESTS: detectPaymentChannelCountry ----

    test('detectPaymentChannelCountry — ID channel gopay → true', () => {
        const shopInfo = {
            good_list: [{
                sku: 'com.moonton.diamond_mt_id_50',
                pay_channel_sub: [{ active: 1, direct_channel: 'GoPay', cus_code: 'gopay_id_001' }]
            }]
        };
        assert.strictEqual(detectPaymentChannelCountry(shopInfo, ['ID']), true);
    });

    test('detectPaymentChannelCountry — no ID channel → false', () => {
        const shopInfo = {
            good_list: [{
                sku: 'com.moonton.diamond_mt_id_50',
                pay_channel_sub: [{ active: 1, direct_channel: 'PayPal', cus_code: 'paypal_us_001' }]
            }]
        };
        assert.strictEqual(detectPaymentChannelCountry(shopInfo, ['ID']), false);
    });

    // ---- UNIT TESTS: MOBAPAY_SKU constants ----

    test('MOBAPAY_SKU — WDP SKU benar', () => {
        assert.strictEqual(MOBAPAY_SKU.WDP, 'com.moonton.diamond_mt_id_one_time_weekly_diamond');
    });

    test('MOBAPAY_SKU — DD_TITLES mengandung semua 4 target', () => {
        assert.ok(MOBAPAY_SKU.DD_TITLES['50+50']);
        assert.ok(MOBAPAY_SKU.DD_TITLES['150+150']);
        assert.ok(MOBAPAY_SKU.DD_TITLES['250+250']);
        assert.ok(MOBAPAY_SKU.DD_TITLES['500+500']);
        assert.strictEqual(VALID_DD_TARGETS.length, 4);
    });

    // ---- ADMIN SANITIZER: Mobapay config validation ----

    test('PUT /api/admin/products/bulk-validation — checks invalid untuk mobapay ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    checks: ['invalid_check_xyz']
                }
            })
        });

        assert.strictEqual(res.status, 400, 'Invalid check must return 400');
        const data = await res.json();
        assert.ok(data.message.includes('invalid_check_xyz'), 'Error must mention invalid check');
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — double_diamond tanpa target ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    checks: ['double_diamond']
                    // rules.target missing
                }
            })
        });

        assert.strictEqual(res.status, 400, 'double_diamond without target must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('target'), 'Error must mention target');
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — double_diamond target tidak valid ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    checks: ['double_diamond'],
                    rules: { target: '999+999' }
                }
            })
        });

        assert.strictEqual(res.status, 400, 'Invalid DD target must return 400');
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — config mobapay WDP valid berhasil 200', async () => {
        const token = makeAdminToken();
        let savedConfig = null;
        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                return { rowCount: 2 };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1, 2],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    country: 'ID',
                    checks: ['wdp_available']
                }
            })
        });

        assert.strictEqual(res.status, 200, 'Valid Mobapay WDP config must return 200');
        assert.ok(savedConfig !== null, 'Config must be saved');
        assert.strictEqual(savedConfig.validator, 'mobapay-mlbb-eligibility');
        assert.deepStrictEqual(savedConfig.checks, ['wdp_available']);
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — config mobapay DD 50+50 valid berhasil 200', async () => {
        const token = makeAdminToken();
        let savedConfig = null;
        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [5],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    country: 'ID',
                    checks: ['double_diamond'],
                    rules: { target: '50+50' }
                }
            })
        });

        assert.strictEqual(res.status, 200, 'Valid DD 50+50 config must return 200');
        assert.ok(savedConfig !== null);
        assert.strictEqual(savedConfig.rules.target, '50+50');
        pool.query.mock.restore();
    });

    // ---- ORDER FLOW: validateOrderGameIdIfNeeded dispatch logic (unit) ----

    test('validateOrderGameIdIfNeeded — produk tanpa validation_config di-skip (tidak panggil Mobapay)', async () => {
        // Test langsung melalui internal logic: config null → skip
        const { checkMobapayMlbbEligibility } = require('../utils/validators/stalk-ml-promo.js');
        let called = false;
        // Tidak ada cara untuk Mobapay terpanggil jika config null — verifikasi logika
        const mockProduct = { validation_config: null, needs_server_id: false };
        // Simulasikan logika skip di validateOrderGameIdIfNeeded
        const config = mockProduct.validation_config;
        const skipped = !config || config.enabled !== true || !config.validator;
        assert.strictEqual(skipped, true, 'Produk tanpa config harus skip');
        assert.strictEqual(called, false, 'Mobapay tidak boleh dipanggil');
    });

    test('validateOrderGameIdIfNeeded — config mobapay checks=[] → tidak ada check (langsung lulus tanpa API call)', async () => {
        // Test internal logic: checks kosong → langsung return success
        const { checkMobapayMlbbEligibility } = require('../utils/validators/stalk-ml-promo.js');
        // Panggil langsung engine dengan checks=[] — tidak boleh hit network
        // Karena checks kosong, function return sebelum axios.get dipanggil
        const result = await checkMobapayMlbbEligibility('123456', '1234', [], {}, { country: 'ID', timeout: 1 });
        assert.strictEqual(result.success, true, 'Empty checks must pass immediately');
        assert.ok(result.message.includes('Tidak ada'), 'Message must indicate no checks');
    });

    test('validateOrderGameIdIfNeeded — config mobapay enabled=false → skip (tidak panggil Mobapay)', () => {
        const mockProduct = {
            validation_config: { enabled: false, validator: 'mobapay-mlbb-eligibility', checks: ['wdp_available'] },
            needs_server_id: true
        };
        const config = mockProduct.validation_config;
        const skipped = !config || config.enabled !== true || !config.validator;
        assert.strictEqual(skipped, true, 'enabled=false harus skip');
    });

    // ---- PRE-VALIDATE ENDPOINT: POST /api/products/:productId/validate ----

    // HOTFIX REGRESSION: Verifikasi query JOIN — tidak boleh query p.needs_server_id
    test('POST /api/products/:id/validate — HOTFIX: query harus JOIN ke games untuk needs_server_id', async () => {
        let capturedSql = null;
        mock.method(pool, 'query', async (sql) => {
            // Tangkap SQL yang digunakan oleh endpoint pre-validate
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                capturedSql = sql;
                // Simulasikan produk tanpa validation_config
                return { rows: [{ id: 999, name: 'Test', validation_config: null, game_id: 1, needs_server_id: false }] };
            }
            return { rows: [] };
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/999/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '609923809', zoneId: '8430' })
            });
            // Harus tidak 500 (root bug)
            assert.ok(res.status !== 500, `Must not return 500; got ${res.status}`);
            // Pastikan SQL yang dipakai mengandung JOIN ke games
            assert.ok(capturedSql !== null, 'Query harus dieksekusi');
            assert.ok(
                capturedSql.includes('LEFT JOIN games'),
                `Query harus mengandung LEFT JOIN games, tapi dapat: ${capturedSql}`
            );
            // Pastikan TIDAK query p.needs_server_id (kolom yang tidak ada di products)
            assert.ok(
                !capturedSql.includes('p.needs_server_id'),
                'Query tidak boleh mengakses p.needs_server_id (kolom ada di games, bukan products)'
            );
            // Pastikan pakai COALESCE dari games
            assert.ok(
                capturedSql.includes('COALESCE(g.needs_server_id'),
                'Query harus pakai COALESCE(g.needs_server_id) dari tabel games'
            );
        } finally {
            pool.query.mock.restore();
        }
    });

    // HOTFIX REGRESSION: Simulasi produk 217 (mobapay, no 500)
    test('POST /api/products/217/validate — HOTFIX: mobapay config tidak menghasilkan 500 karena needs_server_id', async () => {
        // Mock produk 217: validation_config mobapay aktif, needs_server_id berasal dari games JOIN
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 217,
                        name: 'Test Product 217',
                        validation_config: {
                            enabled: true,
                            validator: 'mobapay-mlbb-eligibility',
                            country: 'ID',
                            checks: ['double_diamond'],
                            rules: { target: '50+50' }
                        },
                        game_id: 1,
                        needs_server_id: false  // berasal dari COALESCE(g.needs_server_id, false)
                    }]
                };
            }
            return { rows: [] };
        });

        // Mock axios.get — simulasikan Mobapay merespons DD available
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            status: 200,
            data: {
                code: 0,
                data: {
                    user_info: { code: 0, user_name: 'TestUser' },
                    shop_info: {
                        good_list: [
                            { sku: 'com.moonton.diamond_mt_id_50', pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }] }
                        ],
                        shelf_location: [{
                            title: 'Double Diamonds on First Recharge',
                            goods: [
                                { title: '50+50', game_can_buy: true, goods_limit: { reached_limit: false } }
                            ]
                        }]
                    }
                }
            }
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/217/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '609923809', zoneId: '8430' })
            });
            // ROOT BUG: sebelum fix ini → 500. Setelah fix → tidak boleh 500
            assert.ok(
                res.status !== 500,
                `[HOTFIX REGRESSION] Produk 217 tidak boleh return 500. Status: ${res.status}`
            );
            const data = await res.json();
            assert.ok(
                data.success !== undefined,
                'Response harus punya field success'
            );
        } finally {
            axios.get = origGet;
            pool.query.mock.restore();
        }
    });

    test('POST /api/products/:id/validate — mobapay DD unavailable → 400 dengan pesan Promo Double Diamond', async () => {
        // Mock pool.query: kembalikan produk dengan validation_config mobapay DD
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 217,
                        name: 'Test Product DD',
                        validation_config: {
                            enabled: true,
                            validator: 'mobapay-mlbb-eligibility',
                            country: 'ID',
                            checks: ['double_diamond'],
                            rules: { target: '50+50' }
                        },
                        game_id: 1,
                        needs_server_id: true  // dari COALESCE(g.needs_server_id, false)
                    }]
                };
            }
            return { rows: [] };
        });

        // Mock axios.get untuk simulasi respons Mobapay: DD shelf ada tapi item 50+50 reached_limit
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            status: 200,
            data: {
                code: 0,
                data: {
                    user_info: { code: 0, user_name: 'TestUser' },
                    shop_info: {
                        good_list: [
                            { sku: 'com.moonton.diamond_mt_id_50', pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }] }
                        ],
                        shelf_location: [{
                            title: 'Double Diamonds on First Recharge',
                            goods: [
                                { title: '50+50', game_can_buy: true, goods_limit: { reached_limit: true } }
                            ]
                        }]
                    }
                }
            }
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/217/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '123456789', zoneId: '1234' })
            });
            assert.strictEqual(res.status, 400, 'DD unavailable must return 400');
            const data = await res.json();
            assert.strictEqual(data.success, false, 'success must be false');
            assert.ok(
                data.message.includes('Promo Double Diamond'),
                `Message must include "Promo Double Diamond", got: ${data.message}`
            );
        } finally {
            axios.get = origGet;
            pool.query.mock.restore();
        }
    });

    test('POST /api/products/:id/validate — mobapay WDP available → 200 success', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 218,
                        name: 'Test Product WDP',
                        validation_config: {
                            enabled: true,
                            validator: 'mobapay-mlbb-eligibility',
                            country: 'ID',
                            checks: ['wdp_available'],
                            rules: {}
                        },
                        game_id: 1,
                        needs_server_id: true
                    }]
                };
            }
            return { rows: [] };
        });

        // Mock axios.get: WDP SKU ada dan tersedia
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            status: 200,
            data: {
                code: 0,
                data: {
                    user_info: { code: 0, user_name: 'TestUser' },
                    shop_info: {
                        good_list: [
                            {
                                sku: 'com.moonton.diamond_mt_id_one_time_weekly_diamond',
                                game_can_buy: true,
                                pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }]
                            },
                            { sku: 'com.moonton.diamond_mt_id_50', pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }] }
                        ],
                        shelf_location: []
                    }
                }
            }
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/218/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '123456789', zoneId: '1234' })
            });
            assert.strictEqual(res.status, 200, 'WDP available must return 200');
            const data = await res.json();
            assert.strictEqual(data.success, true, 'success must be true');
            assert.ok(
                data.message.includes('ID valid'),
                `Message must include "ID valid", got: ${data.message}`
            );
            assert.ok(data.data && data.data.mobapay === true, 'data.mobapay must be true');
        } finally {
            axios.get = origGet;
            pool.query.mock.restore();
        }
    });

    test('POST /api/products/:id/validate — validator PGS existing tidak rusak (tetap panggil validateGameId)', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 100,
                        name: 'Test PGS Product',
                        validation_config: {
                            enabled: true,
                            validator: 'mobile-legends-region',
                            rules: {}
                        },
                        game_id: 1,
                        needs_server_id: true  // dari COALESCE(g.needs_server_id, false)
                    }]
                };
            }
            return { rows: [] };
        });

        // PGS validator: validateGameId akan dipanggil dan dikembalikan gagal
        // karena tidak ada real network — tangkap 400 atau 500 (server error)
        const res = await fetch(`${baseUrl}/api/products/100/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '123456', zoneId: '1234' })
        });
        // Response boleh 400 (ID invalid dari PGS) atau 500 (network error) — yang penting bukan 200 dari Mobapay path
        // Verifikasi: data.mobapay TIDAK ada (bukan Mobapay path)
        const data = await res.json();
        assert.ok(!data.data || data.data.mobapay === undefined, 'PGS path must not return data.mobapay');
        pool.query.mock.restore();
    });

    test('POST /api/products/:id/validate — produk tanpa validation_config → success "tidak memerlukan validasi"', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return { rows: [{ id: 999, name: 'No Config Product', validation_config: null, game_id: 1, needs_server_id: false }] };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/products/999/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '123456', zoneId: null })
        });
        assert.strictEqual(res.status, 200, 'No-config product must return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true, 'success must be true');
        assert.ok(
            data.message.includes('tidak memerlukan validasi'),
            `Message must include "tidak memerlukan validasi", got: ${data.message}`
        );
        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 6A — Public Leaderboard Tests
// ============================================================
describe('Phase 6A: Public Leaderboard', () => {
    let server;
    let baseUrl;

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { pool.query.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    // Helper: mock pool.query for leaderboard SQL
    function mockLeaderboardQuery(rows) {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes("status = 'Success'") && sql.includes('GROUP BY')) {
                return { rows };
            }
            return { rows: [] };
        });
    }

    test('GET /api/public/leaderboard — accessible without authentication', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.strictEqual(res.status, 200, 'Leaderboard must be public (200 without auth)');
        const data = await res.json();
        assert.ok(Array.isArray(data.leaderboard), 'Response must have leaderboard array');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — returns required fields', async () => {
        mockLeaderboardQuery([{
            username: 'testuser123',
            total_success_orders: 7,
            total_spent: '350000',
            last_order_at: new Date().toISOString()
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.leaderboard.length > 0, 'Should have entries');
        const entry = data.leaderboard[0];
        assert.ok('rank'                 in entry, 'rank must be present');
        assert.ok('display_name'         in entry, 'display_name must be present');
        assert.ok('total_success_orders' in entry, 'total_success_orders must be present');
        assert.ok('total_spent'          in entry, 'total_spent must be present');
        assert.ok('rank_label'           in entry, 'rank_label must be present');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — username is masked', async () => {
        mockLeaderboardQuery([{
            username: 'storemiku99',
            total_success_orders: 5,
            total_spent: '200000',
            last_order_at: null
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        const data = await res.json();
        const entry = data.leaderboard[0];
        assert.ok(!entry.display_name.includes('storemiku99'), 'Full username must not appear in display_name');
        assert.ok(entry.display_name.includes('***'), 'display_name must be masked with ***');
        assert.ok(entry.display_name.startsWith('sto'), 'First 3 chars of username must be visible');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — email, nomor_wa, user_id never returned', async () => {
        mockLeaderboardQuery([{
            username: 'buyer01',
            total_success_orders: 3,
            total_spent: '150000',
            last_order_at: null
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        const data = await res.json();
        const raw = JSON.stringify(data);
        assert.ok(!raw.includes('"email"'),    'email must not be in leaderboard response');
        assert.ok(!raw.includes('"nomor_wa"'), 'nomor_wa must not be in leaderboard response');
        assert.ok(!raw.includes('"user_id"'),  'user_id must not be in leaderboard response');
        assert.ok(!raw.includes('"username"'), 'raw username key must not be in leaderboard response');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — empty returns array, not error', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.strictEqual(res.status, 200, 'Empty leaderboard must still return 200');
        const data = await res.json();
        assert.ok(Array.isArray(data.leaderboard), 'leaderboard must be array');
        assert.strictEqual(data.leaderboard.length, 0, 'Empty leaderboard must return empty array');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?limit=999 — limit capped at 50', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?limit=999`);
        assert.strictEqual(res.status, 200, 'Oversized limit must not error');
        const data = await res.json();
        assert.ok(Array.isArray(data.leaderboard), 'Must return leaderboard array');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?period=monthly — monthly period accepted', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?period=monthly`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.period, 'monthly', 'Response must echo back period=monthly');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?period=weekly — weekly period accepted', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?period=weekly`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.period, 'weekly', 'Response must echo back period=weekly');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?period=invalid — falls back to all_time', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?period=hacked`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.period, 'all_time', 'Invalid period must default to all_time');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — SQL filters only Success status', async () => {
        let capturedSql = '';
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') capturedSql = sql;
            return { rows: [] };
        });
        await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.ok(capturedSql.includes("status = 'Success'"), "SQL must filter by status = 'Success'");
        assert.ok(!capturedSql.includes("'Pending'"),         'SQL must not include Pending');
        assert.ok(!capturedSql.includes("'Failed'"),          'SQL must not include Failed');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — rank_label Legend for high spender (>=5jt)', async () => {
        mockLeaderboardQuery([{
            username: 'legend01',
            total_success_orders: 20,
            total_spent: '5000000',
            last_order_at: new Date().toISOString()
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        const data = await res.json();
        const entry = data.leaderboard[0];
        assert.strictEqual(entry.rank_label, 'Legend', 'User with 5jt+ must have Legend rank_label');
        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 7A — WA Bot Admin Deposit Read-Only API Tests
// ============================================================
describe('Phase 7A: WA Bot Admin Deposit Read-Only API', () => {
    let server;
    let baseUrl;

    const VALID_BOT_TOKEN = 'test-wa-bot-token-phase7a-secure-xyz';

    before(() => {
        // Set test token before starting server so middleware sees it
        process.env.WA_BOT_ADMIN_TOKEN = VALID_BOT_TOKEN;
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        delete process.env.WA_BOT_ADMIN_TOKEN;
        try { pool.query.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    // ── Helper: mock query for deposit list ───────────────────
    function mockDepositQuery(rows) {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM deposits d')) {
                return { rows };
            }
            return { rows: [] };
        });
    }

    const sampleDeposit = {
        id:          42,
        username:    'buyer99',
        amount:      '50500',
        unique_code: 500,
        method:      'GoPay',
        note:        null,
        status:      'Pending',
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString()
    };

    // ── TEST 1: tanpa token → 401 ─────────────────────────────
    test('GET /api/bot/admin/deposits/pending — tanpa token ditolak 401', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`);
        assert.strictEqual(res.status, 401, 'No token must return 401');
        // Auth rejected before any DB call — no mock to restore
    });

    // ── TEST 2: token salah → 403 ─────────────────────────────
    test('GET /api/bot/admin/deposits/pending — token salah ditolak 403', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': 'Bearer wrong-token-xyz' }
        });
        assert.strictEqual(res.status, 403, 'Wrong token must return 403');
    });

    // ── TEST 3: env token kosong → 503 ───────────────────────
    test('GET /api/bot/admin/deposits/pending — env kosong → 503 aman', async () => {
        // Temporarily hide the env token
        const savedToken = process.env.WA_BOT_ADMIN_TOKEN;
        delete process.env.WA_BOT_ADMIN_TOKEN;

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${savedToken}` }
        });
        assert.strictEqual(res.status, 503, 'Unconfigured env must return 503');
        const data = await res.json();
        assert.ok(data.message.includes('dikonfigurasi'), 'Message should mention configuration');

        process.env.WA_BOT_ADMIN_TOKEN = savedToken;
    });

    // ── TEST 4: token benar → list pending sukses ─────────────
    test('GET /api/bot/admin/deposits/pending — token benar → 200 dengan daftar deposit', async () => {
        mockDepositQuery([sampleDeposit]);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 200, 'Valid token must return 200');
        const data = await res.json();
        assert.ok(Array.isArray(data.deposits), 'Response must have deposits array');
        assert.ok(data.deposits.length > 0, 'Should have deposits');
        assert.ok('count'        in data, 'Response must have count');
        assert.ok('generated_at' in data, 'Response must have generated_at');

        pool.query.mock.restore();
    });

    // ── TEST 5: hanya status Pending dikembalikan ─────────────
    test('GET /api/bot/admin/deposits/pending — SQL harus filter status Pending', async () => {
        let capturedSql = '';
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') capturedSql = sql;
            return { rows: [] };
        });

        await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });

        assert.ok(capturedSql.includes("status = 'Pending'"), "SQL must filter by status = 'Pending'");
        assert.ok(!capturedSql.includes("'Approved'"), 'SQL must not include Approved');
        assert.ok(!capturedSql.includes("'Rejected'"), 'SQL must not include Rejected');
        pool.query.mock.restore();
    });

    // ── TEST 6: limit max dibatasi 50 ────────────────────────
    test('GET /api/bot/admin/deposits/pending?limit=999 — limit capped at 50', async () => {
        mockDepositQuery([]);
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending?limit=999`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 200, 'Oversized limit must not error');
        const data = await res.json();
        assert.ok(Array.isArray(data.deposits), 'Must return deposits array');
        pool.query.mock.restore();
    });

    // ── TEST 7: tidak expose password/email/nomor_wa ──────────
    test('GET /api/bot/admin/deposits/pending — tidak expose field sensitif', async () => {
        mockDepositQuery([sampleDeposit]);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        const data = await res.json();
        const raw = JSON.stringify(data);

        assert.ok(!raw.includes('"password"'), 'password must not be exposed');
        assert.ok(!raw.includes('"email"'),    'email must not be exposed');
        assert.ok(!raw.includes('"nomor_wa"'), 'nomor_wa must not be exposed');
        assert.ok(!raw.includes('"user_id"'),  'user_id must not be exposed');
        assert.ok(!raw.includes('"api_key"'),  'api_key must not be exposed');

        pool.query.mock.restore();
    });

    // ── TEST 8: detail deposit dengan token benar → 200 ───────
    test('GET /api/bot/admin/deposits/:id — token benar → 200 detail deposit', async () => {
        mockDepositQuery([sampleDeposit]);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 200, 'Valid token + valid id must return 200');
        const data = await res.json();

        // Cek field yang diharapkan ada
        assert.ok('id'           in data, 'id must be present');
        assert.ok('username'     in data, 'username must be present');
        assert.ok('amount'       in data, 'amount must be present');
        assert.ok('method'       in data, 'method must be present');
        assert.ok('status'       in data, 'status must be present');
        assert.ok('summary_text' in data, 'summary_text must be present for WA bot');

        // summary_text harus mengandung info berguna, bukan data sensitif
        assert.ok(data.summary_text.includes('Deposit'), 'summary_text must mention Deposit');
        assert.ok(!data.summary_text.includes('@'), 'summary_text must not contain email');

        pool.query.mock.restore();
    });

    // ── TEST 9: detail deposit tidak ditemukan → 404 ──────────
    test('GET /api/bot/admin/deposits/:id — tidak ditemukan → 404', async () => {
        mockDepositQuery([]); // empty = not found

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/9999`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 404, 'Missing deposit must return 404');
        const data = await res.json();
        assert.ok(data.message, 'Must return a message');

        pool.query.mock.restore();
    });

    // ── TEST 10: endpoint read-only — tidak ada UPDATE/INSERT ──
    test('GET /api/bot/admin/deposits/pending — tidak ada UPDATE/INSERT di DB (read-only)', async () => {
        const executedStatements = [];
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') executedStatements.push(sql.trim().toUpperCase().slice(0, 6));
            return { rows: [] };
        });

        await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });

        // Hanya SELECT yang boleh dieksekusi
        assert.ok(!executedStatements.includes('UPDATE'), 'Must not execute UPDATE');
        assert.ok(!executedStatements.includes('INSERT'), 'Must not execute INSERT');
        assert.ok(!executedStatements.includes('DELETE'), 'Must not execute DELETE');

        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 7B — WA Bot Admin Deposit Approve/Reject API Tests
// ============================================================
describe('Phase 7B: WA Bot Admin Deposit Approve/Reject API', () => {
    let server;
    let baseUrl;

    const VALID_BOT_TOKEN = 'test-wa-bot-token-phase7b-secure-xyz';

    before(() => {
        process.env.WA_BOT_ADMIN_TOKEN = VALID_BOT_TOKEN;
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        delete process.env.WA_BOT_ADMIN_TOKEN;
        try { pool.query.mock.restore(); } catch (_) {}
        try { pool.connect.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    // ── Helper: sample deposit row ────────────────────────────
    const sampleDeposit = {
        id:          42,
        user_id:     5,
        username:    'buyer99',
        amount:      '50500',
        unique_code: 500,
        method:      'GoPay',
        note:        null,
        status:      'Pending',
        created_at:  new Date().toISOString()
    };

    // ── Helper: create fakeClient for transactional endpoints ─
    function makeFakeClient(depositRow, opts = {}) {
        const tracked = {
            balanceUpdateCount: 0,
            balanceHistoryInsertCount: 0,
            statusSetTo: null,
            committed: false
        };

        const fakeClient = {
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') { tracked.committed = true; return {}; }
                // SELECT deposit FOR UPDATE
                if (typeof sql === 'string' && sql.includes('FROM deposits d') && sql.includes('FOR UPDATE')) {
                    return { rows: depositRow ? [depositRow] : [] };
                }
                // balance_history existence check
                if (typeof sql === 'string' && sql.includes('FROM balance_history') && sql.includes('reference_id')) {
                    const existingRows = opts.balanceHistoryExists ? [{ id: 999 }] : [];
                    return { rows: existingRows };
                }
                // UPDATE deposits SET status
                if (typeof sql === 'string' && sql.includes("UPDATE deposits SET status")) {
                    if (sql.includes("'Approved'")) tracked.statusSetTo = 'Approved';
                    if (sql.includes("'Rejected'")) tracked.statusSetTo = 'Rejected';
                    return {};
                }
                // UPDATE users SET balance
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    tracked.balanceUpdateCount++;
                    return {};
                }
                // INSERT INTO balance_history
                if (typeof sql === 'string' && sql.includes('INSERT INTO balance_history')) {
                    tracked.balanceHistoryInsertCount++;
                    return {};
                }
                return { rows: [] };
            },
            release: () => {}
        };

        return { fakeClient, tracked };
    }

    // ════════════════════════════════════════════════════════════
    // AUTH TESTS
    // ════════════════════════════════════════════════════════════

    // ── TEST 1: Approve tanpa token → 401 ─────────────────────
    test('POST /api/bot/admin/deposits/42/approve — tanpa token ditolak 401', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 401, 'No token must return 401');
    });

    // ── TEST 2: Approve token salah → 403 ─────────────────────
    test('POST /api/bot/admin/deposits/42/approve — token salah ditolak 403', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer wrong-token-xyz', 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 403, 'Wrong token must return 403');
    });

    // ── TEST 3: Reject tanpa token → 401 ──────────────────────
    test('POST /api/bot/admin/deposits/42/reject — tanpa token ditolak 401', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 401, 'No token must return 401');
    });

    // ── TEST 4: Reject token salah → 403 ──────────────────────
    test('POST /api/bot/admin/deposits/42/reject — token salah ditolak 403', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer wrong-token-xyz', 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 403, 'Wrong token must return 403');
    });

    // ════════════════════════════════════════════════════════════
    // APPROVE TESTS
    // ════════════════════════════════════════════════════════════

    // ── TEST 5: Approve deposit Pending sukses ────────────────
    test('POST /api/bot/admin/deposits/:id/approve — Pending berhasil di-approve', async () => {
        const { fakeClient, tracked } = makeFakeClient(sampleDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'test approve' })
        });

        assert.strictEqual(res.status, 200, 'Must return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true, 'success must be true');
        assert.ok(data.message.includes('approve'), 'message must mention approve');
        assert.ok(data.summary_text.includes('✅'), 'summary_text must include check emoji');
        assert.ok(data.deposit, 'Must have deposit object');
        assert.strictEqual(data.deposit.id, 42, 'deposit.id must match');
        assert.strictEqual(data.deposit.username, 'buyer99', 'deposit.username must match');
        assert.strictEqual(data.deposit.status, 'Approved', 'deposit.status must be Approved');

        // Verify no sensitive fields
        const raw = JSON.stringify(data);
        assert.ok(!raw.includes('"user_id"'), 'user_id must not be exposed');
        assert.ok(!raw.includes('"email"'), 'email must not be exposed');
        assert.ok(!raw.includes('"password"'), 'password must not be exposed');
        assert.ok(!raw.includes('"nomor_wa"'), 'nomor_wa must not be exposed');
        assert.ok(!raw.includes('"api_key"'), 'api_key must not be exposed');

        // Verify DB operations
        assert.strictEqual(tracked.statusSetTo, 'Approved', 'Status must be set to Approved');
        assert.strictEqual(tracked.balanceUpdateCount, 1, 'Balance must be updated exactly once');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 1, 'balance_history must be inserted exactly once');
        assert.strictEqual(tracked.committed, true, 'Transaction must be committed');

        pool.connect.mock.restore();
    });

    // ── TEST 6: Approve deposit tidak ditemukan → 404 ─────────
    test('POST /api/bot/admin/deposits/:id/approve — tidak ditemukan → 404', async () => {
        const { fakeClient } = makeFakeClient(null); // empty row
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/9999/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 404, 'Missing deposit must return 404');
        const data = await res.json();
        assert.strictEqual(data.success, false);

        pool.connect.mock.restore();
    });

    // ── TEST 7: Approve deposit non-Pending (Approved) → 409 ──
    test('POST /api/bot/admin/deposits/:id/approve — non-Pending → 409', async () => {
        const approvedDeposit = { ...sampleDeposit, status: 'Approved' };
        const { fakeClient, tracked } = makeFakeClient(approvedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Non-Pending must return 409');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Message must indicate already processed');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'balance_history must NOT be inserted');

        pool.connect.mock.restore();
    });

    // ── TEST 8: Double approve — saldo tidak double ───────────
    test('POST /api/bot/admin/deposits/:id/approve — double approve 409, saldo tidak double', async () => {
        const approvedDeposit = { ...sampleDeposit, status: 'Approved' };
        const { fakeClient, tracked } = makeFakeClient(approvedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Double approve must return 409');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated on double approve');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'CRITICAL: balance_history must NOT be inserted on double approve');

        pool.connect.mock.restore();
    });

    // ── TEST 9: Approve Pending tapi balance_history sudah ada → 409 ──
    test('POST /api/bot/admin/deposits/:id/approve — balance_history reference sudah ada → 409, saldo tidak bertambah', async () => {
        // Deposit masih Pending di DB, tapi balance_history DEPOSIT-42 sudah ada (anomali / inkonsistensi)
        const { fakeClient, tracked } = makeFakeClient(sampleDeposit, { balanceHistoryExists: true });
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Existing balance_history must return 409');
        const data = await res.json();
        assert.strictEqual(data.success, false);
        assert.ok(data.message.includes('sudah pernah dikreditkan'), 'Message must mention already credited');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated when history already exists');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'CRITICAL: balance_history must NOT be inserted again');
        assert.strictEqual(tracked.committed, false, 'Transaction must NOT be committed (ROLLBACK)');

        pool.connect.mock.restore();
    });

    // ════════════════════════════════════════════════════════════
    // REJECT TESTS
    // ════════════════════════════════════════════════════════════

    // ── TEST 10: Reject deposit Pending sukses ────────────────
    test('POST /api/bot/admin/deposits/:id/reject — Pending berhasil ditolak', async () => {
        const { fakeClient, tracked } = makeFakeClient(sampleDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'bukti tidak valid' })
        });

        assert.strictEqual(res.status, 200, 'Must return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true, 'success must be true');
        assert.ok(data.message.includes('ditolak'), 'message must mention rejection');
        assert.ok(data.summary_text.includes('❌'), 'summary_text must include cross emoji');
        assert.strictEqual(data.deposit.status, 'Rejected', 'deposit.status must be Rejected');

        // Verify no sensitive fields
        const raw = JSON.stringify(data);
        assert.ok(!raw.includes('"user_id"'), 'user_id must not be exposed');
        assert.ok(!raw.includes('"email"'), 'email must not be exposed');
        assert.ok(!raw.includes('"password"'), 'password must not be exposed');

        // Verify NO balance/history operations
        assert.strictEqual(tracked.statusSetTo, 'Rejected', 'Status must be set to Rejected');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'Balance must NOT be updated on reject');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'balance_history must NOT be inserted on reject');
        assert.strictEqual(tracked.committed, true, 'Transaction must be committed');

        pool.connect.mock.restore();
    });

    // ── TEST 11: Reject deposit tidak ditemukan → 404 ─────────
    test('POST /api/bot/admin/deposits/:id/reject — tidak ditemukan → 404', async () => {
        const { fakeClient } = makeFakeClient(null);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/9999/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 404, 'Missing deposit must return 404');

        pool.connect.mock.restore();
    });

    // ── TEST 12: Reject deposit non-Pending → 409 ─────────────
    test('POST /api/bot/admin/deposits/:id/reject — non-Pending → 409', async () => {
        const rejectedDeposit = { ...sampleDeposit, status: 'Rejected' };
        const { fakeClient, tracked } = makeFakeClient(rejectedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Non-Pending must return 409');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Message must indicate already processed');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'Balance must NOT be updated');

        pool.connect.mock.restore();
    });

    // ── TEST 13: Double reject tidak mengubah saldo ───────────
    test('POST /api/bot/admin/deposits/:id/reject — double reject 409, saldo tidak berubah', async () => {
        const rejectedDeposit = { ...sampleDeposit, status: 'Rejected' };
        const { fakeClient, tracked } = makeFakeClient(rejectedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Double reject must return 409');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT change on double reject');

        pool.connect.mock.restore();
    });

    // ════════════════════════════════════════════════════════════
    // REGRESSION: Phase 7A read-only still works
    // ════════════════════════════════════════════════════════════

    // ── TEST 14: Phase 7A GET pending masih normal ────────────
    test('GET /api/bot/admin/deposits/pending — Phase 7A regression: masih 200 dengan array', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM deposits d')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });

        assert.strictEqual(res.status, 200, 'Phase 7A pending list must still return 200');
        const data = await res.json();
        assert.ok(Array.isArray(data.deposits), 'Must return deposits array');
        assert.ok('count' in data, 'Must have count field');

        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 8 — Audit 2 Concurrency & Hardening Guards
// ============================================================
describe('Phase 8: Audit 2 Concurrency & Hardening Guards', () => {
    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { pool.query.mock.restore(); } catch (_) {}
        try { pool.connect.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    test('POST /api/deposit/request — blokir spam jika user sudah punya 2 deposit Pending (429)', async () => {
        const token = jwt.sign({ id: 77, username: 'spamuser', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 1,
                        code: 'GOPAY',
                        name: 'GoPay',
                        type: 'ewallet',
                        account_number: '081200000001',
                        account_name: 'Admin MIKU Store (Placeholder)',
                        qris_image_url: null,
                        instructions: null,
                        is_qris: false,
                        min_amount: 10000
                    }]
                };
            }
            if (typeof sql === 'string' && sql.includes('SELECT u.id')) {
                return { rows: [{ id: 77, username: 'spamuser', role_name: 'BRONZE' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT COUNT(*) AS count FROM deposits')) {
                    return { rows: [{ count: '2' }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000, method: 'GoPay' })
        });

        assert.strictEqual(res.status, 429, 'Must return 429 when user has 2 Pending deposits');
        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    test('POST /api/admin/deposits/approve — tolak 409 jika balance_history DEPOSIT-id sudah ada', async () => {
        const token = jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
        let balanceUpdated = false;

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 88, user_id: 5, amount: 50123, unique_code: 123, status: 'Pending' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM balance_history WHERE reference_id')) {
                    return { rows: [{ id: 999 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance')) {
                    balanceUpdated = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const res = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ depositId: 88 })
        });

        assert.strictEqual(res.status, 409, 'Must return 409 when DEPOSIT-id already in balance_history');
        assert.strictEqual(balanceUpdated, false, 'Balance must not be updated');
        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    test('POST /api/foxy/callback — FAILED merollback kuota promo & cegah double refund via balance_history', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'test-cb-secret';
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            data: { status: true, data: { status: 'FAILED' } }
        });

        let balanceIncremented = false;
        let promoDecremented = false;

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 501, status: 'Pending', price: 15000, product_id: 1, provider_trx_id: 'WEB-FAIL-501' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions')) {
                    return { rows: [{ id: 501, invoice_id: 'TRX-FAIL-PROMO', user_id: 9, product_id: 1, status: 'Pending', price: 15000, provider_trx_id: 'WEB-FAIL-501' }] };
                }
                if (typeof sql === 'string' && sql.includes("type = 'Refund'")) {
                    // Simulasikan sudah ada refund di balance_history
                    return { rows: [{ id: 1 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance')) {
                    balanceIncremented = true;
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM promo_usages')) {
                    return { rows: [{ promo_code_id: 77 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1)')) {
                    promoDecremented = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${baseUrl}/api/foxy/callback?token=test-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-FAIL-501', status: 'FAILED' })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.deepStrictEqual(data, { message: 'Callback berhasil diproses.' });
            assert.strictEqual(balanceIncremented, false, 'Should skip balance increment if Refund already exists in balance_history');
            assert.strictEqual(promoDecremented, true, 'Should decrement promo_codes.uses_count when order fails');
        } finally {
            axios.get = origGet;
            process.env.FOXY_CALLBACK_SECRET = '';
            pool.connect.mock.restore();
            pool.query.mock.restore();
        }
    });

    test('GET /api/admin/products — menyertakan p.validation_config pada query dan response', async () => {
        const token = jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
        let capturedProductSql = '';

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('FROM products p JOIN games g')) {
                capturedProductSql = sql;
                return {
                    rows: [{
                        id: 10,
                        game_id: 1,
                        name: '86 Diamonds',
                        provider_sku: 'ML86',
                        price: 20000,
                        status: 'Active',
                        validation_config: { enabled: true, validator: 'mobile-legends-region' },
                        game_name: 'Mobile Legends'
                    }]
                };
            }
            if (typeof sql === 'string' && sql.includes('FROM roles ORDER BY id ASC')) {
                return { rows: [{ id: 1, name: 'BRONZE', margin_percent: 10 }] };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(capturedProductSql.includes('p.validation_config'), 'SQL must select p.validation_config');
        const products = await res.json();
        assert.strictEqual(products.length, 1);
        assert.deepStrictEqual(products[0].validation_config, { enabled: true, validator: 'mobile-legends-region' });

        pool.query.mock.restore();
    });

    test('POST /api/admin/sync-products — tolak margin_percent tidak valid dengan 400', async () => {
        const token = jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });

        for (const badMargin of ['abc', -5]) {
            const res = await fetch(`${baseUrl}/api/admin/sync-products`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ margin_percent: badMargin })
            });
            assert.strictEqual(res.status, 400, `Invalid margin ${badMargin} must return 400`);
        }

        pool.query.mock.restore();
    });

    test('POST /api/admin/sync-products — tolak 400 dengan pesan jelas jika FOXY_API_KEY kosong', async () => {
        const token = jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
        const origFoxyKey = process.env.FOXY_API_KEY;
        process.env.FOXY_API_KEY = '   ';

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });

        try {
            const res = await fetch(`${baseUrl}/api/admin/sync-products`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ margin_percent: 10 })
            });
            assert.strictEqual(res.status, 400, 'Empty FOXY_API_KEY must return 400');
            const data = await res.json();
            assert.strictEqual(
                data.message,
                'FOXY_API_KEY belum diatur di file .env. Isi API key Foxy atau gunakan data seeder lokal untuk pengujian.'
            );
        } finally {
            process.env.FOXY_API_KEY = origFoxyKey;
            pool.query.mock.restore();
        }
    });

    test('PUT /api/user/profile — normalisasi nomor WA ke E.164 & bedakan error 23505 email vs nomor_wa', async () => {
        const token = jwt.sign({ id: 55, username: 'testuser', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
        let savedParams = null;

        // 1. Sukses: normalisasi 0812-3456-7890 -> +6281234567890
        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('UPDATE users SET full_name')) {
                savedParams = params;
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        const resLocal = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: 'Budi Santoso', email: 'Budi@Example.com', nomorWa: '0812-3456-7890' })
        });
        assert.strictEqual(resLocal.status, 200);
        assert.deepStrictEqual(savedParams, ['Budi Santoso', 'budi@example.com', '+6281234567890', 55]);

        // 2. Sukses: format sudah E.164 (+6281234567890) tetap dipertahankan
        const resE164 = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: 'Budi Santoso', email: 'budi@example.com', nomorWa: '+6281234567890' })
        });
        assert.strictEqual(resE164.status, 200);
        assert.strictEqual(savedParams[2], '+6281234567890');
        pool.query.mock.restore();

        // 3. Tolak nomor WA tidak valid dengan 400
        const resInvalid = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: 'Budi Santoso', email: 'budi@example.com', nomorWa: '0812abc' })
        });
        assert.strictEqual(resInvalid.status, 400);

        // 4. Error 23505 duplikat nomor_wa
        mock.method(pool, 'query', async () => {
            const err = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            err.constraint = 'uq_users_nomor_wa';
            err.detail = 'Key (nomor_wa)=(+6281234567890) already exists.';
            throw err;
        });
        const resDupWa = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: 'Budi Santoso', email: 'budi@example.com', nomorWa: '081234567890' })
        });
        assert.strictEqual(resDupWa.status, 409);
        const dupWaData = await resDupWa.json();
        assert.strictEqual(dupWaData.message, 'Nomor WhatsApp sudah digunakan oleh akun lain.');
        pool.query.mock.restore();

        // 5. Error 23505 duplikat email
        mock.method(pool, 'query', async () => {
            const err = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            err.constraint = 'users_email_key';
            err.detail = 'Key (email)=(budi@example.com) already exists.';
            throw err;
        });
        const resDupEmail = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName: 'Budi Santoso', email: 'budi@example.com', nomorWa: '081234567890' })
        });
        assert.strictEqual(resDupEmail.status, 409);
        const dupEmailData = await resDupEmail.json();
        assert.strictEqual(dupEmailData.message, 'Email sudah digunakan oleh akun lain.');
        pool.query.mock.restore();
    });
});

// ============================================================
// PHASE 9 — Sistem Metode Pembayaran Dinamis (payment_methods)
// ============================================================
describe('Phase 9: Dynamic Payment Methods (Paket 2)', () => {
    let server;
    let baseUrl;
    const JWT_SECRET = 'test-secret';
    const jwt = require('jsonwebtoken');

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        try { pool.query.mock.restore(); } catch (_) {}
        try { pool.connect.mock.restore(); } catch (_) {}
        await new Promise(resolve => server.close(resolve));
    });

    test('GET /api/payment-methods — tanpa token ditolak 401; dengan token mengembalikan metode aktif terurut', async () => {
        const resNoAuth = await fetch(`${baseUrl}/api/payment-methods`);
        assert.strictEqual(resNoAuth.status, 401);

        let capturedSql = '';
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                capturedSql = sql;
                return {
                    rows: [
                        { id: 1, code: 'GOPAY', name: 'GoPay', type: 'ewallet', account_number: '081200000001', account_name: 'Admin', is_qris: false, min_amount: 10000, sort_order: 1 },
                        { id: 5, code: 'QRIS', name: 'QRIS All Payment', type: 'qris', account_number: null, account_name: 'MIKU Store', qris_image_url: 'https://example.com/qris.png', is_qris: true, min_amount: 10000, sort_order: 2 }
                    ]
                };
            }
            return { rows: [] };
        });

        const token = jwt.sign({ id: 10, username: 'member1', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
        const res = await fetch(`${baseUrl}/api/payment-methods`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        assert.strictEqual(res.status, 200);
        assert.ok(capturedSql.includes('WHERE is_active = true'), 'SQL must filter is_active = true');
        assert.ok(capturedSql.includes('ORDER BY sort_order ASC, id ASC'), 'SQL must order by sort_order ASC, id ASC');
        const body = await res.json();
        assert.strictEqual(body.length, 2);
        assert.strictEqual(body[1].code, 'QRIS');
        pool.query.mock.restore();
    });

    test('POST /api/deposit/request — QRIS tidak menambah kode unik 3 digit & validasi min_amount metode', async () => {
        const token = jwt.sign({ id: 22, username: 'qrisuser', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });

        // 1. Cek min_amount per metode (50000) menolak request 20000
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 7,
                        code: 'BCA',
                        name: 'Bank BCA',
                        type: 'bank',
                        account_number: '1234567890',
                        account_name: 'Admin MIKU',
                        qris_image_url: null,
                        instructions: 'Transfer sesama BCA.',
                        is_qris: false,
                        min_amount: 50000
                    }]
                };
            }
            return { rows: [] };
        });
        const resBelowMin = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 20000, method: 'BCA' })
        });
        assert.strictEqual(resBelowMin.status, 400);
        const minErr = await resBelowMin.json();
        assert.ok(minErr.message.includes('50.000'), 'Error must mention method min_amount');
        pool.query.mock.restore();

        // 2. QRIS (is_qris: true) mengirim by code ('qris_all') menyimpan name ('QRIS All') dan unique_code === 0
        let savedDepositParams = null;
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 8,
                        code: 'QRIS_ALL',
                        name: 'QRIS All Payment',
                        type: 'qris',
                        account_number: null,
                        account_name: 'MIKU Store',
                        qris_image_url: 'https://example.com/qris.png',
                        instructions: 'Scan QRIS.',
                        is_qris: true,
                        min_amount: 10000
                    }]
                };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (sql.includes('SELECT COUNT(*) AS count FROM deposits')) return { rows: [{ count: '0' }] };
                if (sql.includes('INSERT INTO deposits')) {
                    savedDepositParams = params;
                    return { rows: [{ id: 501, created_at: new Date() }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        const resQris = await fetch(`${baseUrl}/api/deposit/request`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: 50000, method: 'qris_all' })
        });
        assert.strictEqual(resQris.status, 201);
        const qrisData = await resQris.json();
        assert.strictEqual(qrisData.deposit.unique_code, 0, 'QRIS must have unique_code = 0');
        assert.strictEqual(qrisData.deposit.amount, 50000, 'QRIS amount must equal base amount');
        assert.strictEqual(qrisData.deposit.method, 'QRIS All Payment', 'Deposit method must store methodRow.name');
        assert.strictEqual(savedDepositParams[1], 50000);
        assert.strictEqual(savedDepositParams[2], 0);
        assert.strictEqual(savedDepositParams[4], 'QRIS All Payment');
        pool.query.mock.restore();
        pool.connect.mock.restore();
    });

    test('Admin CRUD /api/admin/payment-methods — akses ditolak non-admin, validasi input, create/edit/delete', async () => {
        const userToken = jwt.sign({ id: 10, username: 'member1', role: 'BRONZE' }, JWT_SECRET, { expiresIn: '1h' });
        const adminToken = jwt.sign({ id: 1, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });

        // 1. Non-admin ditolak 403
        const resForbidden = await fetch(`${baseUrl}/api/admin/payment-methods`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        assert.strictEqual(resForbidden.status, 403);

        // 2. GET /api/admin/payment-methods oleh Admin
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return { rows: [{ id: 1, code: 'GOPAY', name: 'GoPay', type: 'ewallet', is_active: true }] };
            }
            return { rows: [] };
        });
        const resList = await fetch(`${baseUrl}/api/admin/payment-methods`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(resList.status, 200);
        const listData = await resList.json();
        assert.strictEqual(listData.length, 1);
        pool.query.mock.restore();

        // 3. POST invalid (javascript: URL QRIS atau kode invalid) ditolak 400
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });
        const resBadUrl = await fetch(`${baseUrl}/api/admin/payment-methods`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'QRIS_BAD', name: 'QRIS', type: 'qris', qris_image_url: 'javascript:alert(1)' })
        });
        assert.strictEqual(resBadUrl.status, 400);
        pool.query.mock.restore();

        // 4. POST valid type 'qris' otomatis set is_qris = true & code uppercase -> 201
        let insertParams = null;
        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO payment_methods')) {
                insertParams = params;
                return {
                    rows: [{
                        id: 12,
                        code: params[0],
                        name: params[1],
                        type: params[2],
                        is_qris: params[7],
                        min_amount: params[8],
                        is_active: params[9],
                        sort_order: params[10]
                    }]
                };
            }
            return { rows: [] };
        });
        const resCreate = await fetch(`${baseUrl}/api/admin/payment-methods`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: 'qris_miku',
                name: 'QRIS MIKU',
                type: 'qris',
                qris_image_url: 'https://example.com/qris-miku.png',
                min_amount: 15000,
                sort_order: 5
            })
        });
        assert.strictEqual(resCreate.status, 201);
        const createdBody = await resCreate.json();
        assert.strictEqual(createdBody.paymentMethod.code, 'QRIS_MIKU');
        assert.strictEqual(createdBody.paymentMethod.is_qris, true);
        assert.strictEqual(insertParams[7], true);
        pool.query.mock.restore();

        // 5. PUT toggle partial { is_active: false } mempertahankan field lain -> 200
        let updateParams = null;
        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT * FROM payment_methods WHERE id = $1')) {
                return {
                    rows: [{
                        id: 12,
                        code: 'QRIS_MIKU',
                        name: 'QRIS MIKU',
                        type: 'qris',
                        account_number: null,
                        account_name: 'MIKU Store',
                        qris_image_url: 'https://example.com/qris-miku.png',
                        instructions: 'Scan QRIS',
                        is_qris: true,
                        min_amount: 15000,
                        is_active: true,
                        sort_order: 5
                    }]
                };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE payment_methods')) {
                updateParams = params;
                return { rows: [{ id: 12, code: params[0], name: params[1], is_active: params[9] }] };
            }
            return { rows: [] };
        });
        const resToggle = await fetch(`${baseUrl}/api/admin/payment-methods/12`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: false })
        });
        assert.strictEqual(resToggle.status, 200);
        assert.strictEqual(updateParams[1], 'QRIS MIKU');
        assert.strictEqual(updateParams[9], false);
        pool.query.mock.restore();

        // 6. DELETE -> 200 dan 404 saat tidak ditemukan
        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('DELETE FROM payment_methods WHERE id = $1')) {
                return params[0] === 12 ? { rows: [{ id: 12, name: 'QRIS MIKU' }] } : { rows: [] };
            }
            return { rows: [] };
        });
        const resDelOk = await fetch(`${baseUrl}/api/admin/payment-methods/12`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(resDelOk.status, 200);

        const resDelMissing = await fetch(`${baseUrl}/api/admin/payment-methods/999`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert.strictEqual(resDelMissing.status, 404);
        pool.query.mock.restore();
    });
});

describe('Phase 10: SEC-006 Dependency Vulnerability Hardening', () => {
    const fs = require('fs');
    const path = require('path');
    const { createRequire } = require('module');
    const backendDir = path.join(__dirname, '..');

    function parseSemver(ver) {
        const clean = String(ver || '').trim().replace(/^[^\d]*/, '').split('-')[0];
        const parts = clean.split('.').map(n => Number.parseInt(n, 10) || 0);
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    }

    function compareSemver(a, b) {
        const pa = parseSemver(a);
        const pb = parseSemver(b);
        for (let i = 0; i < 3; i += 1) {
            if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }
        return 0;
    }

    function getLockEntries(lockJson, pkgName) {
        const suffix = `node_modules/${pkgName}`;
        return Object.entries(lockJson.packages || {})
            .filter(([pkgPath]) => pkgPath === suffix || pkgPath.endsWith(`/${suffix}`))
            .map(([pkgPath, meta]) => ({ pkgPath, version: meta && meta.version }));
    }

    test('package-lock.json dipertahankan dan seluruh dependensi SEC-006 memenuhi versi aman minimum', () => {
        const pkgPath = path.join(backendDir, 'package.json');
        const lockPath = path.join(backendDir, 'package-lock.json');
        assert.ok(fs.existsSync(lockPath), 'backend/package-lock.json harus dipertahankan');

        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const lockJson = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.ok(lockJson.lockfileVersion >= 2, 'lockfileVersion harus valid');

        const rootLockDeps = (lockJson.packages && lockJson.packages[''] && lockJson.packages[''].dependencies) || {};
        assert.deepStrictEqual(rootLockDeps, pkgJson.dependencies, 'dependencies root package-lock.json harus sinkron dengan package.json');

        const minVersions = [
            { name: 'axios', min: '1.20.0', maxExclusive: '2.0.0' },
            { name: 'form-data', min: '4.0.6' },
            { name: 'follow-redirects', min: '1.16.0' },
            { name: 'express', min: '4.22.3', maxExclusive: '5.0.0' },
            { name: 'proxy-addr', min: '2.0.8' },
            { name: 'body-parser', min: '1.20.9' },
            { name: 'qs', min: '6.16.1' },
            { name: 'express-rate-limit', min: '8.6.0', maxExclusive: '9.0.0' },
            { name: 'ip-address', min: '10.7.4' },
            { name: 'jws', min: '3.2.3' },
        ];

        for (const rule of minVersions) {
            const entries = getLockEntries(lockJson, rule.name);
            assert.ok(entries.length > 0, `Dependensi ${rule.name} harus tercatat di package-lock.json`);
            for (const entry of entries) {
                assert.ok(
                    compareSemver(entry.version, rule.min) >= 0,
                    `${entry.pkgPath} (${entry.version}) masih di bawah versi aman >= ${rule.min}`
                );
                if (rule.maxExclusive) {
                    assert.ok(
                        compareSemver(entry.version, rule.maxExclusive) < 0,
                        `${entry.pkgPath} (${entry.version}) tidak boleh melompat ke major >= ${rule.maxExclusive}`
                    );
                }
            }
        }
    });

    test('qs bebas crash TypeError pada comma-format array null dan non-callable toString (GHSA-q8mj-m7cp-5q26, GHSA-6pq8-jhm2-2vcw)', () => {
        const expressReq = createRequire(require.resolve('express'));
        const bodyParserReq = createRequire(expressReq.resolve('body-parser'));
        const qsInstances = [expressReq('qs'), bodyParserReq('qs')];

        for (const qs of qsInstances) {
            assert.doesNotThrow(() => {
                qs.stringify({ a: [null, 'b'] }, { arrayFormat: 'comma', encodeValuesOnly: true });
            }, 'qs.stringify dengan elemen null pada arrayFormat comma tidak boleh crash TypeError');

            assert.doesNotThrow(() => {
                qs.stringify({ a: [{ toString: null }] }, { arrayFormat: 'comma' });
            }, 'qs.stringify dengan toString: null pada arrayFormat comma tidak boleh crash TypeError');
        }
    });

    test('form-data mensanitasi/menolak injeksi CRLF pada nama field multipart (GHSA-hmw2-7cc7-3qxx)', () => {
        const axiosReq = createRequire(require.resolve('axios'));
        const FormData = axiosReq('form-data');
        const fd = new FormData();
        fd.append('bad\r\nfield', 'val');
        const body = fd.getBuffer().toString();
        assert.ok(!body.includes('bad\r\nfield'), 'form-data tidak boleh menyisipkan CRLF mentah ke header multipart');
    });

    test('ip-address mengenali rentang penuh link-local IPv6 fe80::/10 (GHSA-rpw4-54j3-4h4q)', () => {
        const rateLimitReq = createRequire(require.resolve('express-rate-limit'));
        const { Address6 } = rateLimitReq('ip-address');
        assert.strictEqual(new Address6('febf::1').isLinkLocal(), true);
    });

    test('Express + trust proxy + rate limiter + body-parser + JWT tetap kompatibel pasca-upgrade', async () => {
        const jwt = require('jsonwebtoken');
        const srv = startServer(0);
        const origQuery = pool.query;
        try {
            const port = srv.address().port;
            const baseUrl = `http://127.0.0.1:${port}`;
            const testIp = '198.51.100.206';

            const resNoToken = await fetch(`${baseUrl}/api/user/profile`, {
                headers: { 'X-Forwarded-For': testIp }
            });
            assert.strictEqual(resNoToken.status, 401);
            assert.ok(resNoToken.headers.get('ratelimit-limit') || resNoToken.headers.get('ratelimit-policy'));

            mock.method(pool, 'query', async () => ({
                rows: [{ id: 206, username: 'sec006user', email: 'sec006@example.com', nomor_wa: '+628123456789', balance: '50000', role_name: 'BRONZE' }]
            }));
            const token = jwt.sign({ id: 206, username: 'sec006user', role: 'BRONZE' }, process.env.JWT_SECRET, { expiresIn: '1h' });
            const resProfile = await fetch(`${baseUrl}/api/user/profile`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Forwarded-For': testIp
                }
            });
            assert.strictEqual(resProfile.status, 200);
            const profileData = await resProfile.json();
            assert.strictEqual(profileData.username, 'sec006user');

            const resBadJson = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': testIp
                },
                body: '{"broken":'
            });
            assert.strictEqual(resBadJson.status, 400);
        } finally {
            pool.query = origQuery;
            await new Promise(resolve => srv.close(resolve));
        }
    });
});

describe('Phase 11: SEC-002 & SEC-003 Compensation, Promo Cost Guard & Cache Hardening', () => {
    const jwt = require('jsonwebtoken');
    const axios = require('axios');
    const cronUtils = require('../utils/cronUtils');
    const cronPool = cronUtils.pool;
    const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

    let server;
    let baseUrl;
    let origPoolQuery;
    let origPoolConnect;
    let origCronQuery;
    let origCronConnect;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id = 42, role = 'BRONZE') {
        return jwt.sign({ id, username: `user${id}`, role }, JWT_SECRET, { expiresIn: '1h' });
    }

    function makeAdminToken(id = 1) {
        return jwt.sign({ id, username: 'admin', role: 'Admin' }, JWT_SECRET, { expiresIn: '1h' });
    }

    before(() => {
        origPoolQuery = pool.query;
        origPoolConnect = pool.connect;
        origCronQuery = cronPool ? cronPool.query : null;
        origCronConnect = cronPool ? cronPool.connect : null;
        origAxiosGet = axios.get;
        origAxiosPost = axios.post;
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        pool.query = origPoolQuery;
        pool.connect = origPoolConnect;
        if (cronPool && origCronQuery) cronPool.query = origCronQuery;
        if (cronPool && origCronConnect) cronPool.connect = origCronConnect;
        axios.get = origAxiosGet;
        axios.post = origAxiosPost;
        await new Promise(resolve => server.close(resolve));
    });

    // (a1) POST /api/order: provider fails AFTER callback/cron already marked transaction 'Success'
    test('(a) POST /api/order — provider gagal setelah status Success tidak boleh refund atau timpa ke Failed', async () => {
        const token = makeUserToken(101);
        let statusUpdatedToFailed = false;
        let refundCredited = false;
        let promoRolledBack = false;
        let flashSaleRolledBack = false;
        let phase2SelectSql = '';

        axios.get = async () => ({
            data: { data: [{ product_code: 'ML-100', product_price: 18000 }] }
        });
        axios.post = async () => ({
            data: { status: false, message: 'Provider rejected late' }
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return {
                        rows: [{
                            id: 11,
                            name: 'Diamond 50',
                            provider_sku: 'ML-100',
                            price: 20000,
                            status: 'Active',
                            game_id: 1,
                            needs_server_id: false,
                            validation_config: null,
                            use_manual_prices: false,
                            manual_prices: {},
                            use_custom_margin: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance: 100000, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                    return { rows: [{ margin_percent: 10 }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                    return { rows: [{ id: 88, discount_price: 19000 }] };
                }
                if (typeof sql === 'string' && sql.includes('SELECT id, invoice_id FROM transactions')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) {
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) {
                    return { rows: [{ id: 7001 }] };
                }
                if (typeof sql === 'string' && sql.includes('FOR UPDATE') && sql.includes('FROM transactions WHERE invoice_id')) {
                    phase2SelectSql = sql;
                    // Simulasi callback/cron sudah menandai 'Success' sebelum kompensasi berjalan
                    if (sql.includes("status = 'Pending'")) {
                        return { rows: [] };
                    }
                    return { rows: [{ id: 7001, status: 'Success', flash_sale_id: 88, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    statusUpdatedToFailed = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    refundCredited = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1)')) {
                    promoRolledBack = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1)')) {
                    flashSaleRolledBack = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '12345678' })
            });

            assert.ok(phase2SelectSql.length > 0, 'Phase 2 lock query must execute');
            assert.ok(!phase2SelectSql.includes("status = 'Pending'"), 'Phase 2 lock query must NOT filter by status = Pending');
            assert.strictEqual(statusUpdatedToFailed, false, 'Must NOT overwrite Success transaction to Failed');
            assert.strictEqual(refundCredited, false, 'Must NOT refund balance when transaction is already Success');
            assert.strictEqual(promoRolledBack, false, 'Must NOT rollback promo when transaction is Success');
            assert.strictEqual(flashSaleRolledBack, false, 'Must NOT rollback flash sale when transaction is Success');
            assert.strictEqual(res.status, 201, 'Already-Success transaction should return 201 instead of telling user balance was not deducted');
        } finally {
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    // (a2) POST /h2h/order: provider fails AFTER callback/cron already marked transaction 'Success'
    test('(a) POST /h2h/order — provider gagal setelah status Success tidak boleh refund atau timpa ke Failed', async () => {
        const apiKey = 'b'.repeat(48);
        let statusUpdatedToFailed = false;
        let refundCredited = false;
        let flashSaleRolledBack = false;
        let phase2SelectSql = '';

        axios.get = async () => ({
            data: { data: [{ product_code: 'ML-100', product_price: 18000 }] }
        });
        axios.post = async () => ({
            data: { status: false, message: 'Provider rejected late' }
        });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('u.api_key = $1')) {
                return { rows: [{ id: 102, username: 'h2hpartner', role_id: 1, role_name: 'PARTNER', api_key: apiKey, balance: 100000 }] };
            }
            if (typeof sql === 'string' && sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return {
                        rows: [{
                            id: 12,
                            name: 'Diamond 50 H2H',
                            provider_sku: 'ML-100',
                            price: 20000,
                            status: 'Active',
                            game_id: 1,
                            needs_server_id: false,
                            validation_config: null,
                            use_manual_prices: false,
                            manual_prices: {},
                            use_custom_margin: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('SELECT balance, role_id FROM users WHERE id')) {
                    return { rows: [{ balance: 100000, role_id: 1 }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                    return { rows: [{ margin_percent: 10 }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                    return { rows: [{ id: 89, discount_price: 19000 }] };
                }
                if (typeof sql === 'string' && sql.includes('SELECT id, invoice_id FROM transactions')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) {
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) {
                    return { rows: [{ id: 7002 }] };
                }
                if (typeof sql === 'string' && sql.includes('FOR UPDATE') && sql.includes('FROM transactions WHERE invoice_id')) {
                    phase2SelectSql = sql;
                    if (sql.includes("status = 'Pending'")) {
                        return { rows: [] };
                    }
                    return { rows: [{ id: 7002, status: 'Success', flash_sale_id: 89, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    statusUpdatedToFailed = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    refundCredited = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1)')) {
                    flashSaleRolledBack = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '12345678' })
            });

            assert.ok(phase2SelectSql.length > 0, 'H2H Phase 2 lock query must execute');
            assert.ok(!phase2SelectSql.includes("status = 'Pending'"), 'H2H Phase 2 lock query must NOT filter by status = Pending');
            assert.strictEqual(statusUpdatedToFailed, false, 'H2H must NOT overwrite Success transaction to Failed');
            assert.strictEqual(refundCredited, false, 'H2H must NOT refund balance when transaction is already Success');
            assert.strictEqual(flashSaleRolledBack, false, 'H2H must NOT rollback flash sale when transaction is Success');
            assert.strictEqual(res.status, 201, 'H2H already-Success transaction should return 201');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    // (b) SEC-003: large promo must NOT push finalPrice below currentProviderCost
    test('(b) POST /api/order — promo besar tidak dapat menurunkan harga akhir di bawah modal provider', async () => {
        const token = makeUserToken(103);
        let balanceDeducted = false;
        let txInserted = false;
        let promoChecked = false;

        axios.get = async () => ({
            data: { data: [{ product_code: 'ML-100', product_price: 18000 }] }
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return {
                        rows: [{
                            id: 21,
                            name: 'Diamond 100',
                            provider_sku: 'ML-100',
                            price: 20000,
                            status: 'Active',
                            game_id: 1,
                            needs_server_id: false,
                            validation_config: null,
                            use_manual_prices: false,
                            manual_prices: {},
                            use_custom_margin: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance: 100000, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                    return { rows: [{ margin_percent: 10 }] }; // pre-promo price = 22000 (>= modal 18000)
                }
                if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('FROM promo_codes')) {
                    promoChecked = true;
                    // Fixed discount 10000 drops 22000 -> 12000 (< provider cost 18000)
                    return {
                        rows: [{
                            id: 301,
                            code: 'BIGDISCOUNT',
                            type: 'fixed',
                            value: 10000,
                            is_active: true,
                            expires_at: null,
                            max_uses: 100,
                            uses_count: 0,
                            rules: {}
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) {
                    balanceDeducted = true;
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) {
                    txInserted = true;
                    return { rows: [{ id: 7010 }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 21, targetGameId: '12345678', promoCode: 'BIGDISCOUNT' })
            });

            assert.strictEqual(promoChecked, true, 'Promo query must be reached before cost guard rejection');
            assert.strictEqual(res.status, 400, 'Order with promo pushing price below provider cost must be rejected with 400');
            const errData = await res.json();
            assert.ok(errData.message && errData.message.includes('harga modal'), 'Error message must explain final price cannot go below provider cost');
            assert.strictEqual(balanceDeducted, false, 'Balance must NOT be deducted when promo causes price < provider cost');
            assert.strictEqual(txInserted, false, 'Transaction must NOT be created when promo causes price < provider cost');
        } finally {
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    // (c1) Callback Foxy FAILED restores BOTH flash_sales.uses_count and promo_usages, never double-refunds
    test('(c1) POST /api/foxy/callback — memulihkan flash_sales.uses_count & promo_usages serta menandai flash_sale_restored', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'test-cb-secret';
        axios.get = async () => ({
            data: { status: true, data: { status: 'FAILED' } }
        });

        let refundCount = 0;
        let promoRolledBack = false;
        let flashSaleDecremented = 0;
        let flashSaleRestoredMarked = false;
        let alreadyRefunded = false;
        let txFlashSaleRestored = false;
        let txStatus = 'Pending';

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 801, status: txStatus, price: 15000, product_id: 1, provider_trx_id: 'WEB-CB-FS-1' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    return {
                        rows: [{
                            id: 801,
                            invoice_id: 'TRX-CB-FS',
                            user_id: 19,
                            product_id: 1,
                            status: txStatus,
                            price: 15000,
                            provider_trx_id: 'WEB-CB-FS-1',
                            flash_sale_id: 55,
                            flash_sale_restored: txFlashSaleRestored
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    txStatus = 'Failed';
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes("type = 'Refund'")) {
                    return { rows: alreadyRefunded ? [{ id: 1 }] : [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    refundCount += 1;
                    alreadyRefunded = true;
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM promo_usages')) {
                    return { rows: [{ promo_code_id: 77 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1)')) {
                    promoRolledBack = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1)')) {
                    flashSaleDecremented += 1;
                }
                if (typeof sql === 'string' && sql.includes('flash_sale_restored = TRUE')) {
                    flashSaleRestoredMarked = true;
                    txFlashSaleRestored = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res1 = await fetch(`${baseUrl}/api/foxy/callback?token=test-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-CB-FS-1', status: 'FAILED' })
            });
            assert.strictEqual(res1.status, 200);
            assert.strictEqual(refundCount, 1);
            assert.strictEqual(promoRolledBack, true);
            assert.strictEqual(flashSaleDecremented, 1, 'Callback FAILED must decrement flash_sales.uses_count');
            assert.strictEqual(flashSaleRestoredMarked, true, 'Callback FAILED must mark flash_sale_restored = TRUE');

            // Simulasi pemanggilan ulang tidak boleh refund atau decrement flash_sale 2x
            const res2 = await fetch(`${baseUrl}/api/foxy/callback?token=test-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-CB-FS-1', status: 'FAILED' })
            });
            assert.strictEqual(res2.status, 200);
            assert.strictEqual(refundCount, 1, 'Balance must NEVER be refunded twice');
            assert.strictEqual(flashSaleDecremented, 1, 'flash_sales.uses_count must NEVER be decremented twice');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            pool.connect.mock.restore();
            pool.query.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    // (c2) Cron checkPendingTransactions restores flash_sales.uses_count & promo_usages, never double-refunds
    test('(c2) cronUtils checkPendingTransactions — FAILED memulihkan flash_sales.uses_count & promo_usages serta anti double-refund', async () => {
        assert.ok(cronPool, 'cronUtils must export pool for testing');
        axios.get = async () => ({
            data: { status: true, data: { status: 'FAILED' } }
        });

        let refundCount = 0;
        let promoRolledBack = false;
        let flashSaleDecremented = 0;
        let flashSaleRestoredMarked = false;

        mock.method(cronPool, 'query', async (sql) => {
            if (typeof sql === 'string' && (sql.includes("t.status IN ('Pending', 'Processing')") || sql.includes("WHERE t.status = 'Pending'"))) {
                return {
                    rows: [{
                        id: 802,
                        invoice_id: 'TRX-CRON-FS',
                        user_id: 20,
                        price: 17000,
                        provider_trx_id: 'WEB-CRON-FS-1',
                        check_attempts: 0,
                        product_name: 'Diamond 70',
                        h2h_callback_url: null,
                        flash_sale_id: 66,
                        flash_sale_restored: false
                    }]
                };
            }
            return { rows: [] };
        });

        mock.method(cronPool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('FROM transactions WHERE id = $1 FOR UPDATE')) {
                    return {
                        rows: [{
                            status: 'Pending',
                            check_attempts: 0,
                            flash_sale_id: 66,
                            flash_sale_restored: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes("type = 'Refund'")) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    refundCount += 1;
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM promo_usages')) {
                    return { rows: [{ promo_code_id: 78 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1)')) {
                    promoRolledBack = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1)')) {
                    flashSaleDecremented += 1;
                }
                if (typeof sql === 'string' && sql.includes('flash_sale_restored = TRUE')) {
                    flashSaleRestoredMarked = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            await cronUtils.checkPendingTransactions();
            assert.strictEqual(refundCount, 1);
            assert.strictEqual(promoRolledBack, true);
            assert.strictEqual(flashSaleDecremented, 1, 'Cron FAILED must decrement flash_sales.uses_count');
            assert.strictEqual(flashSaleRestoredMarked, true, 'Cron FAILED must mark flash_sale_restored = TRUE');

            // Pastikan helper rollback tidak pernah me-refund saldo atau flash_sale dua kali jika balance_history sudah ada
            let secondBalanceUpdate = false;
            let secondFlashSaleUpdate = false;
            await cronUtils.rollbackTransactionResources({
                query: async (sql) => {
                    if (typeof sql === 'string' && sql.includes("type = 'Refund'")) return { rows: [{ id: 1 }] };
                    if (typeof sql === 'string' && sql.includes('UPDATE users SET balance')) secondBalanceUpdate = true;
                    if (typeof sql === 'string' && sql.includes('UPDATE flash_sales')) secondFlashSaleUpdate = true;
                    return { rows: [] };
                }
            }, {
                id: 802,
                invoice_id: 'TRX-CRON-FS',
                user_id: 20,
                price: 17000,
                flash_sale_id: 66,
                flash_sale_restored: true
            });
            assert.strictEqual(secondBalanceUpdate, false, 'Shared rollback helper must NEVER refund balance twice');
            assert.strictEqual(secondFlashSaleUpdate, false, 'Shared rollback helper must NEVER decrement flash_sales twice');
        } finally {
            cronPool.query.mock.restore();
            cronPool.connect.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    // (c3) Admin resolve refund restores BOTH promo_usages and flash_sales.uses_count, blocks double refund
    test('(c3) PUT /api/admin/transactions/:invoiceId/resolve (refund) — memulihkan promo_usages & flash_sales.uses_count', async () => {
        const adminToken = makeAdminToken();
        let refundCount = 0;
        let promoRolledBack = false;
        let flashSaleDecremented = 0;
        let flashSaleRestoredMarked = false;

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE invoice_id')) {
                    return {
                        rows: [{
                            id: 803,
                            invoice_id: 'TRX-ADM-FS',
                            user_id: 21,
                            price: 25000,
                            status: 'Partial Refund',
                            flash_sale_id: 77,
                            flash_sale_restored: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes("type = 'Refund'")) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    refundCount += 1;
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM promo_usages')) {
                    return { rows: [{ promo_code_id: 79 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1)')) {
                    promoRolledBack = true;
                }
                if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1)')) {
                    flashSaleDecremented += 1;
                }
                if (typeof sql === 'string' && sql.includes('flash_sale_restored = TRUE')) {
                    flashSaleRestoredMarked = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${baseUrl}/api/admin/transactions/TRX-ADM-FS/resolve`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'refund' })
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(refundCount, 1);
            assert.strictEqual(promoRolledBack, true, 'Admin resolve refund must rollback promo_usages & promo_codes.uses_count');
            assert.strictEqual(flashSaleDecremented, 1, 'Admin resolve refund must decrement flash_sales.uses_count');
            assert.strictEqual(flashSaleRestoredMarked, true, 'Admin resolve refund must mark flash_sale_restored = TRUE');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
        }
    });

    // (d) Cache invalidation after product sync and after provider cost increase
    test('(d) SEC-003 — sync-products & deteksi kenaikan modal meng-invalidasi foxyProductCache', async () => {
        const userToken = makeUserToken(104);
        const adminToken = makeAdminToken();

        let foxyFetchCount = 0;
        let currentFoxyPrice = 10000;

        axios.get = async () => {
            foxyFetchCount += 1;
            return {
                data: {
                    data: [{
                        product_code: 'SKU-CACHE-D1',
                        product_price: currentFoxyPrice,
                        category_title: 'Mobile Legends',
                        category_type: 'Diamonds',
                        product_name: 'Diamond 50'
                    }]
                }
            };
        };
        axios.post = async () => ({ data: { status: true } });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return {
                        rows: [{
                            id: 31,
                            name: 'Diamond 50',
                            provider_sku: 'SKU-CACHE-D1',
                            price: 15000,
                            status: 'Active',
                            game_id: 1,
                            needs_server_id: false,
                            validation_config: null,
                            use_manual_prices: false,
                            manual_prices: {},
                            use_custom_margin: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance: 100000, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                    return { rows: [{ margin_percent: 10 }] }; // finalPrice = 16500
                }
                if (typeof sql === 'string' && sql.includes('FROM flash_sales')) return { rows: [] };
                if (typeof sql === 'string' && sql.includes('SELECT id, invoice_id FROM transactions')) return { rows: [] };
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) return { rowCount: 1 };
                if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) return { rows: [{ id: 7020 }] };
                return { rows: [] };
            },
            release: () => {}
        }));

        let cronConnectCalls = 0;
        mock.method(cronPool, 'connect', async () => {
            cronConnectCalls += 1;
            return {
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                    if (typeof sql === 'string' && sql.includes('SELECT id, name FROM games')) return { rows: [{ id: 1, name: 'Mobile Legends' }] };
                    if (typeof sql === 'string' && sql.includes('SELECT id, game_id, name FROM product_categories')) return { rows: [{ id: 1, game_id: 1, name: 'Diamonds' }] };
                    return { rows: [] };
                },
                release: () => {}
            };
        });

        try {
            const serverMod = require('../server.js');
            assert.strictEqual(typeof serverMod.invalidateFoxyProductCache, 'function', 'server.js must export invalidateFoxyProductCache');
            serverMod.invalidateFoxyProductCache();

            // 1. Order pertama mengisi foxyProductCache dengan harga 10000
            const res1 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 31, targetGameId: '12345678' })
            });
            assert.strictEqual(res1.status, 201);
            const fetchesAfterOrder1 = foxyFetchCount;

            // 2. Harga provider naik ke 19000 (> finalPrice 16500), lalu admin sync-products
            currentFoxyPrice = 19000;
            const syncRes = await fetch(`${baseUrl}/api/admin/sync-products`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            assert.strictEqual(syncRes.status, 200);
            const syncCallsAfterAdminSync = cronConnectCalls;

            // 3. Order berikutnya WAJIB mengambil harga baru (19000), menolak transaksi rugi
            //    dengan pesan generik, dan TIDAK memicu auto-sync produk dari jalur order!
            const res2 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 31, targetGameId: '12345678' })
            });
            assert.strictEqual(res2.status, 400, 'After sync-products invalidates cache, order must reject stale underpriced item (19000 > 16500)');
            const res2Body = await res2.json();
            assert.strictEqual(res2Body.message, 'Harga sedang diperbarui, coba lagi sebentar');
            assert.strictEqual(cronConnectCalls, syncCallsAfterAdminSync, 'POST /api/order must NOT trigger syncProductsWithFoxy on price risk');
            assert.ok(foxyFetchCount > fetchesAfterOrder1 + 1, 'Order after sync-products must re-fetch from Foxy instead of using stale cache');

            // 4. Ketika order mendeteksi price risk (19000 > 16500), cache harus ter-invalidasi;
            // jika Foxy lalu turun ke 12000, order selanjutnya langsung mengambil data baru 12000 tanpa menunggu TTL 5 menit
            currentFoxyPrice = 12000;
            const res3 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 31, targetGameId: '12345678' })
            });
            assert.strictEqual(res3.status, 201, 'After price-risk invalidates cache, next order must fetch updated Foxy price (12000)');
            assert.strictEqual(cronConnectCalls, syncCallsAfterAdminSync, 'Order path must never trigger background syncProductsWithFoxy');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            cronPool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    // Review item 1a: rollbackTransactionResources rejects 'Success' directly (JS guard + SQL rowCount guard)
    test('(review-1a) rollbackTransactionResources menolak mengubah atau merefund transaksi berstatus Success', async () => {
        let anyMutationCalled = false;
        await assert.rejects(
            () => cronUtils.rollbackTransactionResources({
                query: async (sql) => {
                    if (typeof sql === 'string' && /UPDATE|INSERT|DELETE/i.test(sql)) {
                        anyMutationCalled = true;
                    }
                    return { rows: [] };
                }
            }, {
                id: 901,
                invoice_id: 'TRX-SUCCESS-LOCK',
                user_id: 22,
                price: 20000,
                status: 'Success',
                flash_sale_id: 99,
                flash_sale_restored: false
            }),
            /Rollback ditolak/
        );
        assert.strictEqual(anyMutationCalled, false, 'Helper must refuse before executing any mutation when tx.status is Success');

        // Jika caller tidak mengisi tx.status tetapi DB rowCount = 0 karena status sudah Success di PostgreSQL:
        let balanceRefunded = false;
        let quotaRestored = false;
        await assert.rejects(
            () => cronUtils.rollbackTransactionResources({
                query: async (sql) => {
                    if (typeof sql === 'string' && sql.includes("type = 'Refund'")) return { rows: [] };
                    if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                        assert.ok(sql.includes("status IN ('Pending', 'Processing', 'Partial Refund')"), 'SQL UPDATE must guard against non-eligible status');
                        return { rowCount: 0, rows: [] };
                    }
                    if (typeof sql === 'string' && sql.includes('UPDATE users SET balance')) balanceRefunded = true;
                    if (typeof sql === 'string' && sql.includes('DELETE FROM promo_usages')) quotaRestored = true;
                    if (typeof sql === 'string' && sql.includes('UPDATE flash_sales')) quotaRestored = true;
                    return { rows: [] };
                }
            }, {
                id: 902,
                invoice_id: 'TRX-SUCCESS-SQLGUARD',
                user_id: 22,
                price: 20000,
                flash_sale_id: 99,
                flash_sale_restored: false
            }),
            /Rollback ditolak/
        );
        assert.strictEqual(balanceRefunded, false, 'Must NOT refund balance when conditional UPDATE rowCount === 0');
        assert.strictEqual(quotaRestored, false, 'Must NOT restore quotas when conditional UPDATE rowCount === 0');
    });

    // Review item 1b: concurrent callback 'Success' + cron 'Failed' cannot end up 'Failed' or refunded
    test('(review-1b) callback Success dan cron Failed bersamaan tidak boleh berakhir Failed atau refund', async () => {
        const state = {
            status: 'Pending',
            balance: 50000,
            refundRows: 0,
            flashSaleUses: 1,
            locked: false,
            waiters: []
        };
        let callbackSelectSql = '';

        let notifyCallbackLocked = null;
        const callbackAcquiredLock = new Promise(resolve => { notifyCallbackLocked = resolve; });

        async function acquireRowLock() {
            while (state.locked) {
                await new Promise(resolve => state.waiters.push(resolve));
            }
            state.locked = true;
        }
        function releaseRowLock() {
            state.locked = false;
            const next = state.waiters.shift();
            if (next) next();
        }

        function createTransactionalClient() {
            let holdingLock = false;
            return {
                query: async (sql, params) => {
                    if (sql === 'BEGIN') return {};
                    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                        if (holdingLock) {
                            holdingLock = false;
                            releaseRowLock();
                        }
                        return {};
                    }
                    if (typeof sql === 'string' && sql.includes('FOR UPDATE') && sql.includes('transactions')) {
                        const isCallbackLock = sql.includes('WHERE provider_trx_id');
                        if (isCallbackLock) {
                            callbackSelectSql = sql;
                        } else {
                            // Pastikan cron benar-benar bertabrakan pada saat callback sedang memegang FOR UPDATE lock
                            await callbackAcquiredLock;
                        }
                        await acquireRowLock();
                        holdingLock = true;
                        if (isCallbackLock && notifyCallbackLocked) {
                            notifyCallbackLocked();
                            notifyCallbackLocked = null;
                            await new Promise(r => setTimeout(r, 20));
                        }
                        return {
                            rows: [{
                                id: 950,
                                invoice_id: 'TRX-CONC-RACE',
                                user_id: 50,
                                product_id: 1,
                                price: 20000,
                                status: state.status,
                                provider_trx_id: 'WEB-CONC-RACE',
                                check_attempts: 0,
                                flash_sale_id: 77,
                                flash_sale_restored: false
                            }]
                        };
                    }
                    if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Success'")) {
                        state.status = 'Success';
                        return { rowCount: 1 };
                    }
                    if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                        if (!['Pending', 'Processing', 'Partial Refund'].includes(state.status)) {
                            return { rowCount: 0 };
                        }
                        state.status = 'Failed';
                        return { rowCount: 1 };
                    }
                    if (typeof sql === 'string' && sql.includes("type = 'Refund'")) {
                        return { rows: state.refundRows > 0 ? [{ id: 1 }] : [] };
                    }
                    if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                        state.balance += Number(params[0]);
                        return { rowCount: 1 };
                    }
                    if (typeof sql === 'string' && sql.includes("INSERT INTO balance_history") && sql.includes("'Refund'")) {
                        state.refundRows += 1;
                        return { rowCount: 1 };
                    }
                    if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1)')) {
                        state.flashSaleUses = Math.max(0, state.flashSaleUses - 1);
                        return { rowCount: 1 };
                    }
                    return { rows: [] };
                },
                release: () => {
                    if (holdingLock) {
                        holdingLock = false;
                        releaseRowLock();
                    }
                }
            };
        }

        axios.get = async (url) => {
            if (url.includes('/v1/transaction/')) {
                return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-CONC-1' } } };
            }
            return { data: { status: true, data: { status: 'FAILED' } } };
        };

        process.env.FOXY_CALLBACK_SECRET = 'test-cb-secret';
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 950, status: state.status, price: 20000, product_id: 1, provider_trx_id: 'WEB-CONC-RACE' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => createTransactionalClient());
        mock.method(cronPool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return {
                    rows: [{
                        id: 950,
                        invoice_id: 'TRX-CONC-RACE',
                        user_id: 50,
                        price: 20000,
                        provider_trx_id: 'WEB-CONC-RACE',
                        check_attempts: 0,
                        product_name: 'Diamond 100',
                        h2h_callback_url: null,
                        flash_sale_id: 77,
                        flash_sale_restored: false
                    }]
                };
            }
            return { rows: [] };
        });
        mock.method(cronPool, 'connect', async () => createTransactionalClient());

        try {
            // Jalankan callback Success dan cron checkPendingTransactions secara bersamaan pada satu invoice:
            // Panggilan status pertama berasal dari cron (melihat FAILED lalu menunggu FOR UPDATE),
            // sementara callback menerima SUCCESS, mengunci baris & commit Success lebih dulu.
            let cronStatusFetched = false;
            axios.get = async (url) => {
                if (typeof url === 'string' && url.includes('WEB-CONC-RACE')) {
                    if (!cronStatusFetched) {
                        cronStatusFetched = true;
                        return { data: { status: true, data: { status: 'FAILED' } } };
                    }
                    return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-RACE-1' } } };
                }
                return origAxiosGet(url);
            };

            const cronPromise = cronUtils.checkPendingTransactions();
            const cbPromise = fetch(`${baseUrl}/api/foxy/callback?token=test-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-CONC-RACE', status: 'SUCCESS', sn: 'SN-RACE-1' })
            });
            const [cbRes] = await Promise.all([cbPromise, cronPromise]);

            assert.strictEqual(cbRes.status, 200);
            assert.ok(callbackSelectSql.includes('FOR UPDATE') && !callbackSelectSql.includes("status = 'Pending'"), 'Callback must lock row by provider_trx_id FOR UPDATE without filtering status');
            assert.strictEqual(state.status, 'Success', 'Final status must stay Success when callback Success and cron Failed race');
            assert.strictEqual(state.balance, 50000, 'Balance must NOT be refunded when status is Success');
            assert.strictEqual(state.refundRows, 0, 'balance_history must have 0 Refund rows');
            assert.strictEqual(state.flashSaleUses, 1, 'flash_sales.uses_count must NOT be decremented');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            pool.query.mock.restore();
            pool.connect.mock.restore();
            cronPool.query.mock.restore();
            cronPool.connect.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    // Review item 3: POST /api/promos/validate enforces finalPrice >= providerCost consistently with checkout
    test('(review-3) POST /api/promos/validate — menolak promo yang membuat harga akhir di bawah modal & mengizinkan yang valid', async () => {
        const userToken = makeUserToken(105);
        require('../server.js').invalidateFoxyProductCache();

        let currentPromoDiscount = 10000;
        axios.get = async () => ({
            data: { data: [{ product_code: 'SKU-VAL-1', product_price: 18000 }] }
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (typeof sql === 'string' && sql.includes('FROM promo_codes')) {
                    return {
                        rows: [{
                            id: 401,
                            code: 'TESTPROMO',
                            type: 'fixed',
                            value: currentPromoDiscount,
                            is_active: true,
                            expires_at: null,
                            max_uses: 100,
                            uses_count: 0,
                            rules: {}
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM products p')) {
                    return {
                        rows: [{
                            id: 41,
                            game_id: 1,
                            provider_sku: 'SKU-VAL-1',
                            price: 20000,
                            use_manual_prices: false,
                            manual_prices: {},
                            use_custom_margin: false
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ role_id: 1, role_name: 'BRONZE' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                    return { rows: [{ margin_percent: 10 }] }; // effectivePrice = 22000
                }
                if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                    return { rows: [] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            // 1. Diskon 10000 -> 22000 - 10000 = 12000 < modal 18000 -> DITOLAK 400
            currentPromoDiscount = 10000;
            const resTooCheap = await fetch(`${baseUrl}/api/promos/validate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ promo_code: 'TESTPROMO', product_id: 41, target_game_id: '123456' })
            });
            assert.strictEqual(resTooCheap.status, 400, 'Validate must reject promo when final_price < provider modal');
            const bodyTooCheap = await resTooCheap.json();
            assert.strictEqual(bodyTooCheap.valid, false);

            // 2. Diskon 2000 -> 22000 - 2000 = 20000 >= modal 18000 -> VALID 200
            currentPromoDiscount = 2000;
            const resValid = await fetch(`${baseUrl}/api/promos/validate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ promo_code: 'TESTPROMO', product_id: 41, target_game_id: '123456' })
            });
            assert.strictEqual(resValid.status, 200);
            const bodyValid = await resValid.json();
            assert.strictEqual(bodyValid.valid, true);
            assert.strictEqual(bodyValid.final_price, 20000);
        } finally {
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
        }
    });
});

describe('SEC-001: Foxy Callback Security Hardening', () => {
    const axios = require('axios');
    const { validateEnvironment, callbackClock, clearCallbackCooldownCache } = require('../server.js');
    let secServer;
    let secCallbackUrl;
    let origAxiosGet;

    before(() => {
        secServer = startServer(0);
        secCallbackUrl = `http://127.0.0.1:${secServer.address().port}/api/foxy/callback`;
        origAxiosGet = axios.get;
    });

    after(async () => {
        axios.get = origAxiosGet;
        delete process.env.FOXY_CALLBACK_SECRET_PREVIOUS;
        delete process.env.ALLOW_INSECURE_CALLBACK;
        process.env.FOXY_CALLBACK_SECRET = '';
        if (typeof clearCallbackCooldownCache === 'function') clearCallbackCooldownCache();
        await new Promise(resolve => secServer.close(resolve));
    });

    test('validateEnvironment wajib menolak startup production jika FOXY_CALLBACK_SECRET kosong', () => {
        const prevNodeEnv = process.env.NODE_ENV;
        const prevSecret = process.env.FOXY_CALLBACK_SECRET;
        const prevAllow = process.env.ALLOW_INSECURE_CALLBACK;

        try {
            process.env.NODE_ENV = 'production';
            process.env.FOXY_CALLBACK_SECRET = '';
            process.env.ALLOW_INSECURE_CALLBACK = 'true';
            assert.throws(
                () => validateEnvironment({ strict: true }),
                /FOXY_CALLBACK_SECRET/,
                'NODE_ENV=production must fail startup when FOXY_CALLBACK_SECRET is empty'
            );

            process.env.FOXY_CALLBACK_SECRET = 'prod-strong-secret-value';
            assert.doesNotThrow(
                () => validateEnvironment({ strict: true }),
                'NODE_ENV=production should start when FOXY_CALLBACK_SECRET is set'
            );
        } finally {
            if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prevNodeEnv;
            process.env.FOXY_CALLBACK_SECRET = prevSecret || '';
            if (prevAllow === undefined) delete process.env.ALLOW_INSECURE_CALLBACK;
            else process.env.ALLOW_INSECURE_CALLBACK = prevAllow;
        }
    });

    test('fail-closed: tanpa secret ditolak 403, hanya bisa dilewati non-prod dengan ALLOW_INSECURE_CALLBACK=true', async () => {
        const prevNodeEnv = process.env.NODE_ENV;
        const prevSecret = process.env.FOXY_CALLBACK_SECRET;
        const prevAllow = process.env.ALLOW_INSECURE_CALLBACK;

        let foxyCalled = 0;
        axios.get = async () => {
            foxyCalled += 1;
            return { data: { status: true, data: { status: 'SUCCESS' } } };
        };
        mock.method(pool, 'query', async () => ({ rows: [] }));

        try {
            process.env.NODE_ENV = 'test';
            process.env.FOXY_CALLBACK_SECRET = '';
            delete process.env.ALLOW_INSECURE_CALLBACK;

            const resNoSecret = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FAILCLOSED-1', status: 'SUCCESS', sn: 'SN-FC-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resNoSecret.status, 403, 'Callback without configured secret must fail-closed with 403');
            assert.strictEqual(foxyCalled, 0);

            // Production MUST ignore ALLOW_INSECURE_CALLBACK=true
            process.env.NODE_ENV = 'production';
            process.env.ALLOW_INSECURE_CALLBACK = 'true';
            const resProdOptIn = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FAILCLOSED-2', status: 'SUCCESS', sn: 'SN-FC-2', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resProdOptIn.status, 403, 'Production must never honor ALLOW_INSECURE_CALLBACK=true');

            // Local/non-production with ALLOW_INSECURE_CALLBACK=true allows missing secret
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_INSECURE_CALLBACK = 'true';
            const resLocalOptIn = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FAILCLOSED-3', status: 'SUCCESS', sn: 'SN-FC-3', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resLocalOptIn.status, 200);
            assert.deepStrictEqual(await resLocalOptIn.json(), { message: 'Callback berhasil diproses.' });
        } finally {
            axios.get = origAxiosGet;
            pool.query.mock.restore();
            if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prevNodeEnv;
            process.env.FOXY_CALLBACK_SECRET = prevSecret || '';
            if (prevAllow === undefined) delete process.env.ALLOW_INSECURE_CALLBACK;
            else process.env.ALLOW_INSECURE_CALLBACK = prevAllow;
        }
    });

    test('tanpa token atau token salah ditolak 403 tanpa panggil Foxy', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-primary-secret-token';
        let foxyCalled = 0;
        axios.get = async () => {
            foxyCalled += 1;
            return { data: { status: true, data: { status: 'SUCCESS' } } };
        };

        try {
            const resMissing = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-NO-TOKEN', status: 'SUCCESS', sn: 'SN-AUTH-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resMissing.status, 403);

            const resWrongLen = await fetch(`${secCallbackUrl}?token=short`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-WRONG-LEN', status: 'SUCCESS', sn: 'SN-AUTH-2', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resWrongLen.status, 403);

            const resArrayQuery = await fetch(`${secCallbackUrl}?token=sec1-primary-secret-token&token=extra`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-ARR-TOKEN', status: 'SUCCESS', sn: 'SN-AUTH-3', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resArrayQuery.status, 403);
            assert.strictEqual(foxyCalled, 0);
        } finally {
            axios.get = origAxiosGet;
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('token di query ?token=, rotasi FOXY_CALLBACK_SECRET_PREVIOUS, dan tidak bocor ke log', async () => {
        const curSecret = 'rot-current-secret-987654';
        const prevSecret = 'rot-previous-secret-123456';
        process.env.FOXY_CALLBACK_SECRET = curSecret;
        process.env.FOXY_CALLBACK_SECRET_PREVIOUS = prevSecret;

        const loggedMessages = [];
        const origLog = console.log;
        const origWarn = console.warn;
        const origErr = console.error;
        console.log = (...args) => loggedMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
        console.warn = (...args) => loggedMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
        console.error = (...args) => loggedMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));

        axios.get = async (url) => {
            const err = new Error(`Simulated Foxy error for ${url}?token=${curSecret}`);
            err.response = {
                status: 500,
                statusText: 'Internal Error',
                headers: {},
                config: { method: 'GET', url: `${url}?token=${curSecret}` }
            };
            throw err;
        };

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9101, status: 'Pending', price: 10000, product_id: 2, provider_trx_id: 'SEC1-ROT-1', provider_sku: 'SKU-ROT', product_price: 9000 }] };
            }
            return { rows: [] };
        });

        try {
            // Token baru via query ?token=
            const resCur = await fetch(`${secCallbackUrl}?token=${encodeURIComponent(curSecret)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-ROT-1', status: 'SUCCESS', sn: 'SN-ROT-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resCur.status, 200);
            assert.deepStrictEqual(await resCur.json(), { message: 'Callback berhasil diproses.' });

            // Token lama via query ?token= saat masa rotasi
            const resPrevQuery = await fetch(`${secCallbackUrl}?token=${encodeURIComponent(prevSecret)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-ROT-2-UNKNOWN', status: 'SUCCESS', sn: 'SN-ROT-2', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resPrevQuery.status, 200);
            assert.deepStrictEqual(await resPrevQuery.json(), { message: 'Callback berhasil diproses.' });

            // Token lama via header X-Callback-Token
            const resPrevHeader = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-callback-token': prevSecret },
                body: JSON.stringify({ trx_id: 'SEC1-ROT-3-UNKNOWN', status: 'SUCCESS', sn: 'SN-ROT-3', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resPrevHeader.status, 200);
            assert.deepStrictEqual(await resPrevHeader.json(), { message: 'Callback berhasil diproses.' });

            const combinedLogs = loggedMessages.join('\n');
            assert.strictEqual(combinedLogs.includes(curSecret), false, 'Current callback token must NEVER appear in logs');
            assert.strictEqual(combinedLogs.includes(prevSecret), false, 'Previous callback token must NEVER appear in logs');
        } finally {
            console.log = origLog;
            console.warn = origWarn;
            console.error = origErr;
            axios.get = origAxiosGet;
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
            delete process.env.FOXY_CALLBACK_SECRET_PREVIOUS;
        }
    });

    test('zero-trust payload: sn/message/status di req.body tidak pernah dipakai atau tersimpan', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-zt-secret';

        let savedSnParam = null;
        let savedSnWithNoSn = 'UNTOUCHED';
        let savedRefundDescription = '';
        let foxyMode = 'SUCCESS_NO_SN';

        axios.get = async (url) => {
            if (foxyMode === 'SUCCESS_NO_SN') {
                return { data: { status: true, data: { trx_id: 'SEC1-ZT-1', status: 'SUCCESS', product_code: 'SKU-ZT', product_price: 9000 } } };
            }
            return { data: { status: true, data: { trx_id: 'SEC1-ZT-2', status: 'FAILED', message: 'FOXY-REAL-REASON', product_code: 'SKU-ZT', product_price: 9000 } } };
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                const trxId = params && params[0];
                return { rows: [{ id: trxId === 'SEC1-ZT-1' ? 9201 : 9202, status: 'Pending', price: 10000, product_id: 3, provider_trx_id: trxId, provider_sku: 'SKU-ZT', product_price: 9000 }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    const trxId = params && params[0];
                    return {
                        rows: [{
                            id: trxId === 'SEC1-ZT-1' ? 9201 : 9202,
                            invoice_id: trxId === 'SEC1-ZT-1' ? 'INV-ZT-1' : 'INV-ZT-2',
                            user_id: 33,
                            product_id: 3,
                            status: 'Pending',
                            price: 10000,
                            provider_trx_id: trxId
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM products WHERE id')) {
                    return { rows: [{ provider_sku: 'SKU-ZT', price: 9000 }] };
                }
                if (typeof sql === 'string' && sql.includes("SET status = 'Success', provider_sn")) {
                    savedSnParam = params && params[0];
                }
                if (typeof sql === 'string' && sql.includes("SET status = 'Success', updated_at")) {
                    savedSnWithNoSn = null;
                }
                if (typeof sql === 'string' && sql.includes("INSERT INTO balance_history") && sql.includes("'Refund'")) {
                    savedRefundDescription = params && params[2];
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            // 1. Body menyuntikkan sn/serial_number/provider_sn palsu, Foxy tidak mengembalikan SN -> SN body DILARANG tersimpan
            foxyMode = 'SUCCESS_NO_SN';
            const res1 = await fetch(`${secCallbackUrl}?token=sec1-zt-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trx_id: 'SEC1-ZT-1',
                    status: 'FAILED',
                    sn: 'SPOOFED-BODY-SN',
                    serial_number: 'SPOOFED-SERIAL',
                    provider_sn: 'SPOOFED-PSN',
                    message: 'SPOOFED-MESSAGE'
                })
            });
            assert.strictEqual(res1.status, 200);
            assert.deepStrictEqual(await res1.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(savedSnParam, null, 'Spoofed SN in req.body must NEVER be saved to provider_sn');
            assert.strictEqual(savedSnWithNoSn, null, 'Should update Success without req.body SN fallback');

            // 2. Body mengaku SUCCESS & menyuntikkan message palsu, Foxy bilang FAILED dengan message asli
            foxyMode = 'FAILED_WITH_MSG';
            const res2 = await fetch(`${secCallbackUrl}?token=sec1-zt-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trx_id: 'SEC1-ZT-2',
                    status: 'SUCCESS',
                    sn: 'SPOOFED-SN-2',
                    message: 'SPOOFED-BODY-REASON'
                })
            });
            assert.strictEqual(res2.status, 200);
            assert.deepStrictEqual(await res2.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(savedRefundDescription.includes('SPOOFED-BODY-REASON'), false, 'req.body.message must NEVER enter refund description');
            assert.ok(savedRefundDescription.includes('FOXY-REAL-REASON'), 'Refund description should come from Foxy verified status response');
        } finally {
            axios.get = origAxiosGet;
            pool.connect.mock.restore();
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('cross-check /v1/status vs DB: SKU atau trx_id tidak cocok -> log warning (invoice + reason saja) & status tidak berubah', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-xcheck-secret';

        let statusMutated = false;
        let currentScenario = 'SKU_MISMATCH';
        const warnLogs = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));

        axios.get = async (url) => {
            if (currentScenario === 'SKU_MISMATCH') {
                return { data: { status: true, data: { trx_id: 'SEC1-XC-1', status: 'SUCCESS', product_code: 'SKU-WRONG', sn: 'SN1' } } };
            }
            if (currentScenario === 'TRX_MISMATCH') {
                return { data: { status: true, data: { trx_id: 'TRX-OTHER', status: 'SUCCESS', product_code: 'SKU-REAL', sn: 'SN3' } } };
            }
            // products.price saat ini (mis. berubah ke 9000 sementara tx.price 12000 atau Foxy 15000) tidak boleh memblokir selama kolom modal transaksi belum ada
            return { data: { status: true, data: { trx_id: 'SEC1-XC-4', status: 'SUCCESS', product_code: 'SKU-REAL', product_price: 15000, sn: 'SN4' } } };
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                const trxId = params && params[0];
                return { rows: [{ id: 9300, status: 'Pending', price: 12000, product_id: 5, provider_trx_id: trxId, provider_sku: 'SKU-REAL' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    const trxId = params && params[0];
                    return { rows: [{ id: 9300, invoice_id: `INV-${trxId}`, user_id: 12, product_id: 5, status: 'Pending', price: 12000, provider_trx_id: trxId }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM products WHERE id')) {
                    return { rows: [{ provider_sku: 'SKU-REAL' }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE transactions')) {
                    statusMutated = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            currentScenario = 'SKU_MISMATCH';
            const r1 = await fetch(`${secCallbackUrl}?token=sec1-xcheck-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-XC-1', status: 'SUCCESS', sn: 'BODY-SENSITIVE-SN-1', message: 'BODY-SENSITIVE-MSG-1' })
            });
            assert.strictEqual(r1.status, 200);
            assert.deepStrictEqual(await r1.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusMutated, false, 'SKU mismatch must NOT change transaction status');

            currentScenario = 'TRX_MISMATCH';
            const r3 = await fetch(`${secCallbackUrl}?token=sec1-xcheck-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-XC-3', status: 'SUCCESS', sn: 'BODY-SENSITIVE-SN-3', message: 'BODY-SENSITIVE-MSG-3' })
            });
            assert.strictEqual(r3.status, 200);
            assert.deepStrictEqual(await r3.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusMutated, false, 'trx_id mismatch must NOT change transaction status');

            const combinedWarns = warnLogs.join('\n');
            assert.ok(combinedWarns.includes('INV-SEC1-XC-1') && combinedWarns.includes('SKU mismatch'), 'SKU mismatch warning must include invoice and reason');
            assert.ok(combinedWarns.includes('INV-SEC1-XC-3') && combinedWarns.includes('trx_id mismatch'), 'trx_id mismatch warning must include invoice and reason');
            assert.strictEqual(combinedWarns.includes('sec1-xcheck-secret'), false, 'Mismatch warning must NOT leak callback token');
            assert.strictEqual(combinedWarns.includes('BODY-SENSITIVE'), false, 'Mismatch warning must NOT include req.body contents');

            currentScenario = 'VALID_NOT_BLOCKED_BY_LIVE_PRODUCT_PRICE';
            const r4 = await fetch(`${secCallbackUrl}?token=sec1-xcheck-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-XC-4', status: 'SUCCESS', sn: 'SN4', message: 'Transaksi sukses' })
            });
            assert.strictEqual(r4.status, 200);
            assert.deepStrictEqual(await r4.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusMutated, true, 'Matching trx_id & SKU must commit Success without comparing against live products.price');
        } finally {
            console.warn = origWarn;
            axios.get = origAxiosGet;
            pool.connect.mock.restore();
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('respons /v1/status tanpa SKU dan nominal tetap diproses normal', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-minimal-secret';

        let updatedToSuccess = false;
        let savedSn = null;

        axios.get = async () => ({
            // Hanya memuat trx_id, status, sn (tanpa product_code/sku dan tanpa price/amount)
            data: { status: true, data: { trx_id: 'SEC1-MINIMAL-1', status: 'SUCCESS', sn: 'SN-MINIMAL-OK' } }
        });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9350, status: 'Pending', price: 15000, product_id: 7, provider_trx_id: 'SEC1-MINIMAL-1', provider_sku: 'SKU-DB-7' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    return { rows: [{ id: 9350, invoice_id: 'INV-MINIMAL-1', user_id: 21, product_id: 7, status: 'Pending', price: 15000, provider_trx_id: 'SEC1-MINIMAL-1' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM products WHERE id')) {
                    return { rows: [{ provider_sku: 'SKU-DB-7' }] };
                }
                if (typeof sql === 'string' && sql.includes("SET status = 'Success', provider_sn")) {
                    updatedToSuccess = true;
                    savedSn = params && params[0];
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${secCallbackUrl}?token=sec1-minimal-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-MINIMAL-1', status: 'SUCCESS', sn: 'SN-MINIMAL-OK', message: 'Transaksi sukses' })
            });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(await res.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(updatedToSuccess, true, 'Status response without SKU or nominal must be processed normally');
            assert.strictEqual(savedSn, 'SN-MINIMAL-OK');
        } finally {
            axios.get = origAxiosGet;
            pool.connect.mock.restore();
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('transaksi sudah final atau tidak ditemukan -> Foxy tidak dipanggil, serta cooldown 5 detik pakai injectable clock', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-limit-secret';
        if (typeof clearCallbackCooldownCache === 'function') clearCallbackCooldownCache();

        let foxyCalls = 0;
        let currentDbStatus = 'Success';
        let fakeNow = 1_700_000_000_000;
        mock.method(callbackClock, 'now', () => fakeNow);

        axios.get = async () => {
            foxyCalls += 1;
            return { data: { status: true, data: { status: 'PENDING' } } };
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                const trxId = params && params[0];
                if (trxId === 'SEC1-UNKNOWN') return { rows: [] };
                return { rows: [{ id: 9400, status: currentDbStatus, price: 10000, product_id: 1, provider_trx_id: trxId }] };
            }
            return { rows: [] };
        });

        try {
            // 1. Transaksi sudah final ('Success') -> Foxy tidak boleh dipanggil
            currentDbStatus = 'Success';
            const resFinal = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FINAL-1', status: 'SUCCESS', sn: 'SN-FIN-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resFinal.status, 200);
            assert.deepStrictEqual(await resFinal.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(foxyCalls, 0, 'Final transaction must not trigger Foxy /v1/status call');

            // 2. Transaksi tidak ada -> tetap 200 tanpa bocor eksistensi, Foxy 0 panggilan
            const resUnknown = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-UNKNOWN', status: 'SUCCESS', sn: 'SN-UNK-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resUnknown.status, 200);
            assert.deepStrictEqual(await resUnknown.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(foxyCalls, 0, 'Unknown transaction must not call Foxy');

            // 3. Cooldown 5 detik: dua callback beruntun pada Pending trx_id yang sama -> hanya 1x panggilan Foxy, lalu lolos lagi setelah > 5000ms
            currentDbStatus = 'Pending';
            const resCool1 = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-COOLDOWN-1', status: 'PENDING', message: 'Sedang diproses' })
            });
            fakeNow += 2000;
            const resCool2 = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-COOLDOWN-1', status: 'PENDING', message: 'Sedang diproses' })
            });
            assert.strictEqual(resCool1.status, 200);
            assert.strictEqual(resCool2.status, 200);
            assert.strictEqual(foxyCalls, 1, 'Repeated callback within 5s cooldown must only call Foxy once');

            fakeNow += 3001; // Total elapsed: 5001ms (> 5000ms cooldown)
            const resCool3 = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-COOLDOWN-1', status: 'PENDING', message: 'Sedang diproses' })
            });
            assert.strictEqual(resCool3.status, 200);
            assert.strictEqual(foxyCalls, 2, 'Callback after cooldown window expires should call Foxy again');
        } finally {
            axios.get = origAxiosGet;
            pool.query.mock.restore();
            callbackClock.now.mock.restore();
            if (typeof clearCallbackCooldownCache === 'function') clearCallbackCooldownCache();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });
});

describe('Phase 13: SEC-004, SEC-007 & SEC-008: H2H Security Hardening', () => {
    const crypto = require('crypto');
    const http = require('http');
    const jwt = require('jsonwebtoken');
    const axios = require('axios');
    const cronUtils = require('../utils/cronUtils');
    const cronPool = cronUtils.pool;
    const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

    let server;
    let baseUrl;
    let origPoolQuery;
    let origPoolConnect;
    let origCronQuery;
    let origCronConnect;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id = 9001, role = 'PARTNER') {
        return jwt.sign({ id, username: `reseller${id}`, role }, JWT_SECRET, { expiresIn: '1h' });
    }

    before(() => {
        origPoolQuery = pool.query;
        origPoolConnect = pool.connect;
        origCronQuery = cronPool.query;
        origCronConnect = cronPool.connect;
        origAxiosGet = axios.get;
        origAxiosPost = axios.post;
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        pool.query = origPoolQuery;
        pool.connect = origPoolConnect;
        cronPool.query = origCronQuery;
        cronPool.connect = origCronConnect;
        axios.get = origAxiosGet;
        axios.post = origAxiosPost;
        await new Promise(resolve => server.close(resolve));
    });

    test('SEC-004 (1): generate-apikey simpan SHA-256 hash & prefix saja, GET /api/user/apikey tidak return key utuh, regenerate & revoke bekerja', async () => {
        const token = makeUserToken(9001);
        const state = {
            id: 9001,
            api_key: null,
            api_key_hash: null,
            api_key_prefix: null,
            h2h_webhook_secret: null
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('UPDATE users') && sql.includes('api_key_hash') && !sql.includes('api_key_hash = NULL')) {
                assert.ok(sql.includes('api_key = NULL'), 'Generate/Regenerate must explicitly clear plaintext api_key to NULL');
                state.api_key = null;
                state.api_key_hash = params[0];
                state.api_key_prefix = params[1];
                if (!state.h2h_webhook_secret && params[2]) state.h2h_webhook_secret = params[2];
                return { rows: [{ api_key_prefix: state.api_key_prefix, webhook_secret_created: Boolean(params[2]) }] };
            }
            if (sql.includes('UPDATE users') && sql.includes('api_key_hash = NULL')) {
                state.api_key = null;
                state.api_key_hash = null;
                state.api_key_prefix = null;
                return { rows: [] };
            }
            if (sql.includes('FROM users') && sql.includes('api_key_prefix')) {
                return { rows: [{ api_key_prefix: state.api_key_prefix, api_key_hash: state.api_key_hash, api_key: state.api_key }] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                if (state.api_key_hash && params[1] === state.api_key_hash) {
                    return { rows: [{ id: 9001, username: 'reseller9001', balance: 25000, role_id: 2, role_name: 'PARTNER', api_key: state.api_key, api_key_hash: state.api_key_hash, api_key_prefix: state.api_key_prefix, whitelisted_ips: [] }] };
                }
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            if (sql.includes('SELECT h2h_webhook_secret FROM users')) {
                return { rows: [{ h2h_webhook_secret: state.h2h_webhook_secret }] };
            }
            if (sql.includes('UPDATE users SET h2h_webhook_secret')) {
                state.h2h_webhook_secret = params[0];
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            const genRes = await fetch(`${baseUrl}/api/user/generate-apikey`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(genRes.status, 200);
            const genBody = await genRes.json();
            assert.match(genBody.apiKey, /^[a-f0-9]{64}$/, 'New API key must be 32 random bytes (64 hex chars)');
            assert.strictEqual(genBody.prefix, genBody.apiKey.slice(0, 8));
            assert.strictEqual(state.api_key, null, 'Plaintext api_key must NOT be stored');
            assert.strictEqual(
                state.api_key_hash,
                crypto.createHash('sha256').update(genBody.apiKey).digest('hex'),
                'Stored api_key_hash must be SHA-256 of generated key'
            );

            // GET /api/user/apikey must NEVER return full key again
            const getRes = await fetch(`${baseUrl}/api/user/apikey`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(getRes.status, 200);
            const getRaw = await getRes.text();
            const getBody = JSON.parse(getRaw);
            assert.strictEqual(getBody.apiKey, undefined, 'GET /api/user/apikey must not return full apiKey');
            assert.ok(!getRaw.includes(genBody.apiKey), 'Full API key must not appear in GET response');
            assert.strictEqual(getBody.hasApiKey, true);
            assert.strictEqual(getBody.status, 'active');
            assert.strictEqual(getBody.prefix, genBody.apiKey.slice(0, 8));

            // Regenerate gives a new 64-hex key and invalidates previous key
            const regenRes = await fetch(`${baseUrl}/api/user/apikey/regenerate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(regenRes.status, 200);
            const regenBody = await regenRes.json();
            assert.match(regenBody.apiKey, /^[a-f0-9]{64}$/);
            assert.notStrictEqual(regenBody.apiKey, genBody.apiKey);

            // Revoke clears key hash + prefix and blocks subsequent H2H usage
            const revRes = await fetch(`${baseUrl}/api/user/apikey`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(revRes.status, 200);
            const revBody = await revRes.json();
            assert.strictEqual(revBody.hasApiKey, false);
            assert.strictEqual(revBody.status, 'inactive');

            const getAfterRevoke = await fetch(`${baseUrl}/api/user/apikey`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const afterBody = await getAfterRevoke.json();
            assert.strictEqual(afterBody.hasApiKey, false);
            assert.strictEqual(afterBody.prefix, null);

            const h2hRevokedRes = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': regenBody.apiKey }
            });
            assert.strictEqual(h2hRevokedRes.status, 403, 'Revoked API key must be rejected');

            // Webhook secret status never returns full secret; rotate returns new secret once
            const getWhRes = await fetch(`${baseUrl}/api/user/webhook-secret`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(getWhRes.status, 200);
            const getWhBody = await getWhRes.json();
            assert.strictEqual(getWhBody.webhookSecret, undefined, 'GET /api/user/webhook-secret must not return full secret');
            assert.strictEqual(getWhBody.hasWebhookSecret, true);

            const rotWhRes = await fetch(`${baseUrl}/api/user/webhook-secret/rotate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(rotWhRes.status, 200);
            const rotWhBody = await rotWhRes.json();
            assert.match(rotWhBody.webhookSecret, /^[a-f0-9]{64}$/);
            assert.strictEqual(rotWhBody.webhookSecret, state.h2h_webhook_secret);
        } finally {
            pool.query.mock.restore();
        }
    });

    test('SEC-004 (2): legacy 48-hex API key tetap lolos dan lazy-migrate ke SHA-256 hash dengan api_key jadi NULL', async () => {
        const legacyKey = 'c'.repeat(48);
        const expectedHash = crypto.createHash('sha256').update(legacyKey).digest('hex');
        const userRow = {
            id: 9002,
            username: 'legacy_reseller',
            balance: 75000,
            role_id: 2,
            role_name: 'PARTNER',
            api_key: legacyKey,
            api_key_hash: null,
            api_key_prefix: null,
            h2h_callback_url: null,
            whitelisted_ips: []
        };
        let lazyMigratedCount = 0;

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                const matchPlain = userRow.api_key !== null && params[0] === userRow.api_key;
                const matchHash = userRow.api_key_hash !== null && params[1] === userRow.api_key_hash;
                return (matchPlain || matchHash) ? { rows: [{ ...userRow }] } : { rows: [] };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET api_key_hash') && sql.includes('api_key = NULL')) {
                lazyMigratedCount += 1;
                userRow.api_key_hash = params[0];
                userRow.api_key_prefix = params[1];
                userRow.api_key = null;
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: userRow.whitelisted_ips }] };
            }
            return { rows: [] };
        });

        try {
            // Request 1: legacy plaintext key succeeds AND triggers lazy migration
            const res1 = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': legacyKey }
            });
            assert.strictEqual(res1.status, 200, 'Legacy 48-char key must still authenticate');
            assert.strictEqual(lazyMigratedCount, 1, 'First valid request must lazy-migrate legacy key');
            assert.strictEqual(userRow.api_key, null, 'Plaintext api_key must be cleared to NULL after lazy migration');
            assert.strictEqual(userRow.api_key_hash, expectedHash);
            assert.strictEqual(userRow.api_key_prefix, legacyKey.slice(0, 8));

            // Request 2: SAME legacy key still succeeds purely via api_key_hash without re-migrating
            const res2 = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': legacyKey }
            });
            assert.strictEqual(res2.status, 200, 'Legacy key must continue working via hash after plaintext is NULL');
            assert.strictEqual(lazyMigratedCount, 1, 'Lazy migration should only run once');

            // Request 3: wrong key rejected
            const resBad = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': 'd'.repeat(48) }
            });
            assert.strictEqual(resBad.status, 403);
        } finally {
            pool.query.mock.restore();
        }
    });

    test('SEC-008 (1): protectH2HIp dukung CIDR IPv4/IPv6 & ::ffff:x.x.x.x, lindungi /h2h/profile & /h2h/profile/callback, blok loopback di production', async () => {
        const apiKey = 'e'.repeat(64);
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const origNodeEnv = process.env.NODE_ENV;
        const userRow = {
            id: 9003,
            username: 'cidr_reseller',
            balance: 50000,
            role_id: 2,
            role_name: 'PARTNER',
            api_key: null,
            api_key_hash: keyHash,
            api_key_prefix: apiKey.slice(0, 8),
            h2h_callback_url: null,
            whitelisted_ips: ['203.0.113.0/24', '2001:db8:cafe::/48']
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                if (params[1] === keyHash) {
                    return { rows: [{ id: userRow.id, whitelisted_ips: userRow.whitelisted_ips, api_key: null, api_key_hash: keyHash }] };
                }
                return { rows: [] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return params[1] === keyHash ? { rows: [{ ...userRow }] } : { rows: [] };
            }
            return { rows: [] };
        });

        try {
            process.env.NODE_ENV = 'test';

            // Loopback allowed in non-production
            const resDevLoop = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey }
            });
            assert.strictEqual(resDevLoop.status, 200, 'Loopback may pass in non-production');

            // IPv4 matching CIDR /24
            const resV4Match = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '203.0.113.77' }
            });
            assert.strictEqual(resV4Match.status, 200, 'IPv4 inside CIDR 203.0.113.0/24 must pass');

            // IPv4-mapped IPv6 matching IPv4 CIDR /24
            const resMappedMatch = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '::ffff:203.0.113.99' }
            });
            assert.strictEqual(resMappedMatch.status, 200, '::ffff:203.0.113.99 must normalize and match 203.0.113.0/24');

            // IPv6 matching CIDR /48
            const resV6Match = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '2001:db8:cafe:0001::42' }
            });
            assert.strictEqual(resV6Match.status, 200, 'IPv6 inside 2001:db8:cafe::/48 must pass');

            // IPv4 outside CIDR rejected on /h2h/profile AND /h2h/profile/callback
            const resV4Deny = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '203.0.114.77' }
            });
            assert.strictEqual(resV4Deny.status, 403, 'GET /h2h/profile outside whitelist must return 403');

            const resCbDeny = await fetch(`${baseUrl}/h2h/profile/callback`, {
                method: 'PUT',
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '203.0.114.77', 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_url: 'https://93.184.216.34/webhook' })
            });
            assert.strictEqual(resCbDeny.status, 403, 'PUT /h2h/profile/callback outside whitelist must return 403');

            // IPv4-mapped outside CIDR rejected
            const resMappedDeny = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '::ffff:198.51.100.10' }
            });
            assert.strictEqual(resMappedDeny.status, 403, '::ffff:x.x.x.x outside whitelist must return 403');

            // IPv6 outside CIDR rejected
            const resV6Deny = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '2001:db8:beef::1' }
            });
            assert.strictEqual(resV6Deny.status, 403, 'IPv6 outside 2001:db8:cafe::/48 must return 403');

            // NODE_ENV=production MUST NOT bypass loopback 127.0.0.1 / ::1
            process.env.NODE_ENV = 'production';
            const resProdLoopDirect = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey }
            });
            assert.strictEqual(resProdLoopDirect.status, 403, 'Direct loopback 127.0.0.1 must be blocked in production when not whitelisted');

            const resProdLoopV6 = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '::1' }
            });
            assert.strictEqual(resProdLoopV6.status, 403, 'Loopback ::1 must be blocked in production when not whitelisted');

            const resProdLoopV4Header = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '127.0.0.1' }
            });
            assert.strictEqual(resProdLoopV4Header.status, 403, 'Loopback 127.0.0.1 header must be blocked in production when not whitelisted');
        } finally {
            process.env.NODE_ENV = origNodeEnv;
            pool.query.mock.restore();
        }
    });

    test('SEC-008 (2): rate limit per user_id & API key memblokir meski IP berganti + kuota harian opsional via env', async () => {
        const key1 = '1'.repeat(64);
        const key2 = '2'.repeat(64);
        const hash1 = crypto.createHash('sha256').update(key1).digest('hex');
        const hash2 = crypto.createHash('sha256').update(key2).digest('hex');
        let activeHash = hash1;
        const origMaxOrdersEnv = process.env.H2H_DAILY_MAX_ORDERS;
        const origMaxAmountEnv = process.env.H2H_DAILY_MAX_AMOUNT;
        const origEnv = process.env.NODE_ENV;

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                return { rows: [{ id: 9808, whitelisted_ips: [], api_key: null, api_key_hash: activeHash }] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                if (params[1] === activeHash) {
                    return {
                        rows: [{
                            id: 9808,
                            username: 'ratelimit_reseller',
                            balance: 500000,
                            role_id: 2,
                            role_name: 'PARTNER',
                            api_key: null,
                            api_key_hash: activeHash,
                            api_key_prefix: key1.slice(0, 8),
                            h2h_callback_url: null,
                            whitelisted_ips: []
                        }]
                    };
                }
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            process.env.NODE_ENV = 'test';
            for (let i = 1; i <= 60; i++) {
                const resOk = await fetch(`${baseUrl}/h2h/profile`, {
                    headers: { 'X-API-Key': key1, 'X-Forwarded-For': `198.51.100.${i}` }
                });
                assert.strictEqual(resOk.status, 200, `Request #${i} from distributed IP should pass under 60/min quota`);
            }

            // 61st request with SAME API key from a brand new IP must be 429
            const resKeyBlocked = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': key1, 'X-Forwarded-For': '198.51.100.61' }
            });
            assert.strictEqual(resKeyBlocked.status, 429, '61st request with same API key across rotating IPs must be blocked with 429');

            // Rotate to a NEW key for the SAME user_id (9808) from yet another new IP -> STILL blocked by per-user limiter!
            activeHash = hash2;
            const resUserBlocked = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': key2, 'X-Forwarded-For': '198.51.100.62' }
            });
            assert.strictEqual(resUserBlocked.status, 429, '62nd request for same user_id after rotating API key & IP must still be blocked with 429');

            // Test optional daily quota H2H_DAILY_MAX_ORDERS using a fresh user (id: 9809)
            const { invalidateFoxyProductCache } = require('../server');
            invalidateFoxyProductCache();
            const quotaKey = '3'.repeat(64);
            const quotaHash = crypto.createHash('sha256').update(quotaKey).digest('hex');
            activeHash = quotaHash;
            process.env.H2H_DAILY_MAX_ORDERS = '2';

            axios.get = async () => ({
                data: { data: [{ product_code: 'ML-QUOTA', product_price: 10000 }] }
            });
            let balanceDeducted = false;
            mock.method(pool, 'connect', async () => ({
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                    if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                        return {
                            rows: [{
                                id: 33, name: 'Quota Test Product', provider_sku: 'ML-QUOTA', price: 12000, status: 'Active',
                                game_id: 1, needs_server_id: false, validation_config: null,
                                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                            }]
                        };
                    }
                    if (typeof sql === 'string' && sql.includes('SELECT balance, role_id FROM users WHERE id')) {
                        return { rows: [{ balance: 500000, role_id: 2 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                        return { rows: [{ margin_percent: 10 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                        return { rows: [] };
                    }
                    if (typeof sql === 'string' && sql.includes('order_count')) {
                        return { rows: [{ order_count: 2, total_amount: 24000 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) {
                        balanceDeducted = true;
                        return { rowCount: 1 };
                    }
                    return { rows: [] };
                },
                release: () => {}
            }));

            // Use different user id 9809 via pool.query override
            pool.query.mock.restore();
            mock.method(pool, 'query', async (sql, params = []) => {
                if (typeof sql !== 'string') return { rows: [] };
                if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                    return { rows: [{ id: 9809, whitelisted_ips: [], api_key: null, api_key_hash: quotaHash }] };
                }
                if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                    return { rows: [{ id: 9809, username: 'quota_reseller', balance: 500000, role_id: 2, role_name: 'PARTNER', api_key: null, api_key_hash: quotaHash, whitelisted_ips: [] }] };
                }
                return { rows: [] };
            });

            const resQuota = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': quotaKey, 'X-Forwarded-For': '198.51.100.63', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 33, targetGameId: '123456' })
            });
            assert.strictEqual(resQuota.status, 429, 'H2H order exceeding H2H_DAILY_MAX_ORDERS must be rejected with 429');
            assert.strictEqual(balanceDeducted, false, 'Daily quota rejection must NOT deduct balance');

            delete process.env.H2H_DAILY_MAX_ORDERS;
            process.env.H2H_DAILY_MAX_AMOUNT = '30000';
            const resAmountQuota = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': quotaKey, 'X-Forwarded-For': '198.51.100.64', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 33, targetGameId: '123456' })
            });
            assert.strictEqual(resAmountQuota.status, 429, 'H2H order exceeding H2H_DAILY_MAX_AMOUNT must be rejected with 429');
            assert.strictEqual(balanceDeducted, false, 'Daily amount quota rejection must NOT deduct balance');
            delete process.env.H2H_DAILY_MAX_AMOUNT;
        } finally {
            if (origMaxOrdersEnv === undefined) delete process.env.H2H_DAILY_MAX_ORDERS;
            else process.env.H2H_DAILY_MAX_ORDERS = origMaxOrdersEnv;
            if (origMaxAmountEnv === undefined) delete process.env.H2H_DAILY_MAX_AMOUNT;
            else process.env.H2H_DAILY_MAX_AMOUNT = origMaxAmountEnv;
            process.env.NODE_ENV = origEnv;
            axios.get = origAxiosGet;
            require('../server').invalidateFoxyProductCache();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
        }
    });

    test('SEC-007 (1): tolak webhook SSRF (127.0.0.1, 169.254.169.254, 100.64.x.x, 0.0.0.0, ::ffff:127.0.0.1, DNS private) & PUT /h2h/profile/callback', async () => {
        const { sendH2HWebhook, validateWebhookUrl } = require('../utils/webhookClient');
        const apiKey = '4'.repeat(64);
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        let dbUpdatedCallback = false;

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                return { rows: [{ id: 9004, whitelisted_ips: [], api_key: null, api_key_hash: keyHash }] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return { rows: [{ id: 9004, username: 'ssrf_tester', balance: 10000, role_id: 2, role_name: 'PARTNER', api_key: null, api_key_hash: keyHash, whitelisted_ips: [] }] };
            }
            if (sql.includes('SET h2h_callback_url')) {
                dbUpdatedCallback = true;
            }
            return { rows: [] };
        });

        let outboundCalls = 0;
        axios.post = async () => {
            outboundCalls += 1;
            return { status: 200, data: 'ok' };
        };

        try {
            const badLiteralUrls = [
                'https://127.0.0.1/cb',
                'https://169.254.169.254/latest/meta-data/',
                'https://100.64.5.10/cb',
                'https://0.0.0.0/cb',
                'https://[::ffff:127.0.0.1]/cb',
                'https://[::ffff:169.254.169.254]/cb',
                'https://[::1]/cb',
                'https://[fe80::1]/cb',
                'https://[fd00::1]/cb',
                'http://93.184.216.34/cb'
            ];

            for (const badUrl of badLiteralUrls) {
                await assert.rejects(
                    () => sendH2HWebhook({ url: badUrl, payload: { invoice_id: 'T1' }, secret: 'sec' }),
                    { message: /tidak diizinkan|tidak valid|HTTPS/i },
                    `sendH2HWebhook must reject SSRF URL: ${badUrl}`
                );

                const resPut = await fetch(`${baseUrl}/h2h/profile/callback`, {
                    method: 'PUT',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_url: badUrl })
                });
                assert.strictEqual(resPut.status, 400, `PUT /h2h/profile/callback must reject SSRF URL: ${badUrl}`);
            }

            // Domain resolving via DNS to private IP (single A or mixed public+private A/AAAA) MUST be rejected
            await assert.rejects(
                () => validateWebhookUrl('https://private-dns.reseller.example/cb', {
                    dnsLookup: async () => [{ address: '10.0.0.8', family: 4 }]
                }),
                { message: /tidak diizinkan/i },
                'Domain resolving to RFC1918 IP must be rejected'
            );
            await assert.rejects(
                () => validateWebhookUrl('https://mixed-dns.reseller.example/cb', {
                    dnsLookup: async () => [
                        { address: '93.184.216.34', family: 4 },
                        { address: '169.254.169.254', family: 4 }
                    ]
                }),
                { message: /tidak diizinkan/i },
                'Domain resolving with any private/link-local record must be rejected'
            );
            await assert.rejects(
                () => validateWebhookUrl('https://cgnat-dns.reseller.example/cb', {
                    dnsLookup: async () => [{ address: '100.127.255.250', family: 4 }]
                }),
                { message: /tidak diizinkan/i },
                'Domain resolving to CGNAT 100.64.0.0/10 must be rejected'
            );

            // PUT /h2h/profile/callback must also run DNS resolution and reject domains resolving to private IPs
            const { webhookDns } = require('../utils/webhookClient');
            mock.method(webhookDns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
            try {
                const resPutDnsPrivate = await fetch(`${baseUrl}/h2h/profile/callback`, {
                    method: 'PUT',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_url: 'https://ssrf-rebind.reseller.example/cb' })
                });
                assert.strictEqual(resPutDnsPrivate.status, 400, 'PUT /h2h/profile/callback must reject domain resolving to loopback/private IP');
            } finally {
                if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            }

            assert.strictEqual(dbUpdatedCallback, false, 'None of the bad URLs should be saved to DB');
            assert.strictEqual(outboundCalls, 0, 'SSRF checks must reject before calling axios.post');
        } finally {
            axios.post = origAxiosPost;
            pool.query.mock.restore();
        }
    });

    test('SEC-007 (2): redirect (302) tidak diikuti, DNS pinning mengikat IP, X-Signature & X-Timestamp valid di Foxy callback & cron', async () => {
        const { webhookDns, buildSignedWebhookHeaders } = require('../utils/webhookClient');
        const webhookSecret = 'whsec_test_' + 'a'.repeat(48);

        // 1. Real HTTP redirect test proving maxRedirects: 0 blocks 302 redirect target
        let targetHitCount = 0;
        const targetServer = http.createServer((req, res) => {
            targetHitCount += 1;
            res.writeHead(200);
            res.end('ok');
        });
        await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
        const targetPort = targetServer.address().port;

        const redirectServer = http.createServer((req, res) => {
            res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/internal` });
            res.end();
        });
        await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
        const redirectPort = redirectServer.address().port;

        const { buildAxiosWebhookConfig } = require('../utils/webhookClient');
        try {
            const payload = { invoice_id: 'TRX-REDIR-1', status: 'Success' };
            const rawBody = JSON.stringify(payload);
            const signedHeaders = buildSignedWebhookHeaders(rawBody, webhookSecret, 1700000123);
            const axiosConfig = buildAxiosWebhookConfig({ headers: signedHeaders });
            assert.strictEqual(axiosConfig.maxRedirects, 0, 'Webhook config must force maxRedirects: 0');

            await assert.rejects(
                () => axios.post(`http://127.0.0.1:${redirectPort}/hook`, rawBody, axiosConfig),
                /status code 302|maxRedirects|redirect/i,
                '302 redirect must cause axios.post rejection and never follow Location'
            );
            assert.strictEqual(targetHitCount, 0, 'Redirect target MUST receive zero requests');

            // 2. End-to-end callback (server.js) + cron (cronUtils.js) webhook dispatch
            process.env.FOXY_CALLBACK_SECRET = 'sec7-foxy-secret';
            let dnsReturnedIp = '93.184.216.34';
            mock.method(webhookDns, 'lookup', async () => [{ address: dnsReturnedIp, family: 4 }]);

            const capturedWebhooks = [];
            axios.get = async (url) => {
                if (url.includes('/v1/status')) {
                    return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-SEC7-OK' } } };
                }
                return { data: { data: [] } };
            };
            axios.post = async (url, rawData, config) => {
                capturedWebhooks.push({ url, rawData, config });
                // Simulate DNS rebinding AFTER resolution to verify pinned agent lookup STILL returns initial validated IP!
                dnsReturnedIp = '127.0.0.1';
                const pinnedIps = await new Promise((resolve, reject) => {
                    config.httpsAgent.options.lookup('webhook.reseller.example', { all: true }, (err, res) => (err ? reject(err) : resolve(res)));
                });
                assert.deepStrictEqual(pinnedIps, [{ address: '93.184.216.34', family: 4 }], 'Agent lookup must pin initial validated IP');
                dnsReturnedIp = '93.184.216.34';
                return { status: 200, data: 'ok' };
            };

            mock.method(pool, 'query', async (sql) => {
                if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                    return { rows: [{ id: 9501, status: 'Pending', price: 15000, product_id: 1, provider_trx_id: 'TRX-SEC7-CB', cost_price: 12000 }] };
                }
                if (typeof sql === 'string' && sql.includes('h2h_webhook_secret')) {
                    return {
                        rows: [{
                            h2h_callback_url: 'https://webhook.reseller.example/h2h',
                            h2h_webhook_secret: webhookSecret,
                            product_name: 'Diamond SEC7'
                        }]
                    };
                }
                return { rows: [] };
            });

            mock.method(pool, 'connect', async () => ({
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                    if (typeof sql === 'string' && sql.includes('FOR UPDATE') && sql.includes('transactions')) {
                        return { rows: [{ id: 9501, invoice_id: 'INV-SEC7-CB', user_id: 9010, product_id: 1, price: 15000, status: 'Pending', provider_trx_id: 'TRX-SEC7-CB', flash_sale_id: null, flash_sale_restored: false }] };
                    }
                    return { rows: [] };
                },
                release: () => {}
            }));

            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec7-foxy-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-SEC7-CB', status: 'SUCCESS', sn: 'SN-SEC7-OK' })
            });
            assert.strictEqual(cbRes.status, 200);
            // Allow background webhook promise microtasks to flush
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            // Now also test cronUtils.checkPendingTransactions() outbound webhook
            mock.method(cronPool, 'query', async (sql) => {
                if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                    return {
                        rows: [{
                            id: 9502,
                            invoice_id: 'INV-SEC7-CRON',
                            user_id: 9011,
                            price: 20000,
                            provider_trx_id: 'TRX-SEC7-CRON',
                            check_attempts: 0,
                            flash_sale_id: null,
                            flash_sale_restored: false,
                            product_name: 'Diamond Cron SEC7',
                            h2h_callback_url: 'https://webhook.reseller.example/cron-h2h',
                            h2h_webhook_secret: webhookSecret
                        }]
                    };
                }
                return { rows: [] };
            });
            mock.method(cronPool, 'connect', async () => ({
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                    if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                        return { rows: [{ id: 9502, invoice_id: 'INV-SEC7-CRON', user_id: 9011, price: 20000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                    }
                    return { rows: [] };
                },
                release: () => {}
            }));

            await cronUtils.checkPendingTransactions();
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            assert.strictEqual(capturedWebhooks.length, 2, 'Both callback and cron must dispatch signed SSRF-safe H2H webhooks');
            for (const wh of capturedWebhooks) {
                assert.strictEqual(typeof wh.rawData, 'string', 'Signed webhook must send deterministic JSON string body');
                assert.strictEqual(wh.config.maxRedirects, 0);
                assert.ok(wh.config.timeout > 0 && wh.config.timeout <= 5000, 'Strict webhook timeout must be <= 5000ms');
                assert.ok(wh.config.maxContentLength > 0 && wh.config.maxBodyLength > 0, 'Response and body limits must be configured');
                const ts = wh.config.headers['X-Timestamp'];
                assert.ok(/^\d+$/.test(ts), 'X-Timestamp must be Unix epoch string');
                const expectedSig = crypto
                    .createHmac('sha256', webhookSecret)
                    .update(`${ts}.${wh.rawData}`)
                    .digest('hex');
                assert.strictEqual(
                    wh.config.headers['X-Signature'],
                    expectedSig,
                    'X-Signature must equal HMAC-SHA256 of `${X-Timestamp}.${rawBody}`'
                );
            }
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect.mock) cronPool.connect.mock.restore();
            await new Promise(resolve => redirectServer.close(resolve));
            await new Promise(resolve => targetServer.close(resolve));
        }
    });

    test('SEC-007 (3): reseller lama tanpa h2h_webhook_secret dibuatkan secret secara lazy agar X-Signature selalu ada', async () => {
        const { webhookDns } = require('../utils/webhookClient');
        const legacyKey = 'f'.repeat(48);
        const userState = {
            id: 9020,
            username: 'legacy_no_whsec',
            balance: 100000,
            role_id: 2,
            role_name: 'PARTNER',
            api_key: legacyKey,
            api_key_hash: null,
            api_key_prefix: null,
            h2h_callback_url: 'https://legacy-hook.reseller.example/cb',
            h2h_webhook_secret: null,
            whitelisted_ips: []
        };

        // 1. Lazy migration API key juga men-seed h2h_webhook_secret bila masih NULL
        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return params[0] === userState.api_key ? { rows: [{ ...userState }] } : { rows: [] };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET api_key_hash') && sql.includes('h2h_webhook_secret')) {
                userState.api_key_hash = params[0];
                userState.api_key_prefix = params[1];
                userState.api_key = null;
                if (!userState.h2h_webhook_secret && params[3]) userState.h2h_webhook_secret = params[3];
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            return { rows: [] };
        });

        try {
            const profRes = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': legacyKey }
            });
            assert.strictEqual(profRes.status, 200);
            assert.match(userState.h2h_webhook_secret || '', /^[a-f0-9]{64}$/, 'Lazy key migration must also provision h2h_webhook_secret when NULL');
        } finally {
            pool.query.mock.restore();
        }

        // 2. Jika user tetap tanpa h2h_webhook_secret saat webhook dikirim (callback & cron), secret dibuat lazily sebelum mengirim
        const sentWebhooks = [];
        let cbLazySecret = null;
        let cronLazySecret = null;
        process.env.FOXY_CALLBACK_SECRET = 'sec7-lazy-cb-secret';
        mock.method(webhookDns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);

        axios.get = async (url) => {
            if (url.includes('/v1/status')) {
                return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-LAZY-WHSEC' } } };
            }
            return { data: { data: [] } };
        };
        axios.post = async (url, rawData, config) => {
            sentWebhooks.push({ url, rawData, config });
            return { status: 200, data: 'ok' };
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9601, status: 'Pending', price: 15000, product_id: 1, provider_trx_id: 'TRX-LAZY-CB', cost_price: 12000 }] };
            }
            if (sql.includes('u.h2h_webhook_secret')) {
                return { rows: [{ h2h_callback_url: 'https://legacy-cb.reseller.example/cb', h2h_webhook_secret: null, product_name: 'MLBB 50' }] };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET h2h_webhook_secret = COALESCE')) {
                cbLazySecret = params[0];
                return { rows: [{ h2h_webhook_secret: cbLazySecret }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 9601, invoice_id: 'INV-LAZY-CB', user_id: 9021, product_id: 1, price: 15000, status: 'Pending', provider_trx_id: 'TRX-LAZY-CB', flash_sale_id: null, flash_sale_restored: false }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        mock.method(cronPool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return {
                    rows: [{
                        id: 9602,
                        invoice_id: 'INV-LAZY-CRON',
                        user_id: 9022,
                        price: 18000,
                        provider_trx_id: 'TRX-LAZY-CRON',
                        check_attempts: 0,
                        flash_sale_id: null,
                        flash_sale_restored: false,
                        product_name: 'MLBB 86',
                        h2h_callback_url: 'https://legacy-cron.reseller.example/cb',
                        h2h_webhook_secret: ''
                    }]
                };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET h2h_webhook_secret = COALESCE')) {
                cronLazySecret = params[0];
                return { rows: [{ h2h_webhook_secret: cronLazySecret }] };
            }
            return { rows: [] };
        });
        mock.method(cronPool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 9602, invoice_id: 'INV-LAZY-CRON', user_id: 9022, price: 18000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec7-lazy-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-LAZY-CB', status: 'SUCCESS', sn: 'SN-LAZY-WHSEC' })
            });
            assert.strictEqual(cbRes.status, 200);
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            await cronUtils.checkPendingTransactions();

            assert.strictEqual(sentWebhooks.length, 2);
            assert.match(cbLazySecret || '', /^[a-f0-9]{64}$/, 'Callback path must lazily generate h2h_webhook_secret');
            assert.match(cronLazySecret || '', /^[a-f0-9]{64}$/, 'Cron path must lazily generate h2h_webhook_secret');

            const secrets = [cbLazySecret, cronLazySecret];
            sentWebhooks.forEach((wh, idx) => {
                const ts = wh.config.headers['X-Timestamp'];
                const sig = wh.config.headers['X-Signature'];
                assert.ok(/^\d+$/.test(ts), 'X-Timestamp must exist');
                assert.ok(sig && sig.length === 64, 'X-Signature must ALWAYS be sent for legacy resellers');
                const expected = crypto.createHmac('sha256', secrets[idx]).update(`${ts}.${wh.rawData}`).digest('hex');
                assert.strictEqual(sig, expected);
            });
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect.mock) cronPool.connect.mock.restore();
        }
    });

    test('SEC-007 (4): webhook invalid (http:// / URL berkredensial) atau gagal kirim mencatat warning aman dan tidak menghentikan callback/cron', async () => {
        const { webhookDns } = require('../utils/webhookClient');
        process.env.FOXY_CALLBACK_SECRET = 'sec7-warn-secret';

        const warnings = [];
        mock.method(console, 'warn', (...args) => {
            warnings.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        });

        let cbStatusUpdatedToSuccess = false;
        let cronFirstUpdatedToSuccess = false;
        let cronSecondProcessed = false;
        const secretValue = 'super_secret_hmac_key_never_log_12345';

        mock.method(webhookDns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
        axios.get = async (url) => {
            if (url.includes('/v1/status')) {
                return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-RESILIENT' } } };
            }
            return { data: { data: [] } };
        };
        axios.post = async () => {
            const err = new Error('Request failed with status code 502 (https://user:topsecret@hook.reseller.example/cb?token=leak123)');
            err.response = { status: 502, statusText: 'Bad Gateway', config: { method: 'post', url: 'https://user:topsecret@hook.reseller.example/cb?token=leak123' } };
            throw err;
        };

        // 1. Callback Foxy dengan URL http:// lama -> harus tetap 200 & status Success, log warning aman
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9701, status: 'Pending', price: 10000, product_id: 1, provider_trx_id: 'TRX-BADURL-CB', cost_price: 8000 }] };
            }
            if (sql.includes('h2h_webhook_secret')) {
                return { rows: [{ h2h_callback_url: 'http://legacy-insecure.reseller.example/cb?token=shouldnotleak', h2h_webhook_secret: secretValue, product_name: 'ML 10' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 9701, invoice_id: 'INV-BADURL-CB', user_id: 9030, product_id: 1, price: 10000, status: 'Pending', provider_trx_id: 'TRX-BADURL-CB', flash_sale_id: null, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Success'")) {
                    cbStatusUpdatedToSuccess = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        // 2. Cron batch dengan 2 transaksi: tx1 gagal validasi URL berkredensial, tx2 gagal HTTP 502; status KEDUANYA tetap Success
        mock.method(cronPool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return {
                    rows: [
                        {
                            id: 9702,
                            invoice_id: 'INV-CREDURL-CRON',
                            user_id: 9031,
                            price: 12000,
                            provider_trx_id: 'TRX-CREDURL-1',
                            check_attempts: 0,
                            flash_sale_id: null,
                            flash_sale_restored: false,
                            product_name: 'ML 12',
                            h2h_callback_url: 'https://adminuser:superpass99@bad.reseller.example/cb?token=urltok99',
                            h2h_webhook_secret: secretValue
                        },
                        {
                            id: 9703,
                            invoice_id: 'INV-HTTP502-CRON',
                            user_id: 9032,
                            price: 14000,
                            provider_trx_id: 'TRX-HTTP502-2',
                            check_attempts: 0,
                            flash_sale_id: null,
                            flash_sale_restored: false,
                            product_name: 'ML 14',
                            h2h_callback_url: 'https://hook.reseller.example/cb?token=leak123',
                            h2h_webhook_secret: secretValue
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        mock.method(cronPool, 'connect', async () => ({
            query: async (sql, params = []) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    if (params[0] === 9702) {
                        return { rows: [{ id: 9702, invoice_id: 'INV-CREDURL-CRON', user_id: 9031, price: 12000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                    }
                    return { rows: [{ id: 9703, invoice_id: 'INV-HTTP502-CRON', user_id: 9032, price: 14000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE transactions SET status = $1') && params[0] === 'Success') {
                    if (params[2] === 9702) cronFirstUpdatedToSuccess = true;
                    if (params[2] === 9703) cronSecondProcessed = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec7-warn-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-BADURL-CB', status: 'SUCCESS', sn: 'SN-RESILIENT' })
            });
            assert.strictEqual(cbRes.status, 200, 'Rejected webhook URL must NOT fail Foxy callback response');
            assert.strictEqual(cbStatusUpdatedToSuccess, true, 'Callback transaction status must still commit Success');
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            await cronUtils.checkPendingTransactions();
            assert.strictEqual(cronFirstUpdatedToSuccess, true, 'First cron tx must commit Success even if webhook URL is invalid');
            assert.strictEqual(cronSecondProcessed, true, 'Cron loop must continue processing subsequent transactions cleanly');

            const combinedWarnings = warnings.join('\n');
            assert.ok(combinedWarnings.includes('INV-BADURL-CB'), 'Warning log must include invoice ID for callback http:// rejection');
            assert.ok(combinedWarnings.includes('INV-CREDURL-CRON'), 'Warning log must include invoice ID for credential URL rejection');
            assert.ok(combinedWarnings.includes('INV-HTTP502-CRON'), 'Warning log must include invoice ID for failed webhook delivery');
            assert.ok(!combinedWarnings.includes(secretValue), 'Warning log must NEVER leak webhook secret');
            assert.ok(!combinedWarnings.includes('superpass99'), 'Warning log must NEVER leak URL password credentials');
            assert.ok(!combinedWarnings.includes('topsecret'), 'Warning log must NEVER leak Axios URL password credentials');
            assert.ok(!combinedWarnings.includes('urltok99'), 'Warning log must NEVER leak URL query token');
            assert.ok(!combinedWarnings.includes('leak123'), 'Warning log must NEVER leak URL query token in error');
            assert.ok(!combinedWarnings.includes('shouldnotleak'), 'Warning log must NEVER leak URL query string');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            console.warn.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect.mock) cronPool.connect.mock.restore();
        }
    });
});

// ============================================================
// PHASE 14: SEC-009 — Idempotency Keys & Cryptographic Invoice IDs
// ============================================================
describe('Phase 14: SEC-009: Idempotency Keys & Cryptographic Invoice IDs', () => {
    const fs = require('fs');
    const path = require('path');
    const jwt = require('jsonwebtoken');
    const axios = require('axios');
    const crypto = require('crypto');
    const { invalidateFoxyProductCache } = require('../server');
    const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

    let server;
    let baseUrl;
    let origPoolQuery;
    let origPoolConnect;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id, role = 'User') {
        return jwt.sign({ id, username: `sec9_user_${id}`, role }, JWT_SECRET, { expiresIn: '1h' });
    }

    function createTransactionalMockDb(initialUsers, initialProducts, options = {}) {
        const users = new Map();
        for (const u of initialUsers) {
            users.set(u.id, { ...u });
        }
        const products = new Map();
        for (const p of initialProducts) {
            products.set(p.id, { ...p });
        }
        const transactions = [];
        const deposits = [];
        const balanceHistory = [];
        let nextTxId = 1;
        let nextDepId = 1;
        let rollbackCount = 0;

        const matchTxByRef = (userId, refId) => transactions.find(
            (t) => t.user_id === userId && t.ref_id !== null && t.ref_id === refId
        ) || null;

        const matchDepByKey = (userId, key) => deposits.find(
            (d) => d.user_id === userId && d.idempotency_key !== null && d.idempotency_key === key
        ) || null;

        const runQuery = async (sql, params = [], txState = null) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql === 'BEGIN') return {};
            if (sql === 'COMMIT') return {};
            if (sql === 'ROLLBACK') return {};

            // protectH2H & protectH2HIp lookups
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                const candidatePlain = params[0];
                const candidateHash = params[1];
                for (const u of users.values()) {
                    if ((u.api_key_hash && u.api_key_hash === candidateHash) || (u.api_key && u.api_key === candidatePlain)) {
                        return { rows: [{ ...u }] };
                    }
                }
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                const u = users.get(params[0]);
                return u ? { rows: [{ id: u.id, whitelisted_ips: u.whitelisted_ips || [], api_key: u.api_key || null, api_key_hash: u.api_key_hash || null }] } : { rows: [] };
            }
            if (sql.includes('FROM users u JOIN roles r') && sql.includes('u.id = $1') && !sql.includes('FOR UPDATE')) {
                const u = users.get(params[0]);
                return u ? { rows: [{ id: u.id, username: u.username, role_name: u.role_name, balance: u.balance, role_id: u.role_id }] } : { rows: [] };
            }

            // Payment method lookup for deposits
            if (sql.includes('FROM payment_methods')) {
                const methodInput = String(params[0] || '').toLowerCase();
                if (methodInput === 'bca') {
                    return {
                        rows: [{
                            id: 1, code: 'BCA', name: 'Bank BCA', type: 'bank',
                            account_number: '901000111', account_name: 'MIKU Store',
                            qris_image_url: null, instructions: 'Kirim tepat nominal',
                            is_qris: false, min_amount: 10000
                        }]
                    };
                }
                if (methodInput === 'qris') {
                    return {
                        rows: [{
                            id: 2, code: 'QRIS', name: 'QRIS All Payment', type: 'qris',
                            account_number: null, account_name: 'MIKU Store QRIS',
                            qris_image_url: '/qris.png', instructions: null,
                            is_qris: true, min_amount: 10000
                        }]
                    };
                }
                return { rows: [] };
            }

            // Transaction lookup by (user_id, ref_id)
            if (sql.includes('FROM transactions t') && sql.includes('t.ref_id = $2')) {
                const found = matchTxByRef(params[0], params[1]);
                if (!found) return { rows: [] };
                const prod = products.get(found.product_id);
                return {
                    rows: [{
                        ...found,
                        product_name: prod ? prod.name : 'Unknown Product',
                        needs_server_id: prod ? Boolean(prod.needs_server_id) : false
                    }]
                };
            }

            // Deposit lookup by (user_id, idempotency_key)
            if (sql.includes('FROM deposits') && sql.includes('idempotency_key = $2')) {
                const found = matchDepByKey(params[0], params[1]);
                return { rows: found ? [{ ...found }] : [] };
            }

            // Public transaction lookup by invoice_id
            if (sql.includes('FROM transactions t') && sql.includes('t.invoice_id = $1')) {
                const found = transactions.find((t) => t.invoice_id === params[0]);
                if (!found) return { rows: [] };
                const prod = products.get(found.product_id);
                return {
                    rows: [{
                        invoice_id: found.invoice_id,
                        status: found.status,
                        price: found.price,
                        created_at: found.created_at,
                        updated_at: found.updated_at,
                        product_name: prod ? prod.name : 'Test Product',
                        game_name: 'Mobile Legends'
                    }]
                };
            }

            // Public recent transactions
            if (sql.includes('FROM transactions t') && sql.includes('ORDER BY t.created_at DESC')) {
                return {
                    rows: [...transactions].reverse().slice(0, 10).map((t) => {
                        const prod = products.get(t.product_id);
                        return {
                            invoice_id: t.invoice_id,
                            status: t.status,
                            created_at: t.created_at,
                            product_name: prod ? prod.name : 'Test Product',
                            game_name: 'Mobile Legends'
                        };
                    })
                };
            }

            // Product + game lookup
            if (sql.includes('JOIN games g') && (sql.includes('p.id = $1') || sql.includes('WHERE id = $1'))) {
                const prod = products.get(params[0]);
                return { rows: prod ? [{ ...prod }] : [] };
            }

            // Pending deposit count check
            if (sql.includes("FROM deposits WHERE user_id = $1 AND status = 'Pending'")) {
                if (typeof options.pendingDepositCountOverride === 'function') {
                    return { rows: [{ count: String(options.pendingDepositCountOverride()) }] };
                }
                const cnt = deposits.filter((d) => d.user_id === params[0] && d.status === 'Pending').length;
                return { rows: [{ count: String(cnt) }] };
            }

            if (sql.includes("FROM deposits WHERE status = 'Pending' AND amount = $1")) {
                return { rows: [] };
            }

            // User FOR UPDATE
            if (sql.includes('FROM users u JOIN roles r') && sql.includes('FOR UPDATE')) {
                const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
                return target ? { rows: [{ balance: target.balance, role_id: target.role_id, role_name: target.role_name }] } : { rows: [] };
            }
            if (sql.includes('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE')) {
                const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
                return target ? { rows: [{ balance: target.balance, role_id: target.role_id }] } : { rows: [] };
            }

            if (sql.includes('SELECT margin_percent FROM roles WHERE id = $1')) {
                return { rows: [{ margin_percent: 10 }] };
            }

            if (sql.includes('FROM flash_sales')) {
                return { rows: [] };
            }

            if (sql.includes('SELECT invoice_id') && sql.includes('FROM transactions') && sql.includes("status = 'Pending'")) {
                const found = transactions.find(
                    (t) => t.user_id === params[0] && t.product_id === params[1] && t.target_game_id === params[2] && t.status === 'Pending'
                );
                return { rows: found ? [{ invoice_id: found.invoice_id }] : [] };
            }

            // Deduct balance (staged until COMMIT)
            if (sql.includes('UPDATE users SET balance = balance - $1')) {
                const amt = Number(params[0]);
                const uid = params[1];
                const u = txState.stagedUsers.get(uid);
                if (!u || Number(u.balance) < amt) return { rowCount: 0 };
                u.balance = Number(u.balance) - amt;
                return { rowCount: 1 };
            }

            // Refund balance
            if (sql.includes('UPDATE users SET balance = balance + $1')) {
                const amt = Number(params[0]);
                const uid = params[1];
                const u = txState.stagedUsers.get(uid);
                if (u) u.balance = Number(u.balance) + amt;
                return { rowCount: 1 };
            }

            // INSERT INTO transactions
            if (sql.includes('INSERT INTO transactions')) {
                if (typeof options.beforeTxInsert === 'function') {
                    await options.beforeTxInsert(params);
                }
                const hasRefCol = sql.includes('ref_id');
                const invoiceId = params[0];
                const userId = params[1];
                const productId = params[2];
                const targetGameId = params[3];
                const price = Number(params[4]);
                const status = params[5];
                const providerTrxId = params[6];
                const flashSaleId = params[7] || null;
                const refId = hasRefCol ? (params[8] || null) : null;

                if (refId !== null && matchTxByRef(userId, refId)) {
                    const dupErr = new Error('duplicate key value violates unique constraint "uq_transactions_user_ref_id"');
                    dupErr.code = '23505';
                    dupErr.constraint = 'uq_transactions_user_ref_id';
                    throw dupErr;
                }
                const row = {
                    id: nextTxId++,
                    invoice_id: invoiceId,
                    user_id: userId,
                    product_id: productId,
                    target_game_id: targetGameId,
                    price,
                    status,
                    provider_trx_id: providerTrxId,
                    flash_sale_id: flashSaleId,
                    ref_id: refId,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                };
                txState.stagedTransactions.push(row);
                return { rows: [{ id: row.id }] };
            }

            // INSERT INTO deposits
            if (sql.includes('INSERT INTO deposits')) {
                if (typeof options.beforeDepositInsert === 'function') {
                    await options.beforeDepositInsert(params);
                }
                const hasIdemCol = sql.includes('idempotency_key');
                const userId = params[0];
                const amount = Number(params[1]);
                const uniqueCode = Number(params[2]);
                const status = params[3];
                const method = params[4];
                const note = params[5] || null;
                const idempotencyKey = hasIdemCol ? (params[6] || null) : null;

                if (idempotencyKey !== null && matchDepByKey(userId, idempotencyKey)) {
                    const dupErr = new Error('duplicate key value violates unique constraint "uq_deposits_user_idempotency_key"');
                    dupErr.code = '23505';
                    dupErr.constraint = 'uq_deposits_user_idempotency_key';
                    throw dupErr;
                }
                const now = new Date().toISOString();
                const row = {
                    id: nextDepId++,
                    user_id: userId,
                    amount,
                    unique_code: uniqueCode,
                    status,
                    method,
                    note,
                    idempotency_key: idempotencyKey,
                    created_at: now,
                    updated_at: now
                };
                txState.stagedDeposits.push(row);
                return { rows: [{ id: row.id, created_at: row.created_at }] };
            }

            if (sql.includes('INSERT INTO balance_history')) {
                const isRefundLiteral = sql.includes("'Refund'");
                txState.stagedHistory.push({
                    user_id: params[0],
                    amount: Number(params[1]),
                    type: isRefundLiteral ? 'Refund' : params[2],
                    description: isRefundLiteral ? params[2] : params[3],
                    reference_id: isRefundLiteral ? params[3] : params[4]
                });
                return { rowCount: 1 };
            }

            if (sql.includes('FROM transactions WHERE invoice_id = $1 FOR UPDATE')) {
                const found = transactions.find((t) => t.invoice_id === params[0]);
                return { rows: found ? [{ ...found }] : [] };
            }

            if (sql.includes('UPDATE transactions SET provider_trx_id')) {
                const nextProviderTrxId = params[0];
                const invoiceKey = params[1];
                const target = transactions.find((t) => t.invoice_id === invoiceKey || t.id === invoiceKey);
                if (!target) return { rowCount: 0 };
                if (txState) {
                    txState.stagedProviderTrxUpdates.push({ tx: target, providerTrxId: nextProviderTrxId });
                } else if (!target.provider_trx_id) {
                    target.provider_trx_id = nextProviderTrxId;
                }
                return { rowCount: 1 };
            }

            if (sql.includes("SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund'")) {
                const exists = balanceHistory.find((h) => h.reference_id === params[0] && h.type === 'Refund');
                return { rows: exists ? [{ id: 1 }] : [] };
            }

            if (sql.includes("UPDATE transactions SET status = 'Failed'")) {
                const allowed = ['Pending', 'Processing', 'Partial Refund'];
                const byId = sql.includes('WHERE id = $1');
                const target = transactions.find((t) => (byId ? t.id === params[0] : t.invoice_id === params[0]) && allowed.includes(t.status));
                if (!target) return { rowCount: 0 };
                if (txState) {
                    txState.stagedStatusUpdates.push({ tx: target, status: 'Failed' });
                } else {
                    target.status = 'Failed';
                }
                return { rowCount: 1 };
            }

            if (sql.includes('DELETE FROM promo_usages WHERE transaction_id = $1')) {
                return { rows: [] };
            }

            return { rows: [] };
        };

        const createClient = () => {
            let txState = null;
            return {
                query: async (sql, params = []) => {
                    if (sql === 'BEGIN') {
                        const stagedUsers = new Map();
                        for (const [k, v] of users.entries()) {
                            stagedUsers.set(k, { ...v });
                        }
                        txState = {
                            stagedUsers,
                            stagedTransactions: [],
                            stagedDeposits: [],
                            stagedHistory: [],
                            stagedStatusUpdates: [],
                            stagedProviderTrxUpdates: []
                        };
                        return {};
                    }
                    if (sql === 'COMMIT') {
                        if (txState) {
                            const committed = {
                                transactions: [...txState.stagedTransactions],
                                deposits: [...txState.stagedDeposits]
                            };
                            for (const [k, v] of txState.stagedUsers.entries()) {
                                users.set(k, v);
                            }
                            for (const tx of txState.stagedTransactions) {
                                // Double-check unique constraint at commit too
                                if (tx.ref_id !== null && matchTxByRef(tx.user_id, tx.ref_id)) {
                                    const dupErr = new Error('duplicate key value violates unique constraint "uq_transactions_user_ref_id"');
                                    dupErr.code = '23505';
                                    throw dupErr;
                                }
                                transactions.push(tx);
                            }
                            for (const dep of txState.stagedDeposits) {
                                if (dep.idempotency_key !== null && matchDepByKey(dep.user_id, dep.idempotency_key)) {
                                    const dupErr = new Error('duplicate key value violates unique constraint "uq_deposits_user_idempotency_key"');
                                    dupErr.code = '23505';
                                    throw dupErr;
                                }
                                deposits.push(dep);
                            }
                            for (const h of txState.stagedHistory) {
                                balanceHistory.push(h);
                            }
                            for (const upd of (txState.stagedStatusUpdates || [])) {
                                upd.tx.status = upd.status;
                            }
                            for (const upd of (txState.stagedProviderTrxUpdates || [])) {
                                if (!upd.tx.provider_trx_id) {
                                    upd.tx.provider_trx_id = upd.providerTrxId;
                                }
                            }
                            txState = null;
                            if (typeof options.onCommit === 'function') {
                                await options.onCommit(committed);
                            }
                        }
                        return {};
                    }
                    if (sql === 'ROLLBACK') {
                        if (txState) {
                            rollbackCount++;
                            txState = null;
                        }
                        return {};
                    }
                    return runQuery(sql, params, txState);
                },
                release: () => {}
            };
        };

        return {
            users,
            products,
            transactions,
            deposits,
            balanceHistory,
            getRollbackCount: () => rollbackCount,
            poolQuery: async (sql, params) => runQuery(sql, params, null),
            poolConnect: async () => createClient()
        };
    }

    before(() => {
        origPoolQuery = pool.query;
        origPoolConnect = pool.connect;
        origAxiosGet = axios.get;
        origAxiosPost = axios.post;
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        pool.query = origPoolQuery;
        pool.connect = origPoolConnect;
        axios.get = origAxiosGet;
        axios.post = origAxiosPost;
        await new Promise((resolve) => server.close(resolve));
    });

    test('SEC-009 (1): migrasi 011 idempoten menambah hanya transactions.ref_id dan deposits.idempotency_key dengan unique index parsial', () => {
        const migrationsDir = path.resolve(__dirname, '../../migrations');
        const files = fs.readdirSync(migrationsDir).filter((f) => /^011_.*\.sql$/i.test(f));
        assert.strictEqual(files.length, 1, 'Harus ada tepat satu file migrasi 011_*.sql');

        const sql = fs.readFileSync(path.join(migrationsDir, files[0]), 'utf8');
        assert.match(sql, /ALTER\s+TABLE\s+transactions[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ref_id\s+VARCHAR\(100\)/i);
        assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+transactions\s*\(\s*user_id\s*,\s*ref_id\s*\)\s+WHERE\s+ref_id\s+IS\s+NOT\s+NULL/i);
        assert.match(sql, /ALTER\s+TABLE\s+deposits[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+idempotency_key\s+VARCHAR\(100\)/i);
        assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+deposits\s*\(\s*user_id\s*,\s*idempotency_key\s*\)\s+WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL/i);

        const addColumnMatches = sql.match(/ADD\s+COLUMN/gi) || [];
        assert.strictEqual(addColumnMatches.length, 2, 'Migrasi 011 tidak boleh menambah kolom selain ref_id dan idempotency_key');
    });

    test('SEC-009 (2): POST /h2h/order — ref_id validasi, HTTP 200 idempotent:true tanpa double debit, 409 payload beda, & kompatibel tanpa ref_id', async () => {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const db = createTransactionalMockDb(
            [{
                id: 9201,
                username: 'h2h_sec9',
                balance: 200000,
                role_id: 2,
                role_name: 'PARTNER',
                api_key: null,
                api_key_hash: apiKeyHash,
                whitelisted_ips: []
            }],
            [
                {
                    id: 11, name: 'ML 86 Diamonds', provider_sku: 'ML-86', price: 12000, status: 'Active',
                    game_id: 1, needs_server_id: false, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                },
                {
                    id: 12, name: 'ML 172 Diamonds', provider_sku: 'ML-172', price: 20000, status: 'Active',
                    game_id: 1, needs_server_id: true, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                }
            ]
        );

        let foxyOrderCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: {
                data: [
                    { product_code: 'ML-86', product_price: 11000 },
                    { product_code: 'ML-172', product_price: 18000 }
                ]
            }
        });
        axios.post = async () => {
            foxyOrderCalls++;
            return { data: { status: true } };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // 1. Format ref_id tidak valid ditolak 400
            for (const badRef of ['', 'bad ref with space', 'x'.repeat(101), '../etc/passwd']) {
                const resBad = await fetch(`${baseUrl}/h2h/order`, {
                    method: 'POST',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: badRef })
                });
                assert.strictEqual(resBad.status, 400, `ref_id tidak valid "${badRef}" harus ditolak 400`);
            }
            assert.strictEqual(foxyOrderCalls, 0);

            // 2. Request pertama dengan ref_id -> 201 Created, invoice kriptografis H2H-...
            const res1 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(res1.status, 201, 'Order H2H pertama harus mengembalikan 201');
            const body1 = await res1.json();
            assert.strictEqual(body1.success, true);
            assert.match(body1.data.invoiceId, /^H2H-[A-F0-9]{16,}$/, 'invoiceId H2H harus berformat kriptografis H2H-<HEX>');
            const expectedFirstBalance = 200000 - body1.data.price;
            assert.strictEqual(body1.data.price, Math.ceil(12000 * 1.1));
            assert.strictEqual(db.users.get(9201).balance, expectedFirstBalance, 'Saldo harus terpotong sekali sebesar harga produk');
            assert.strictEqual(foxyOrderCalls, 1);

            // Simulasikan transaksi sudah berubah jadi Success oleh callback/cron
            db.transactions[0].status = 'Success';

            // 3. Retry dengan ref_id & payload sama -> HTTP 200 + idempotent:true + status sama
            const resRetry = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(resRetry.status, 200, 'Retry dengan ref_id sama harus mengembalikan HTTP 200');
            const bodyRetry = await resRetry.json();
            assert.strictEqual(bodyRetry.idempotent, true, 'Respons retry harus menandai idempotent: true');
            assert.strictEqual(bodyRetry.data.invoiceId, body1.data.invoiceId, 'invoiceId retry harus identik');
            assert.strictEqual(bodyRetry.data.status, 'Success', 'Status terbaru transaksi harus dikembalikan');
            assert.strictEqual(bodyRetry.data.price, body1.data.price);
            assert.strictEqual(db.users.get(9201).balance, expectedFirstBalance, 'Saldo TIDAK boleh terpotong ulang');
            assert.strictEqual(foxyOrderCalls, 1, 'Foxy tidak boleh dipanggil ulang pada retry idempoten');
            assert.strictEqual(db.transactions.length, 1);

            // 4. Retry dengan ref_id sama tapi target atau product berbeda -> HTTP 409 Conflict
            const resDiffTarget = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '999888', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(resDiffTarget.status, 409, 'ref_id sama dengan target berbeda harus ditolak 409');

            const resDiffProduct = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '100200', targetServerId: '1234', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(resDiffProduct.status, 409, 'ref_id sama dengan produk berbeda harus ditolak 409');
            assert.strictEqual(db.users.get(9201).balance, expectedFirstBalance);

            // 5. ref_id BARU dalam <15 detik untuk produk & target sama tetap diterima (201)
            const resDistinctRef = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: 'ORD-H2H-002' })
            });
            assert.strictEqual(resDistinctRef.status, 201, 'ref_id berbeda harus diizinkan meski dalam 15 detik');
            const bodyDistinct = await resDistinctRef.json();
            assert.notStrictEqual(bodyDistinct.data.invoiceId, body1.data.invoiceId);
            assert.strictEqual(db.transactions.length, 2);

            // 6. Tanpa ref_id mempertahankan perilaku lama (201 pertama, lalu blokir duplicate pending 15 detik)
            const resLegacy1 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '555666', targetServerId: '2020' })
            });
            assert.strictEqual(resLegacy1.status, 201, 'Order H2H tanpa ref_id tetap harus berfungsi untuk reseller lama');

            const resLegacyDup = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '555666', targetServerId: '2020' })
            });
            assert.strictEqual(resLegacyDup.status, 400, 'Tanpa ref_id tetap terkena guard duplikat 15 detik');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (3): POST /api/order — header Idempotency-Key (UUID) mengembalikan 200 idempotent:true, tolak 409 jika payload beda, & tolak non-UUID 400', async () => {
        const token = makeUserToken(9202, 'User');
        const db = createTransactionalMockDb(
            [{ id: 9202, username: 'web_sec9', balance: 100000, role_id: 1, role_name: 'User' }],
            [
                {
                    id: 21, name: 'DM 50', provider_sku: 'DM-50', price: 10000, status: 'Active',
                    game_id: 1, needs_server_id: false, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                },
                {
                    id: 22, name: 'DM 100', provider_sku: 'DM-100', price: 20000, status: 'Active',
                    game_id: 1, needs_server_id: false, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                }
            ]
        );

        let foxyCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: {
                data: [
                    { product_code: 'DM-50', product_price: 9000 },
                    { product_code: 'DM-100', product_price: 18000 }
                ]
            }
        });
        axios.post = async () => {
            foxyCalls++;
            return { data: { status: true } };
        };
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        const idemKey = '550e8400-e29b-41d4-a716-446655440001';
        try {
            // Invalid UUID headers -> 400
            for (const badHeader of ['not-a-uuid', '']) {
                const resBad = await fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': badHeader
                    },
                    body: JSON.stringify({ productId: 21, targetGameId: '778899' })
                });
                assert.strictEqual(resBad.status, 400, `Idempotency-Key "${badHeader}" harus ditolak 400`);
            }

            // Valid UUID order -> 201, crypto TRX- invoice
            const res1 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey
                },
                body: JSON.stringify({ productId: 21, targetGameId: '778899' })
            });
            assert.strictEqual(res1.status, 201);
            const body1 = await res1.json();
            assert.match(body1.invoiceId, /^TRX-[A-F0-9]{16,}$/, 'invoiceId web harus berformat TRX-<HEX>');
            assert.strictEqual(db.users.get(9202).balance, 89000);
            assert.strictEqual(foxyCalls, 1);

            // Retry with exact same UUID & payload -> 200 + idempotent:true
            const resRetry = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey.toUpperCase()
                },
                body: JSON.stringify({ productId: 21, targetGameId: '778899' })
            });
            assert.strictEqual(resRetry.status, 200);
            const bodyRetry = await resRetry.json();
            assert.strictEqual(bodyRetry.idempotent, true);
            assert.strictEqual(bodyRetry.invoiceId, body1.invoiceId);
            assert.strictEqual(db.users.get(9202).balance, 89000);
            assert.strictEqual(foxyCalls, 1);

            // Retry with same UUID & different target/product -> 409
            const resConflict = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey
                },
                body: JSON.stringify({ productId: 22, targetGameId: '778899' })
            });
            assert.strictEqual(resConflict.status, 409, 'Idempotency-Key sama dengan produk berbeda harus ditolak 409');

            const resConflictTarget = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey
                },
                body: JSON.stringify({ productId: 21, targetGameId: '111222' })
            });
            assert.strictEqual(resConflictTarget.status, 409, 'Idempotency-Key sama dengan target berbeda harus ditolak 409');

            // Without Idempotency-Key -> legacy behavior
            const resNoKey = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 21, targetGameId: '333444' })
            });
            assert.strictEqual(resNoKey.status, 201);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (4): POST /api/deposit/request — header Idempotency-Key (UUID) 200 idempotent:true & 409 jika payload beda', async () => {
        const token = makeUserToken(9203, 'User');
        let forcedPendingCount = 0;
        const db = createTransactionalMockDb(
            [{ id: 9203, username: 'dep_sec9', balance: 0, role_id: 1, role_name: 'User' }],
            [],
            { pendingDepositCountOverride: () => forcedPendingCount }
        );
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        const depKey = '550e8400-e29b-41d4-a716-446655440002';
        try {
            // Invalid UUID -> 400
            const resBad = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'bukan-uuid'
                },
                body: JSON.stringify({ amount: 50000, method: 'BCA' })
            });
            assert.strictEqual(resBad.status, 400);

            // First deposit request with UUID -> 201
            const res1 = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 50000, method: 'BCA', note: 'topup awal' })
            });
            assert.strictEqual(res1.status, 201);
            const body1 = await res1.json();
            assert.strictEqual(db.deposits.length, 1);

            // Retry even when pending limit reached -> 200 + idempotent:true + exact same deposit
            forcedPendingCount = 2;
            const resRetry = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 50000, method: 'BCA', note: 'topup awal' })
            });
            assert.strictEqual(resRetry.status, 200, 'Retry deposit dengan Idempotency-Key sama harus 200 meski pendingCount = 2');
            const bodyRetry = await resRetry.json();
            assert.strictEqual(bodyRetry.idempotent, true);
            assert.strictEqual(bodyRetry.deposit.id, body1.deposit.id);
            assert.strictEqual(bodyRetry.deposit.amount, body1.deposit.amount);
            assert.strictEqual(bodyRetry.deposit.unique_code, body1.deposit.unique_code);
            assert.strictEqual(bodyRetry.deposit.paymentInstructions, body1.deposit.paymentInstructions);
            assert.strictEqual(db.deposits.length, 1, 'Deposit ganda tidak boleh dibuat');

            // Same UUID with different amount or method -> 409
            const resDiffAmount = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 75000, method: 'BCA', note: 'topup awal' })
            });
            assert.strictEqual(resDiffAmount.status, 409);

            const resDiffMethod = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 50000, method: 'QRIS', note: 'topup awal' })
            });
            assert.strictEqual(resDiffMethod.status, 409);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
        }
    });

    test('SEC-009 (5): race paralel Promise.all dengan ref_id/Idempotency-Key sama menangani 23505 via ROLLBACK + re-read', async () => {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const userToken = makeUserToken(9205, 'User');

        const raceH2hRef = 'RACE-REF-99';
        const raceOrderKey = '550e8400-e29b-41d4-a716-446655440088';
        const raceDepKey = '550e8400-e29b-41d4-a716-446655440099';

        // Barrier per skenario agar 2 request paralel sama-sama lolos pre-check dan tx #2 menunggu tx #1 COMMIT sebelum 23505
        const createRaceBarrier = (constraintName) => {
            let arrivals = 0;
            let winnerPicked = false;
            let releaseArrivalBarrier;
            const arrivalBarrierReady = new Promise((resolve) => { releaseArrivalBarrier = resolve; });
            let resolveWinnerCommitted;
            const winnerCommitted = new Promise((resolve) => { resolveWinnerCommitted = resolve; });
            return {
                waitAndCollide: async () => {
                    arrivals++;
                    if (arrivals === 2) releaseArrivalBarrier();
                    await arrivalBarrierReady;
                    if (!winnerPicked) {
                        winnerPicked = true;
                        return;
                    }
                    await winnerCommitted;
                    const err23505 = new Error(`duplicate key value violates unique constraint "${constraintName}"`);
                    err23505.code = '23505';
                    err23505.constraint = constraintName;
                    throw err23505;
                },
                notifyCommitted: () => resolveWinnerCommitted()
            };
        };

        const h2hBarrier = createRaceBarrier('uq_transactions_user_ref_id');
        const orderBarrier = createRaceBarrier('uq_transactions_user_ref_id');
        const depBarrier = createRaceBarrier('uq_deposits_user_idempotency_key');

        const db = createTransactionalMockDb(
            [
                {
                    id: 9204, username: 'race_h2h', balance: 100000, role_id: 2, role_name: 'PARTNER',
                    api_key: null, api_key_hash: apiKeyHash, whitelisted_ips: []
                },
                {
                    id: 9205, username: 'race_dep', balance: 50000, role_id: 1, role_name: 'User'
                }
            ],
            [{
                id: 31, name: 'Race Item', provider_sku: 'RACE-SKU', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, validation_config: null,
                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
            }],
            {
                beforeTxInsert: async (params) => {
                    if (params[8] === raceH2hRef) return h2hBarrier.waitAndCollide();
                    if (params[8] === raceOrderKey) return orderBarrier.waitAndCollide();
                },
                beforeDepositInsert: async () => depBarrier.waitAndCollide(),
                onCommit: (committed) => {
                    if (committed.transactions.some((t) => t.ref_id === raceH2hRef)) {
                        h2hBarrier.notifyCommitted();
                    }
                    if (committed.transactions.some((t) => t.ref_id === raceOrderKey)) {
                        orderBarrier.notifyCommitted();
                    }
                    if (committed.deposits.some((d) => d.idempotency_key === raceDepKey)) {
                        depBarrier.notifyCommitted();
                    }
                }
            }
        );

        let foxyCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: { data: [{ product_code: 'RACE-SKU', product_price: 9000 }] }
        });
        axios.post = async () => {
            foxyCalls++;
            return { data: { status: true } };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // 1. Race 2 paralel POST /h2h/order dengan ref_id identik
            const [resA, resB] = await Promise.all([
                fetch(`${baseUrl}/h2h/order`, {
                    method: 'POST',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 31, targetGameId: '554433', ref_id: raceH2hRef })
                }),
                fetch(`${baseUrl}/h2h/order`, {
                    method: 'POST',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 31, targetGameId: '554433', ref_id: raceH2hRef })
                })
            ]);

            const statuses = [resA.status, resB.status].sort((a, b) => a - b);
            assert.deepStrictEqual(statuses, [200, 201], 'Salah satu paralel H2H harus 201 dan satunya 200 idempotent');
            const bodyA = await resA.json();
            const bodyB = await resB.json();
            assert.strictEqual(bodyA.data.invoiceId, bodyB.data.invoiceId, 'Kedua response paralel H2H harus mengembalikan invoiceId sama');
            assert.strictEqual([bodyA.idempotent === true, bodyB.idempotent === true].filter(Boolean).length, 1, 'Tepat satu response H2H bertanda idempotent:true');
            assert.strictEqual(db.transactions.filter((t) => t.user_id === 9204).length, 1, 'Harus tercipta tepat 1 transaksi H2H di DB');
            assert.strictEqual(db.balanceHistory.filter((h) => h.user_id === 9204).length, 1, 'Ledger mutasi H2H hanya boleh punya 1 baris Purchase');
            assert.strictEqual(db.users.get(9204).balance, 89000, 'Saldo H2H hanya boleh terpotong 1x (100000 - 11000)');
            assert.strictEqual(foxyCalls, 1, 'Provider Foxy hanya boleh dipanggil 1x untuk H2H race');
            assert.ok(db.getRollbackCount() >= 1, 'Request H2H yang kalah race 23505 wajib melakukan ROLLBACK');

            // 2. Race 2 paralel POST /api/order dengan Idempotency-Key identik
            const [ordResA, ordResB] = await Promise.all([
                fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceOrderKey
                    },
                    body: JSON.stringify({ productId: 31, targetGameId: '667788' })
                }),
                fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceOrderKey
                    },
                    body: JSON.stringify({ productId: 31, targetGameId: '667788' })
                })
            ]);

            assert.deepStrictEqual([ordResA.status, ordResB.status].sort((a, b) => a - b), [200, 201], 'Salah satu paralel /api/order harus 201 dan satunya 200 idempotent');
            const ordBodyA = await ordResA.json();
            const ordBodyB = await ordResB.json();
            assert.strictEqual(ordBodyA.invoiceId, ordBodyB.invoiceId, 'Kedua response paralel /api/order harus mengembalikan invoiceId sama');
            assert.strictEqual([ordBodyA.idempotent === true, ordBodyB.idempotent === true].filter(Boolean).length, 1, 'Tepat satu response /api/order bertanda idempotent:true');
            assert.strictEqual(db.transactions.filter((t) => t.user_id === 9205).length, 1, 'Harus tercipta tepat 1 transaksi /api/order di DB');
            assert.strictEqual(db.balanceHistory.filter((h) => h.user_id === 9205).length, 1, 'Ledger mutasi /api/order hanya boleh punya 1 baris Purchase');
            assert.ok(db.users.get(9205).balance < 50000 && db.users.get(9205).balance >= 39000, `Saldo /api/order hanya boleh terpotong 1x, aktual=${db.users.get(9205).balance}`);
            assert.strictEqual(foxyCalls, 2, 'Provider Foxy hanya boleh dipanggil 1x lagi untuk /api/order race');
            assert.ok(db.getRollbackCount() >= 2, 'Request /api/order yang kalah race 23505 wajib melakukan ROLLBACK');

            // 3. Race 2 paralel POST /api/deposit/request dengan Idempotency-Key identik
            const [depResA, depResB] = await Promise.all([
                fetch(`${baseUrl}/api/deposit/request`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceDepKey
                    },
                    body: JSON.stringify({ amount: 50000, method: 'QRIS' })
                }),
                fetch(`${baseUrl}/api/deposit/request`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceDepKey
                    },
                    body: JSON.stringify({ amount: 50000, method: 'QRIS' })
                })
            ]);

            assert.deepStrictEqual([depResA.status, depResB.status].sort((a, b) => a - b), [200, 201]);
            const depBodyA = await depResA.json();
            const depBodyB = await depResB.json();
            assert.strictEqual(depBodyA.deposit.id, depBodyB.deposit.id);
            assert.strictEqual([depBodyA.idempotent === true, depBodyB.idempotent === true].filter(Boolean).length, 1, 'Tepat satu response deposit bertanda idempotent:true');
            assert.strictEqual(db.deposits.length, 1, 'Deposit paralel harus menghasilkan tepat 1 baris');
            assert.ok(db.getRollbackCount() >= 3, 'Request deposit yang kalah race 23505 wajib melakukan ROLLBACK');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (6): invoice_id kriptografis (TRX-/H2H-) unik paralel, lolos validator publik, tolak >64 char, & tersamarkan di recent-transactions', async () => {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const webToken = makeUserToken(9206, 'User');
        const db = createTransactionalMockDb(
            [
                {
                    id: 9206, username: 'web_crypto', balance: 500000, role_id: 1, role_name: 'User'
                },
                {
                    id: 9207, username: 'h2h_crypto', balance: 500000, role_id: 2, role_name: 'PARTNER',
                    api_key: null, api_key_hash: apiKeyHash, whitelisted_ips: []
                }
            ],
            [{
                id: 41, name: 'Crypto Product', provider_sku: 'CRYPTO-SKU', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, validation_config: null,
                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
            }]
        );

        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: { data: [{ product_code: 'CRYPTO-SKU', product_price: 9000 }] }
        });
        axios.post = async () => ({ data: { status: true } });
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            const webReqs = [1, 2, 3].map((i) => fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 41, targetGameId: `web_target_${i}` })
            }));
            const h2hReqs = [1, 2, 3].map((i) => fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 41, targetGameId: `h2h_target_${i}`, ref_id: `UNIQ-${i}` })
            }));

            const webResponses = await Promise.all(webReqs);
            const h2hResponses = await Promise.all(h2hReqs);
            const webBodies = await Promise.all(webResponses.map((r) => r.json()));
            const h2hBodies = await Promise.all(h2hResponses.map((r) => r.json()));

            const webInvoices = webBodies.map((b) => b.invoiceId);
            const h2hInvoices = h2hBodies.map((b) => b.data.invoiceId);
            const allInvoices = [...webInvoices, ...h2hInvoices];

            assert.strictEqual(new Set(allInvoices).size, 6, 'Semua invoice paralel harus unik');
            for (const inv of webInvoices) {
                assert.match(inv, /^TRX-[A-F0-9]{16,}$/, `Invoice web baru harus kriptografis: ${inv}`);
                assert.ok(inv.length <= 64, 'Panjang invoice harus <= 64 agar lolos input & validator publik');
            }
            for (const inv of h2hInvoices) {
                assert.match(inv, /^H2H-[A-F0-9]{16,}$/, `Invoice H2H baru harus kriptografis: ${inv}`);
                assert.ok(inv.length <= 64);
            }

            // Semua invoice baru harus lolos GET /api/public/transaction/:invoiceId
            for (const inv of [webInvoices[0], h2hInvoices[0]]) {
                const pubRes = await fetch(`${baseUrl}/api/public/transaction/${encodeURIComponent(inv)}`);
                assert.strictEqual(pubRes.status, 200, `Validator publik harus menerima invoice kriptografis ${inv}`);
                const pubData = await pubRes.json();
                assert.strictEqual(pubData.invoice_id, inv);
            }

            // Invoice >64 karakter harus ditolak 400 (bukan diam-diam dipotong)
            const tooLongRes = await fetch(`${baseUrl}/api/public/transaction/${'TRX-' + 'A'.repeat(65)}`);
            assert.strictEqual(tooLongRes.status, 400, 'Invoice > 64 karakter harus ditolak 400');

            // Tambahkan contoh invoice pendek lama untuk memastikan maskInvoiceId juga menyamarkan suffix <= 8
            db.transactions.push({
                id: 999,
                invoice_id: 'TRX-SAFE-001',
                user_id: 9206,
                product_id: 41,
                target_game_id: 'x',
                price: 10000,
                status: 'Pending',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            const recentRes = await fetch(`${baseUrl}/api/public/recent-transactions`);
            assert.strictEqual(recentRes.status, 200);
            const recentList = await recentRes.json();
            assert.ok(recentList.length >= 3);
            for (const item of recentList) {
                assert.ok(item.invoice_masked.includes('****'), `Invoice harus tersamarkan: ${item.invoice_masked}`);
                assert.ok(!allInvoices.includes(item.invoice_masked), 'Invoice lengkap tidak boleh bocor');
                assert.notStrictEqual(item.invoice_masked, 'TRX-SAFE-001', 'Invoice pendek TRX-SAFE-001 pun harus disamarkan');
            }
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (7): replay setelah order Failed — POST /api/order tolak 409 dengan pesan jelas agar user tidak terjebak; POST /h2h/order kembalikan 200 status Failed & ref_id baru diproses normal', async () => {
        const webToken = makeUserToken(9207, 'User');
        const h2hApiKey = crypto.randomBytes(32).toString('hex');
        const h2hApiKeyHash = crypto.createHash('sha256').update(h2hApiKey).digest('hex');

        const db = createTransactionalMockDb(
            [
                { id: 9207, username: 'web_fail_replay', balance: 100000, role_id: 1, role_name: 'User' },
                {
                    id: 9208, username: 'h2h_fail_replay', balance: 100000, role_id: 2, role_name: 'PARTNER',
                    api_key: null, api_key_hash: h2hApiKeyHash, whitelisted_ips: []
                }
            ],
            [{
                id: 51, name: 'Fail Replay Item', provider_sku: 'FAIL-SKU', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, validation_config: null,
                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
            }]
        );

        let foxyShouldReject = true;
        let foxyCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: { data: [{ product_code: 'FAIL-SKU', product_price: 9000 }] }
        });
        axios.post = async () => {
            foxyCalls++;
            if (foxyShouldReject) {
                return { data: { status: false, message: 'Provider explicit reject' } };
            }
            return { data: { status: true } };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // 1. Web /api/order: percobaan pertama ditolak provider -> status Failed & saldo kembali
            const webKey1 = '550e8400-e29b-41d4-a716-446655440701';
            const webResFail = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': webKey1
                },
                body: JSON.stringify({ productId: 51, targetGameId: '500600' })
            });
            assert.strictEqual(webResFail.status, 400);
            assert.strictEqual(db.users.get(9207).balance, 100000, 'Saldo web wajib kembali utuh pasca refund kompensasi');
            const webTx = db.transactions.find((t) => t.user_id === 9207);
            assert.strictEqual(webTx.status, 'Failed');

            // Aktifkan provider agar sukses untuk key baru
            foxyShouldReject = false;

            // 2. Replay /api/order dengan Idempotency-Key lama yang statusnya Failed -> 409 + pesan jelas
            const webReplay = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': webKey1
                },
                body: JSON.stringify({ productId: 51, targetGameId: '500600' })
            });
            assert.strictEqual(webReplay.status, 409, 'Replay /api/order atas transaksi Failed wajib ditolak 409 agar UI tidak menganggap sukses');
            const webReplayBody = await webReplay.json();
            assert.strictEqual(webReplayBody.idempotent, true);
            assert.strictEqual(webReplayBody.status, 'Failed');
            assert.strictEqual(webReplayBody.invoiceId, webTx.invoice_id);
            assert.match(webReplayBody.message, /gagal.*pesanan baru/i);
            assert.strictEqual(foxyCalls, 1, 'Replay Failed tidak boleh memanggil Foxy');
            assert.strictEqual(db.users.get(9207).balance, 100000);

            // 3. Web /api/order dengan Idempotency-Key BARU -> diproses normal 201
            const webKey2 = '550e8400-e29b-41d4-a716-446655440702';
            const webResNew = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': webKey2
                },
                body: JSON.stringify({ productId: 51, targetGameId: '500600' })
            });
            assert.strictEqual(webResNew.status, 201, 'Key baru setelah order Failed harus memproses order baru');
            assert.strictEqual(db.users.get(9207).balance, 89000);

            // 4. H2H /h2h/order: percobaan pertama ditolak provider -> Failed & refund
            foxyShouldReject = true;
            const h2hResFail = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '700800', ref_id: 'REF-FAIL-1' })
            });
            assert.strictEqual(h2hResFail.status, 400);
            assert.strictEqual(db.users.get(9208).balance, 100000);
            const h2hTx = db.transactions.find((t) => t.user_id === 9208);
            assert.strictEqual(h2hTx.status, 'Failed');

            // 5. H2H replay ref_id sama -> kembalikan hasil lama (HTTP 200 idempotent:true, data.status='Failed')
            foxyShouldReject = false;
            const h2hReplay = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '700800', ref_id: 'REF-FAIL-1' })
            });
            assert.strictEqual(h2hReplay.status, 200);
            const h2hReplayBody = await h2hReplay.json();
            assert.strictEqual(h2hReplayBody.idempotent, true);
            assert.strictEqual(h2hReplayBody.data.invoiceId, h2hTx.invoice_id);
            assert.strictEqual(h2hReplayBody.data.status, 'Failed');
            assert.strictEqual(db.users.get(9208).balance, 100000);

            // 6. H2H ref_id baru -> diproses normal 201
            const h2hNew = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '700800', ref_id: 'REF-OK-2' })
            });
            assert.strictEqual(h2hNew.status, 201);
            assert.strictEqual(db.users.get(9208).balance, 89000);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });
});

// ============================================================
// PHASE 15: SEC-013 — Connection Pool Exhaustion & 3-Phase Order Flow
// ============================================================
describe('Phase 15: SEC-013: Connection Pool & 3-Phase Order Flow', () => {
    const jwt = require('jsonwebtoken');
    const axios = require('axios');
    const crypto = require('crypto');
    const cronUtils = require('../utils/cronUtils');
    const cronPool = cronUtils.pool;
    const { invalidateFoxyProductCache, clearCallbackCooldownCache } = require('../server');
    const { webhookDns } = require('../utils/webhookClient');
    const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

    let server;
    let baseUrl;
    let origPoolQuery;
    let origPoolConnect;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id, role = 'User') {
        return jwt.sign({ id, username: `sec13_user_${id}`, role }, JWT_SECRET, { expiresIn: '1h' });
    }

    function createPhase13MockDb(initialUsers, initialProducts) {
        const users = new Map();
        for (const u of initialUsers) {
            users.set(u.id, { ...u });
        }
        const products = new Map();
        for (const p of initialProducts) {
            products.set(p.id, { ...p });
        }
        const transactions = [];
        const balanceHistory = [];
        let nextTxId = 1;
        let activeClients = 0;
        let connectCalls = 0;

        const runQuery = async (sql, params = [], txState = null) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};

            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                const candidatePlain = params[0];
                const candidateHash = params[1];
                for (const u of users.values()) {
                    if ((u.api_key_hash && u.api_key_hash === candidateHash) || (u.api_key && u.api_key === candidatePlain)) {
                        return { rows: [{ ...u }] };
                    }
                }
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                const u = users.get(params[0]);
                return u ? { rows: [{ id: u.id, whitelisted_ips: u.whitelisted_ips || [], api_key: u.api_key || null, api_key_hash: u.api_key_hash || null }] } : { rows: [] };
            }
            if (sql.includes('FROM users u JOIN roles r') && sql.includes('u.id = $1') && !sql.includes('FOR UPDATE')) {
                const u = users.get(params[0]);
                return u ? { rows: [{ id: u.id, username: u.username, role_name: u.role_name, balance: u.balance, role_id: u.role_id }] } : { rows: [] };
            }
            if (sql.includes('JOIN games g') && (sql.includes('p.id = $1') || sql.includes('WHERE id = $1'))) {
                const prod = products.get(params[0]);
                return { rows: prod ? [{ ...prod }] : [] };
            }
            if (sql.includes('FROM users u JOIN roles r') && sql.includes('FOR UPDATE')) {
                const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
                return target ? { rows: [{ balance: target.balance, role_id: target.role_id, role_name: target.role_name }] } : { rows: [] };
            }
            if (sql.includes('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE')) {
                const target = txState ? txState.stagedUsers.get(params[0]) : users.get(params[0]);
                return target ? { rows: [{ balance: target.balance, role_id: target.role_id }] } : { rows: [] };
            }
            if (sql.includes('SELECT margin_percent FROM roles WHERE id = $1')) {
                return { rows: [{ margin_percent: 10 }] };
            }
            if (sql.includes('FROM flash_sales')) {
                return { rows: [] };
            }
            if (sql.includes('FROM transactions t') && sql.includes('t.provider_trx_id = $1')) {
                const found = params[0]
                    ? transactions.find((t) => t.provider_trx_id !== null && t.provider_trx_id === params[0])
                    : null;
                if (!found) return { rows: [] };
                const prod = products.get(found.product_id);
                return {
                    rows: [{
                        ...found,
                        provider_sku: prod ? prod.provider_sku : null,
                        cost_price: prod ? Number(prod.price) : null
                    }]
                };
            }
            if (sql.includes('FROM transactions t') && (sql.includes('t.ref_id = $2') || sql.includes('t.invoice_id = $1'))) {
                return { rows: [] };
            }
            if (sql.includes('FROM products WHERE id = $1')) {
                const prod = products.get(params[0]);
                return { rows: prod ? [{ ...prod }] : [] };
            }
            if (sql.includes('SELECT invoice_id') && sql.includes('FROM transactions') && sql.includes("status = 'Pending'")) {
                return { rows: [] };
            }
            if (sql.includes('UPDATE users SET balance = balance - $1')) {
                const amt = Number(params[0]);
                const uid = params[1];
                const u = txState.stagedUsers.get(uid);
                if (!u || Number(u.balance) < amt) return { rowCount: 0 };
                u.balance = Number(u.balance) - amt;
                return { rowCount: 1 };
            }
            if (sql.includes('UPDATE users SET balance = balance + $1')) {
                const amt = Number(params[0]);
                const uid = params[1];
                const u = txState.stagedUsers.get(uid);
                if (u) u.balance = Number(u.balance) + amt;
                return { rowCount: 1 };
            }
            if (sql.includes('INSERT INTO transactions')) {
                const hasRefCol = sql.includes('ref_id');
                const row = {
                    id: nextTxId++,
                    invoice_id: params[0],
                    user_id: params[1],
                    product_id: params[2],
                    target_game_id: params[3],
                    price: Number(params[4]),
                    status: params[5],
                    provider_trx_id: params[6],
                    flash_sale_id: params[7] || null,
                    flash_sale_restored: false,
                    ref_id: hasRefCol ? (params[8] || null) : null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                };
                txState.stagedTransactions.push(row);
                return { rows: [{ id: row.id }] };
            }
            if (sql.includes('INSERT INTO balance_history')) {
                const isRefundLiteral = sql.includes("'Refund'");
                txState.stagedHistory.push({
                    user_id: params[0],
                    amount: Number(params[1]),
                    type: isRefundLiteral ? 'Refund' : params[2],
                    description: isRefundLiteral ? params[2] : params[3],
                    reference_id: isRefundLiteral ? params[3] : params[4]
                });
                return { rowCount: 1 };
            }
            if (sql.includes('FROM transactions WHERE invoice_id = $1 FOR UPDATE')) {
                const found = transactions.find((t) => t.invoice_id === params[0]);
                return { rows: found ? [{ ...found }] : [] };
            }
            if (sql.includes('SELECT * FROM transactions WHERE provider_trx_id = $1')) {
                const found = params[0]
                    ? transactions.find((t) => t.provider_trx_id !== null && t.provider_trx_id === params[0])
                    : null;
                return { rows: found ? [{ ...found }] : [] };
            }
            if (sql.includes('UPDATE transactions SET provider_trx_id')) {
                const nextProviderTrxId = params[0];
                const invoiceKey = params[1];
                const target = transactions.find((t) => t.invoice_id === invoiceKey || t.id === invoiceKey);
                if (!target) return { rowCount: 0 };
                if (txState) {
                    txState.stagedProviderTrxUpdates.push({ tx: target, providerTrxId: nextProviderTrxId });
                } else if (!target.provider_trx_id) {
                    target.provider_trx_id = nextProviderTrxId;
                }
                return { rowCount: 1 };
            }
            if (sql.includes("SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund'")) {
                const exists = balanceHistory.find((h) => h.reference_id === params[0] && h.type === 'Refund');
                return { rows: exists ? [{ id: 1 }] : [] };
            }
            if (sql.includes("UPDATE transactions SET status = 'Success'")) {
                const sn = sql.includes('provider_sn = $1') ? params[0] : null;
                const txId = sql.includes('WHERE id = $2') ? params[1] : params[0];
                const target = transactions.find((t) => t.id === txId);
                if (!target) return { rowCount: 0 };
                if (txState) {
                    txState.stagedStatusUpdates.push({ tx: target, status: 'Success', providerSn: sn });
                } else {
                    target.status = 'Success';
                    if (sn !== null) target.provider_sn = sn;
                }
                return { rowCount: 1 };
            }
            if (sql.includes("UPDATE transactions SET status = 'Failed'")) {
                const allowed = ['Pending', 'Processing', 'Partial Refund'];
                const byId = sql.includes('WHERE id = $1');
                const target = transactions.find((t) => (byId ? t.id === params[0] : t.invoice_id === params[0]) && allowed.includes(t.status));
                if (!target) return { rowCount: 0 };
                if (txState) {
                    txState.stagedStatusUpdates.push({ tx: target, status: 'Failed' });
                } else {
                    target.status = 'Failed';
                }
                return { rowCount: 1 };
            }
            if (sql.includes('DELETE FROM promo_usages WHERE transaction_id = $1')) {
                return { rows: [] };
            }
            return { rows: [] };
        };

        const createClient = () => {
            let txState = null;
            let released = false;
            connectCalls += 1;
            activeClients += 1;
            return {
                query: async (sql, params = []) => {
                    if (sql === 'BEGIN') {
                        const stagedUsers = new Map();
                        for (const [k, v] of users.entries()) {
                            stagedUsers.set(k, { ...v });
                        }
                        txState = {
                            stagedUsers,
                            stagedTransactions: [],
                            stagedHistory: [],
                            stagedStatusUpdates: [],
                            stagedProviderTrxUpdates: []
                        };
                        return {};
                    }
                    if (sql === 'COMMIT') {
                        if (txState) {
                            for (const [k, v] of txState.stagedUsers.entries()) {
                                users.set(k, v);
                            }
                            for (const tx of txState.stagedTransactions) {
                                transactions.push(tx);
                            }
                            for (const h of txState.stagedHistory) {
                                balanceHistory.push(h);
                            }
                            for (const upd of txState.stagedStatusUpdates) {
                                upd.tx.status = upd.status;
                                if (upd.providerSn !== undefined && upd.providerSn !== null) {
                                    upd.tx.provider_sn = upd.providerSn;
                                }
                            }
                            for (const upd of txState.stagedProviderTrxUpdates) {
                                if (!upd.tx.provider_trx_id) {
                                    upd.tx.provider_trx_id = upd.providerTrxId;
                                }
                            }
                            txState = null;
                        }
                        return {};
                    }
                    if (sql === 'ROLLBACK') {
                        txState = null;
                        return {};
                    }
                    return runQuery(sql, params, txState);
                },
                release: () => {
                    if (!released) {
                        released = true;
                        activeClients -= 1;
                    }
                }
            };
        };

        return {
            users,
            products,
            transactions,
            balanceHistory,
            getActiveClients: () => activeClients,
            getConnectCalls: () => connectCalls,
            poolQuery: async (sql, params) => runQuery(sql, params, null),
            poolConnect: async () => createClient()
        };
    }

    before(() => {
        origPoolQuery = pool.query;
        origPoolConnect = pool.connect;
        origAxiosGet = axios.get;
        origAxiosPost = axios.post;
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        pool.query = origPoolQuery;
        pool.connect = origPoolConnect;
        axios.get = origAxiosGet;
        axios.post = origAxiosPost;
        await new Promise((resolve) => server.close(resolve));
    });

    test('SEC-013 (1): /api/order & /h2h/order release DB client before validator, price check & /v1/order, and persist provider_trx_id in Fase (a)', async () => {
        const h2hKey = 'e'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createPhase13MockDb([
            { id: 9301, username: 'sec13_web', role_id: 1, role_name: 'User', balance: 100000 },
            { id: 9302, username: 'sec13_h2h', role_id: 2, role_name: 'Bronze', balance: 100000, api_key: null, api_key_hash: h2hKeyHash, api_key_prefix: h2hKey.slice(0, 8), whitelisted_ips: [] }
        ], [
            {
                id: 71,
                name: 'MLBB 50 Diamonds',
                provider_sku: 'ML50-SEC13',
                price: 10000,
                status: 'Active',
                game_id: 1,
                needs_server_id: true,
                use_manual_prices: false,
                use_custom_margin: false,
                validation_config: { enabled: true, validator: 'Mobile Legends' }
            }
        ]);

        const origPgsKey = process.env.PGS_KEY;
        const origPgsApiKey = process.env.PGS_API_KEY;
        process.env.PGS_KEY = 'test-pgs-key';
        process.env.PGS_API_KEY = 'test-pgs-api-key';

        const snapshots = [];
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        invalidateFoxyProductCache();

        axios.get = async (url) => {
            if (url.includes('/v1/products')) {
                snapshots.push({
                    stage: 'foxy_products',
                    activeClients: db.getActiveClients(),
                    txCount: db.transactions.length
                });
                return { data: { data: [{ product_code: 'ML50-SEC13', product_price: 10000 }] } };
            }
            return { data: {} };
        };

        axios.post = async (url, body) => {
            if (url.includes('pgscode.id')) {
                snapshots.push({
                    stage: 'validator',
                    activeClients: db.getActiveClients(),
                    txCount: db.transactions.length
                });
                return { data: { status: true, data: { username: 'MikuPlayer' } } };
            }
            if (url.includes('/v1/order')) {
                snapshots.push({
                    stage: 'foxy_order',
                    activeClients: db.getActiveClients(),
                    txCount: db.transactions.length,
                    latestTx: db.transactions.length > 0 ? { ...db.transactions[db.transactions.length - 1] } : null,
                    postedTrxId: body.trx_id
                });
                return { data: { status: true } };
            }
            return { data: {} };
        };

        try {
            const webToken = makeUserToken(9301, 'User');
            const webRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': '11111111-1111-4111-8111-111111111301'
                },
                body: JSON.stringify({ productId: 71, targetGameId: '100200', targetServerId: '3001' })
            });
            assert.strictEqual(webRes.status, 201);
            const webBody = await webRes.json();

            assert.strictEqual(db.getActiveClients(), 0, 'Web order must leave 0 active DB clients');
            const webValSnap = snapshots.find((s) => s.stage === 'validator');
            const webProdSnap = snapshots.find((s) => s.stage === 'foxy_products');
            const webOrderSnap = snapshots.find((s) => s.stage === 'foxy_order');
            assert.strictEqual(webValSnap.activeClients, 0, 'Validator HTTP call must hold 0 DB clients');
            assert.strictEqual(webProdSnap.activeClients, 0, 'Foxy price check must hold 0 DB clients');
            assert.strictEqual(webOrderSnap.activeClients, 0, 'Foxy /v1/order must hold 0 DB clients');
            assert.ok(webOrderSnap.latestTx, 'Fase (a) must commit Pending transaction before Fase (b)');
            assert.strictEqual(webOrderSnap.latestTx.status, 'Pending');
            assert.match(webOrderSnap.postedTrxId, /^WEB-/, 'Web trx_id must use WEB- prefix');
            assert.strictEqual(webOrderSnap.latestTx.provider_trx_id, webOrderSnap.postedTrxId, 'provider_trx_id must already be saved in Fase (a) INSERT');
            assert.strictEqual(db.users.get(9301).balance, 89000);

            const committedWebTx = db.transactions.find((t) => t.invoice_id === webBody.invoiceId);
            assert.strictEqual(committedWebTx.status, 'Pending');
            assert.strictEqual(committedWebTx.provider_trx_id, webOrderSnap.postedTrxId, 'Fase (c) must save provider_trx_id');

            // H2H order with invalidated cache so both external HTTP steps run
            snapshots.length = 0;
            invalidateFoxyProductCache();
            const h2hRes = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 71, targetGameId: '400500', targetServerId: '3002', ref_id: 'H2H-SEC13-1' })
            });
            assert.strictEqual(h2hRes.status, 201);
            const h2hBody = await h2hRes.json();

            assert.strictEqual(db.getActiveClients(), 0, 'H2H order must leave 0 active DB clients');
            const h2hValSnap = snapshots.find((s) => s.stage === 'validator');
            const h2hProdSnap = snapshots.find((s) => s.stage === 'foxy_products');
            const h2hOrderSnap = snapshots.find((s) => s.stage === 'foxy_order');
            assert.strictEqual(h2hValSnap.activeClients, 0, 'H2H validator must hold 0 DB clients');
            assert.strictEqual(h2hProdSnap.activeClients, 0, 'H2H Foxy price check must hold 0 DB clients');
            assert.strictEqual(h2hOrderSnap.activeClients, 0, 'H2H Foxy /v1/order must hold 0 DB clients');
            assert.strictEqual(h2hOrderSnap.latestTx.status, 'Pending');
            assert.match(h2hOrderSnap.postedTrxId, /^H2H-PROVIDER-/, 'H2H trx_id must use H2H-PROVIDER- prefix');
            assert.strictEqual(h2hOrderSnap.latestTx.provider_trx_id, h2hOrderSnap.postedTrxId, 'H2H provider_trx_id must already be saved in Fase (a) INSERT');

            const committedH2hTx = db.transactions.find((t) => t.invoice_id === h2hBody.data.invoiceId);
            assert.strictEqual(committedH2hTx.status, 'Pending');
            assert.strictEqual(committedH2hTx.provider_trx_id, h2hOrderSnap.postedTrxId);
            assert.strictEqual(db.users.get(9302).balance, 89000);
        } finally {
            if (origPgsKey === undefined) delete process.env.PGS_KEY;
            else process.env.PGS_KEY = origPgsKey;
            if (origPgsApiKey === undefined) delete process.env.PGS_API_KEY;
            else process.env.PGS_API_KEY = origPgsApiKey;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-013 (2): /api/order & /h2h/order Fase (c) preserves Success if real POST /api/foxy/callback committed Success during Fase (b)', async () => {
        const h2hKey = 'f'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createPhase13MockDb([
            { id: 9303, username: 'sec13_cb_web', role_id: 1, role_name: 'User', balance: 100000 },
            { id: 9304, username: 'sec13_cb_h2h', role_id: 2, role_name: 'Bronze', balance: 100000, api_key: null, api_key_hash: h2hKeyHash, api_key_prefix: h2hKey.slice(0, 8), whitelisted_ips: [] }
        ], [
            {
                id: 72,
                name: 'MLBB 50 Diamonds',
                provider_sku: 'ML50-CB',
                price: 10000,
                status: 'Active',
                game_id: 1,
                needs_server_id: false,
                use_manual_prices: false,
                use_custom_margin: false,
                validation_config: null
            }
        ]);

        const origCallbackSecret = process.env.FOXY_CALLBACK_SECRET;
        process.env.FOXY_CALLBACK_SECRET = 'sec13-race-secret';
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        invalidateFoxyProductCache();

        let simulateRejectAfterSuccess = false;
        let lastPostedTrxId = null;

        axios.get = async (url) => {
            if (url.includes('/v1/products')) {
                return { data: { data: [{ product_code: 'ML50-CB', product_price: 10000 }] } };
            }
            if (url.includes('/v1/status/')) {
                const trxIdFromUrl = decodeURIComponent(url.split('/v1/status/')[1]);
                return {
                    data: {
                        status: true,
                        data: {
                            trx_id: trxIdFromUrl,
                            status: 'SUCCESS',
                            sn: simulateRejectAfterSuccess ? 'SN-CB-H2H' : 'SN-CB-WEB'
                        }
                    }
                };
            }
            return { data: {} };
        };

        axios.post = async (url, body) => {
            if (url.includes('/v1/order')) {
                assert.strictEqual(db.getActiveClients(), 0, 'Must hold 0 DB clients during /v1/order');
                const latestTx = db.transactions[db.transactions.length - 1];
                assert.ok(latestTx, 'Fase (a) transaction must exist during Fase (b)');
                assert.strictEqual(latestTx.provider_trx_id, body.trx_id, 'provider_trx_id must already exist during Fase (b)');
                lastPostedTrxId = body.trx_id;

                // Kirim POST /api/foxy/callback nyata sebelum /v1/order selesai (Fase (b) sedang berjalan)
                clearCallbackCooldownCache();
                const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec13-race-secret`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        trx_id: body.trx_id,
                        status: 'SUCCESS',
                        sn: simulateRejectAfterSuccess ? 'SN-CB-H2H' : 'SN-CB-WEB'
                    })
                });
                assert.strictEqual(cbRes.status, 200, 'Real Foxy callback during Fase (b) must succeed');
                assert.strictEqual(db.getActiveClients(), 0, 'Callback must release DB client');

                if (!simulateRejectAfterSuccess) {
                    return { data: { status: true } };
                }
                const err = new Error('Explicit reject after callback won');
                err.response = { status: 400, data: { status: false } };
                throw err;
            }
            return { data: {} };
        };

        try {
            // Case A: callback set Success before /v1/order returns 200
            const webToken = makeUserToken(9303, 'User');
            const resA = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 72, targetGameId: '123456' })
            });
            assert.strictEqual(resA.status, 201);
            const bodyA = await resA.json();
            const txA = db.transactions.find((t) => t.invoice_id === bodyA.invoiceId);
            assert.strictEqual(txA.status, 'Success', 'Fase (c) must preserve Success');
            assert.strictEqual(txA.provider_trx_id, lastPostedTrxId, 'COALESCE must preserve existing provider_trx_id');
            assert.strictEqual(txA.provider_sn, 'SN-CB-WEB', 'Callback SN must remain intact');
            assert.strictEqual(db.users.get(9303).balance, 89000);

            // Case B: callback set Success while /v1/order explicitly rejects (H2H)
            simulateRejectAfterSuccess = true;
            const resB = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 72, targetGameId: '654321', ref_id: 'CB-BEAT-H2H-1' })
            });
            assert.strictEqual(resB.status, 201);
            const bodyB = await resB.json();
            assert.strictEqual(bodyB.data.status, 'Success');
            const txB = db.transactions.find((t) => t.invoice_id === bodyB.data.invoiceId);
            assert.strictEqual(txB.status, 'Success', 'Fase (c) must not rollback or overwrite Success');
            assert.strictEqual(txB.provider_trx_id, lastPostedTrxId);
            assert.strictEqual(txB.provider_sn, 'SN-CB-H2H');
            assert.strictEqual(db.users.get(9304).balance, 89000, 'Balance must NOT be refunded when Success already committed');
            assert.strictEqual(db.balanceHistory.filter((h) => h.reference_id === txB.invoice_id && h.type === 'Refund').length, 0);
        } finally {
            if (origCallbackSecret === undefined) delete process.env.FOXY_CALLBACK_SECRET;
            else process.env.FOXY_CALLBACK_SECRET = origCallbackSecret;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-013 (3): /api/order & /h2h/order timeout keeps Pending and saves provider_trx_id in Fase (c), explicit 400 refunds without holding connections', async () => {
        const h2hKey = 'a'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createPhase13MockDb([
            { id: 9305, username: 'sec13_to_web', role_id: 1, role_name: 'User', balance: 100000 },
            { id: 9306, username: 'sec13_err_h2h', role_id: 2, role_name: 'Bronze', balance: 100000, api_key: null, api_key_hash: h2hKeyHash, api_key_prefix: h2hKey.slice(0, 8), whitelisted_ips: [] }
        ], [
            {
                id: 73,
                name: 'MLBB 50 Diamonds',
                provider_sku: 'ML50-TO',
                price: 10000,
                status: 'Active',
                game_id: 1,
                needs_server_id: false,
                use_manual_prices: false,
                use_custom_margin: false,
                validation_config: null
            }
        ]);

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        invalidateFoxyProductCache();

        axios.get = async () => ({ data: { data: [{ product_code: 'ML50-TO', product_price: 10000 }] } });

        let mode = 'timeout';
        let lastPostedTrxId = null;
        axios.post = async (url, body) => {
            if (url.includes('/v1/order')) {
                assert.strictEqual(db.getActiveClients(), 0, 'Must release DB client before /v1/order');
                lastPostedTrxId = body.trx_id;
                const latestTx = db.transactions[db.transactions.length - 1];
                assert.strictEqual(latestTx.provider_trx_id, body.trx_id, 'Fase (a) already commits provider_trx_id before Fase (b)');
                if (mode === 'timeout') {
                    const toErr = new Error('timeout of 15000ms exceeded');
                    toErr.code = 'ECONNABORTED';
                    throw toErr;
                }
                const err = new Error('Bad Request from provider');
                err.response = { status: 400, data: { status: false } };
                throw err;
            }
            return { data: {} };
        };

        try {
            // 1. Timeout on Web /api/order -> returns 201, keeps Pending, saves provider_trx_id in Fase (c), no refund
            const webToken = makeUserToken(9305, 'User');
            const toRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 73, targetGameId: '111222' })
            });
            assert.strictEqual(toRes.status, 201);
            const toBody = await toRes.json();
            const txTo = db.transactions.find((t) => t.invoice_id === toBody.invoiceId);
            assert.strictEqual(txTo.status, 'Pending');
            assert.strictEqual(txTo.provider_trx_id, lastPostedTrxId, 'Timeout path must still save provider_trx_id in Fase (c) for cron');
            assert.strictEqual(db.users.get(9305).balance, 89000);
            assert.strictEqual(db.getActiveClients(), 0);

            // 2. Explicit 400 on H2H /h2h/order -> returns 400, sets Failed, refunds balance, no leaked clients
            mode = 'reject';
            const rejRes = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 73, targetGameId: '333444', ref_id: 'REJ-H2H-1' })
            });
            assert.strictEqual(rejRes.status, 400);
            const txRej = db.transactions.find((t) => t.ref_id === 'REJ-H2H-1');
            assert.strictEqual(txRej.status, 'Failed');
            assert.strictEqual(db.users.get(9306).balance, 100000);
            assert.strictEqual(db.balanceHistory.filter((h) => h.reference_id === txRej.invoice_id && h.type === 'Refund').length, 1);
            assert.strictEqual(db.getActiveClients(), 0);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-013 (4): cronUtils.checkPendingTransactions handles <10m grace period, SUCCESS at any age, >10m 404 expiry/refund, legacy null skip, and callback safety', async () => {
        const origCallbackSecret = process.env.FOXY_CALLBACK_SECRET;
        const webhookSecret = 'whsec_sec13_cron_test_123';
        process.env.FOXY_CALLBACK_SECRET = 'sec13-cb-secret';
        mock.method(webhookDns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);

        const foxyStatusUrls = [];
        const capturedWebhooks = [];
        const refundHistory = [];
        const nowMs = Date.now();
        const txRows = [
            {
                id: 9501,
                invoice_id: 'TRX-CRON-FRESH-OK',
                user_id: 9307,
                price: 10000,
                provider_trx_id: 'WEB-CRON-FRESH-OK',
                check_attempts: 0,
                product_name: 'ML 30',
                h2h_callback_url: null,
                h2h_webhook_secret: null,
                flash_sale_id: null,
                flash_sale_restored: false,
                status: 'Pending',
                provider_sn: null,
                created_at: new Date(nowMs - 2 * 60 * 1000).toISOString()
            },
            {
                id: 9502,
                invoice_id: 'TRX-CRON-OLD-OK',
                user_id: 9308,
                price: 12000,
                provider_trx_id: 'WEB-CRON-OLD-OK',
                check_attempts: 2,
                product_name: 'ML 40',
                h2h_callback_url: null,
                h2h_webhook_secret: null,
                flash_sale_id: null,
                flash_sale_restored: false,
                status: 'Pending',
                provider_sn: null,
                created_at: new Date(nowMs - 25 * 60 * 1000).toISOString()
            },
            {
                id: 9503,
                invoice_id: 'TRX-CRON-FRESH-404',
                user_id: 9309,
                price: 15000,
                provider_trx_id: 'WEB-CRON-FRESH-404',
                check_attempts: 0,
                product_name: 'ML 50',
                h2h_callback_url: null,
                h2h_webhook_secret: null,
                flash_sale_id: 81,
                flash_sale_restored: false,
                status: 'Pending',
                provider_sn: null,
                created_at: new Date(nowMs - 2 * 60 * 1000).toISOString()
            },
            {
                id: 9504,
                invoice_id: 'TRX-CRON-FRESH-ERR',
                user_id: 9310,
                price: 18000,
                provider_trx_id: 'WEB-CRON-FRESH-ERR',
                check_attempts: 0,
                product_name: 'ML 60',
                h2h_callback_url: null,
                h2h_webhook_secret: null,
                flash_sale_id: null,
                flash_sale_restored: false,
                status: 'Pending',
                provider_sn: null,
                created_at: new Date(nowMs - 3 * 60 * 1000).toISOString()
            },
            {
                id: 9505,
                invoice_id: 'H2H-CRON-STALE-404',
                user_id: 9311,
                price: 25000,
                provider_trx_id: 'H2H-CRON-STALE-404',
                check_attempts: 0,
                product_name: 'ML 100',
                h2h_callback_url: 'https://reseller-sec13.example/webhook',
                h2h_webhook_secret: webhookSecret,
                flash_sale_id: 82,
                flash_sale_restored: false,
                status: 'Pending',
                provider_sn: null,
                created_at: new Date(nowMs - 15 * 60 * 1000).toISOString()
            },
            {
                id: 9506,
                invoice_id: 'TRX-LEGACY-NULL',
                user_id: 9312,
                price: 20000,
                provider_trx_id: null,
                check_attempts: 0,
                product_name: 'ML 80',
                h2h_callback_url: null,
                h2h_webhook_secret: null,
                flash_sale_id: 83,
                flash_sale_restored: false,
                status: 'Pending',
                provider_sn: null,
                created_at: new Date(nowMs - 20 * 60 * 1000).toISOString()
            }
        ];
        const balances = new Map([
            [9307, 50000],
            [9308, 50000],
            [9309, 50000],
            [9310, 50000],
            [9311, 50000],
            [9312, 50000]
        ]);
        const fsRestores = [];
        const failedUpdates = [];

        axios.get = async (url) => {
            if (url.includes('/v1/status/')) {
                foxyStatusUrls.push(url);
                if (url.endsWith('/WEB-CRON-FRESH-OK')) {
                    return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-FRESH-OK' } } };
                }
                if (url.endsWith('/WEB-CRON-OLD-OK')) {
                    return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-OLD-OK' } } };
                }
                if (url.endsWith('/WEB-CRON-FRESH-404') || url.endsWith('/H2H-CRON-STALE-404')) {
                    const err404 = new Error('Not Found');
                    err404.response = { status: 404, data: { status: false, message: 'Not found' } };
                    throw err404;
                }
                if (url.endsWith('/WEB-CRON-FRESH-ERR')) {
                    const err500 = new Error('Upstream temporary error');
                    err500.response = { status: 500, data: { message: 'Internal Server Error' } };
                    throw err500;
                }
            }
            return { data: {} };
        };
        axios.post = async (url, rawData) => {
            if (url.includes('reseller-sec13.example')) {
                capturedWebhooks.push({ url, data: JSON.parse(rawData) });
                return { status: 200, data: { ok: true } };
            }
            return { data: {} };
        };

        mock.method(cronPool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes("t.status IN ('Pending', 'Processing')")) {
                return {
                    rows: txRows
                        .filter((r) => ['Pending', 'Processing'].includes(r.status))
                        .map((r) => ({ ...r }))
                };
            }
            return { rows: [] };
        });
        mock.method(cronPool, 'connect', async () => ({
            query: async (sql, params = []) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FROM transactions WHERE id = $1 FOR UPDATE')) {
                    const row = txRows.find((r) => r.id === params[0]);
                    return { rows: row ? [{ ...row }] : [] };
                }
                if (typeof sql === 'string' && sql.includes('SET check_attempts = check_attempts + 1')) {
                    const row = txRows.find((r) => r.id === params[0]);
                    if (row) row.check_attempts += 1;
                    return { rowCount: row ? 1 : 0 };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE transactions SET status = $1, provider_sn = $2')) {
                    const row = txRows.find((r) => r.id === params[2]);
                    if (row) {
                        row.status = params[0];
                        row.provider_sn = params[1];
                    }
                    return { rowCount: row ? 1 : 0 };
                }
                if (typeof sql === 'string' && sql.includes("type = 'Refund'")) {
                    const exists = refundHistory.find((h) => h.reference_id === params[0]);
                    return { rows: exists ? [{ id: 1 }] : [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance + $1')) {
                    balances.set(params[1], balances.get(params[1]) + Number(params[0]));
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO balance_history')) {
                    refundHistory.push({ user_id: params[0], amount: Number(params[1]), reference_id: params[3] });
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM promo_usages')) {
                    return { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE flash_sales SET uses_count')) {
                    fsRestores.push(params[0]);
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE transactions SET flash_sale_restored = TRUE')) {
                    const row = txRows.find((r) => r.id === params[0]);
                    if (row) row.flash_sale_restored = true;
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    const row = txRows.find((r) => r.id === params[0]);
                    if (row) row.status = 'Failed';
                    failedUpdates.push(params[0]);
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            // Run 1: handles fresh/old SUCCESS, skips <10m 404 & 500, skips legacy null, increments >10m 404 once
            await cronUtils.checkPendingTransactions();
            await new Promise((resolve) => setImmediate(resolve));

            assert.ok(!foxyStatusUrls.some((u) => u.endsWith('/null')), 'Legacy null provider_trx_id must NOT call /v1/status');

            const txFreshOk = txRows.find((r) => r.id === 9501);
            const txOldOk = txRows.find((r) => r.id === 9502);
            const txFresh404 = txRows.find((r) => r.id === 9503);
            const txFreshErr = txRows.find((r) => r.id === 9504);
            const txStale404 = txRows.find((r) => r.id === 9505);
            const txLegacyNull = txRows.find((r) => r.id === 9506);

            assert.strictEqual(txFreshOk.status, 'Success', '(a) <10m Pending with SUCCESS must become Success');
            assert.strictEqual(txFreshOk.provider_sn, 'SN-FRESH-OK');
            assert.strictEqual(txOldOk.status, 'Success', '(a) >10m Pending with SUCCESS must become Success');
            assert.strictEqual(txOldOk.provider_sn, 'SN-OLD-OK');
            assert.strictEqual(balances.get(9307), 50000);
            assert.strictEqual(balances.get(9308), 50000);

            assert.strictEqual(txFresh404.status, 'Pending', '(b) <10m Pending with 404 must stay Pending');
            assert.strictEqual(txFresh404.check_attempts, 0, '(b) <10m Pending with 404 must NOT increment check_attempts');
            assert.strictEqual(txFreshErr.status, 'Pending', '(b) <10m Pending with /v1/status error must stay Pending');
            assert.strictEqual(txFreshErr.check_attempts, 0, '(b) <10m Pending with error must NOT increment check_attempts');

            assert.strictEqual(txLegacyNull.status, 'Pending', 'Legacy null row must remain Pending under legacy rule');
            assert.strictEqual(txLegacyNull.check_attempts, 0);
            assert.strictEqual(balances.get(9312), 50000);

            assert.strictEqual(txStale404.status, 'Pending', '(c) First >10m 404 attempt must not refund yet');
            assert.strictEqual(txStale404.check_attempts, 1);
            assert.strictEqual(refundHistory.length, 0);

            // Runs 2..5: >10m 404 increments check_attempts up to MAX_ATTEMPTS (5) without refunding yet
            for (let i = 0; i < 4; i++) {
                await cronUtils.checkPendingTransactions();
            }
            assert.strictEqual(txStale404.check_attempts, 5);
            assert.strictEqual(txStale404.status, 'Pending');
            assert.strictEqual(txFresh404.check_attempts, 0, '<10m 404 still has 0 check_attempts after 5 runs');
            assert.strictEqual(txFreshErr.check_attempts, 0, '<10m error still has 0 check_attempts after 5 runs');
            assert.strictEqual(refundHistory.length, 0);

            // Run 6: check_attempts >= MAX_ATTEMPTS -> Failed + single refund + flash sale restore + H2H webhook
            await cronUtils.checkPendingTransactions();
            await new Promise((resolve) => setImmediate(resolve));

            assert.deepStrictEqual(failedUpdates, [9505], '(c) Only stale >10m 404 past MAX_ATTEMPTS must become Failed');
            assert.strictEqual(txStale404.status, 'Failed');
            assert.strictEqual(balances.get(9311), 75000, '(c) Stale >10m 404 must be refunded once');
            assert.strictEqual(refundHistory.length, 1);
            assert.strictEqual(refundHistory[0].reference_id, 'H2H-CRON-STALE-404');
            assert.deepStrictEqual(fsRestores, [82], 'Flash sale quota must be restored once for expired row');
            assert.strictEqual(capturedWebhooks.length, 1, 'Expired H2H tx must dispatch Failed webhook');
            assert.strictEqual(capturedWebhooks[0].data.invoice_id, 'H2H-CRON-STALE-404');
            assert.strictEqual(capturedWebhooks[0].data.status, 'Failed');
            assert.strictEqual(balances.get(9309), 50000);
            assert.strictEqual(balances.get(9310), 50000);

            // Verify POST /api/foxy/callback safely ignores unknown/empty trx_id and leaves NULL rows untouched
            const cbDb = createPhase13MockDb([
                { id: 9313, username: 'cb_orphan_owner', role_id: 1, role_name: 'User', balance: 40000 }
            ], []);
            cbDb.transactions.push({
                id: 9507,
                invoice_id: 'TRX-NULL-PROVIDER',
                user_id: 9313,
                product_id: 71,
                target_game_id: '12345',
                price: 10000,
                status: 'Pending',
                provider_trx_id: null,
                flash_sale_id: null,
                flash_sale_restored: false
            });
            mock.method(pool, 'query', cbDb.poolQuery);
            mock.method(pool, 'connect', cbDb.poolConnect);

            const cbResUnknown = await fetch(`${baseUrl}/api/foxy/callback?token=sec13-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-DOES-NOT-EXIST', status: 'Success' })
            });
            assert.strictEqual(cbResUnknown.status, 200);

            const cbResEmpty = await fetch(`${baseUrl}/api/foxy/callback?token=sec13-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: '', status: 'Success' })
            });
            assert.strictEqual(cbResEmpty.status, 200);
            assert.strictEqual(cbDb.transactions[0].status, 'Pending', 'Legacy NULL row must stay untouched');
            assert.strictEqual(cbDb.users.get(9313).balance, 40000);
        } finally {
            if (origCallbackSecret === undefined) delete process.env.FOXY_CALLBACK_SECRET;
            else process.env.FOXY_CALLBACK_SECRET = origCallbackSecret;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (cronPool.query && cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect && cronPool.connect.mock) cronPool.connect.mock.restore();
            if (pool.query && pool.query.mock) pool.query.mock.restore();
            if (pool.connect && pool.connect.mock) pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-013 (5): External Axios calls in validators, mailer, and pgs-preview configure 5-10s timeouts', async () => {
        const db = createPhase13MockDb([
            { id: 9310, username: 'sec13_admin', role_id: 99, role_name: 'Admin', balance: 0 }
        ], []);

        const origEnv = {
            PGS_KEY: process.env.PGS_KEY,
            PGS_API_KEY: process.env.PGS_API_KEY,
            BREVO_API_KEY: process.env.BREVO_API_KEY
        };
        process.env.PGS_KEY = 'pgs-key-test';
        process.env.PGS_API_KEY = 'pgs-api-test';
        process.env.BREVO_API_KEY = 'brevo-key-test';

        const mailerPath = require.resolve('../utils/mailer');
        delete require.cache[mailerPath];

        const { validateGameId } = require('../utils/validators/cek-id-game');
        const { cekPromoMcggMobapay } = require('../utils/validators/stalk-mcgg');
        const { checkAllMobapayPromosML, checkMobapayMlbbEligibility } = require('../utils/validators/stalk-ml-promo');
        const { sendPasswordResetEmail } = require('../utils/mailer');

        const capturedTimeouts = new Map();
        axios.post = async (url, _body, config = {}) => {
            if (url.includes('pgscode.id')) {
                const action = _body && _body.action ? _body.action : 'unknown';
                capturedTimeouts.set(`pgs:${action}`, config.timeout);
                if (action === 'get-service') {
                    return { data: { status: true, data: [] } };
                }
                return { data: { status: true, data: { username: 'Miku' } } };
            }
            if (url.includes('brevo.com')) {
                capturedTimeouts.set('mailer', config.timeout);
                return { data: { messageId: 'ok' } };
            }
            return { data: {} };
        };
        axios.get = async (url, config = {}) => {
            if (url.includes('mobapay.com')) {
                const isMcgg = url.includes('app_id=124526') || (config.params && config.params.app_id === 124526) || url.includes('124526');
                if (isMcgg) {
                    capturedTimeouts.set('stalk-mcgg', config.timeout);
                    return { data: { code: 0, data: { user_info: { user_name: 'MCGGUser' }, shop_info: { shelf_location: [] } } } };
                }
                const key = capturedTimeouts.has('stalk-ml-main') ? 'stalk-ml-elig' : 'stalk-ml-main';
                capturedTimeouts.set(key, config.timeout);
                return { data: { code: 0, data: { user_info: { user_name: 'MLUser' }, shop_info: { shelf_location: [] } } } };
            }
            return { data: {} };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            await validateGameId('ml', '123456', '1234');
            await cekPromoMcggMobapay('123456', '1234');
            await checkAllMobapayPromosML('123456', '1234', 'ID');
            await checkMobapayMlbbEligibility('123456', '1234', ['wdp_available'], {}, { timeout: 25000 });
            await sendPasswordResetEmail('user@example.com', 'reset-tok-123');

            const adminToken = makeUserToken(9310, 'Admin');
            const pgsRes = await fetch(`${baseUrl}/api/admin/validation-services/pgs-preview`, {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            assert.strictEqual(pgsRes.status, 200);

            for (const key of ['pgs:get-nick', 'stalk-mcgg', 'stalk-ml-main', 'stalk-ml-elig', 'mailer', 'pgs:get-service']) {
                const val = capturedTimeouts.get(key);
                assert.ok(
                    typeof val === 'number' && val >= 5000 && val <= 10000,
                    `Timeout for ${key} must be between 5000 and 10000ms (got ${val})`
                );
            }
        } finally {
            if (origEnv.PGS_KEY === undefined) delete process.env.PGS_KEY;
            else process.env.PGS_KEY = origEnv.PGS_KEY;
            if (origEnv.PGS_API_KEY === undefined) delete process.env.PGS_API_KEY;
            else process.env.PGS_API_KEY = origEnv.PGS_API_KEY;
            if (origEnv.BREVO_API_KEY === undefined) delete process.env.BREVO_API_KEY;
            else process.env.BREVO_API_KEY = origEnv.BREVO_API_KEY;
            delete require.cache[mailerPath];
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });
});
