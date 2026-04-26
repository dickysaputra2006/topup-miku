const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');

// Set port to a test port before requiring server
process.env.PORT = '3002';
process.env.JWT_SECRET = 'test-secret';
process.env.FOXY_API_KEY = 'test-foxy-key';

const { app, pool, server } = require('../server.js');

const h2hOrderUrl = `http://127.0.0.1:${process.env.PORT}/h2h/order`;

describe('Security: Error Exposure Tests', () => {
    let originalQuery;

    before(() => {
        originalQuery = pool.query;
    });

    after(() => {
        pool.query = originalQuery;
        server.close();
    });

    test('should not expose sensitive error message in H2H order endpoint', async () => {
        // Mock API Key validation (protectH2H middleware)
        // First call is in protectH2H
        // We need to mock pool.query to return a valid user for the API key
        const mockUser = {
            id: 1,
            username: 'h2huser',
            role_id: 1,
            role_name: 'PARTNER',
            api_key: 'valid-api-key'
        };

        let queryCount = 0;
        mock.method(pool, 'query', async (sql, params) => {
            queryCount++;
            if (sql.includes('u.api_key = $1')) {
                return { rows: [mockUser] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            // Trigger error in the main transaction block
            throw new Error('Sensitive database error details that should not be leaked');
        });

        const res = await fetch(h2hOrderUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'valid-api-key'
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
    });

    test('should not expose sensitive error message in standard order endpoint', async () => {
        const orderUrl = `http://127.0.0.1:${process.env.PORT}/api/order`;

        // Mock jwt.verify indirectly by setting up req.user if possible,
        // but since we use real fetch, we need a real token or mock protect middleware.
        // Easiest is to mock pool.query to fail during the order process after protect passes.

        // Mock pool.query to throw error
        mock.method(pool, 'query', async () => {
            throw new Error('Another sensitive error');
        });

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

        pool.query.mock.restore();
    });
});
