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
