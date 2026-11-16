const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 9: Dynamic Payment Methods (Paket 2)', () => {
    const harness = createServerHarness();
    let baseUrl;
    const JWT_SECRET = fixtures.TEST_JWT_SECRET;

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
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
