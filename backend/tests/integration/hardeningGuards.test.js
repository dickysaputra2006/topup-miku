const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 8: Audit 2 Concurrency & Hardening Guards', () => {
    const harness = createServerHarness();
    let baseUrl;
    const JWT_SECRET = fixtures.TEST_JWT_SECRET;

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
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
