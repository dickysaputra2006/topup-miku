const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 4A: Deposit Endpoints', () => {
    const harness = createServerHarness();
    let baseUrl;
    const JWT_SECRET = fixtures.TEST_JWT_SECRET;

    function makeToken(userId = 99) {
        return jwt.sign({ id: userId, role_name: 'User' }, JWT_SECRET, { expiresIn: '1h' });
    }

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
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

describe('Phase 4C: Deposit Method & Note', () => {
    const harness = createServerHarness();
    let baseUrl;

    function makeUserToken(userId = 55) {
        return fixtures.makeUserToken(userId, 'BRONZE', 'testuser');
    }
    function makeAdminToken() {
        return fixtures.makeAdminToken(1, 'admin');
    }

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
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
