const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 4B: Admin Deposit Approval', () => {
    const harness = createServerHarness();
    let baseUrl;

    function makeAdminToken() {
        return fixtures.makeAdminToken(1, 'admin');
    }
    function makeUserToken(userId = 99) {
        return fixtures.makeUserToken(userId, 'BRONZE', 'user');
    }

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
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
