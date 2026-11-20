const crypto = require('node:crypto');
const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, axios, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { hashApiKey } = require('../../utils/crypto');
const { clearCallbackCooldownCache } = require('../../routes/foxyCallback.routes');

describe('QA Batch 2B: Deposit Concurrency, Callback Retry, Audit Log, Debug Removal & H2H Status', () => {
    const harness = createServerHarness({ withAxios: true });
    let baseUrl;
    let origAxiosGet;

    before(() => {
        ({ baseUrl, origAxiosGet } = harness.start());
    });

    after(async () => {
        axios.get = origAxiosGet;
        await harness.stop();
    });

    test('BUG-001: endpoint debug POST /api/test telah dihapus dan mengembalikan 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/api/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ probe: true }),
        });
        assert.strictEqual(res.status, 404);
    });

    test('BUG-010: GET /h2h/transactions dan GET /h2h/order/:refOrInvoiceId mendukung paginasi, filter status, dan isolasi user_id (anti-IDOR 404)', async () => {
        const apiKeyPlain = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = hashApiKey(apiKeyPlain);
        let capturedListSql = '';
        let capturedListParams = null;
        let capturedDetailSql = '';

        const sampleTxRow = {
            invoice_id: 'H2H-OWN-001', ref_id: 'REF-OWN-1', product_id: 12,
            product_name: '86 Diamonds', sku: 'DUMMY-ML-86',
            target_game_id: '123456|1001',
            price: '19500', status: 'Success', provider_sn: 'SN-H2H-777',
            created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:01:00.000Z',
        };

        const queryMock = mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('WHERE u.api_key_hash = $2 OR u.api_key = $1')) {
                return {
                    rows: [{
                        id: 701, username: 'reseller_h2h_qa', balance: 250000,
                        api_key: null, api_key_hash: apiKeyHash, api_key_prefix: apiKeyPlain.slice(0, 8),
                        role_id: 4, h2h_callback_url: null, role_name: 'PARTNER',
                    }],
                };
            }
            if (typeof sql === 'string' && sql.includes('SELECT COUNT(*)::int AS total FROM transactions t')) {
                return { rows: [{ total: 1 }] };
            }
            if (typeof sql === 'string' && sql.includes('FROM transactions t') && sql.includes('LIMIT $')) {
                capturedListSql = sql;
                capturedListParams = params;
                return { rows: [sampleTxRow] };
            }
            if (typeof sql === 'string' && sql.includes('WHERE t.user_id = $1 AND (t.invoice_id = $2 OR t.ref_id = $2)')) {
                capturedDetailSql = sql;
                if (params[0] === 701 && (params[1] === 'REF-OWN-1' || params[1] === 'H2H-OWN-001')) {
                    return { rows: [sampleTxRow] };
                }
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            // 1. Daftar transaksi dengan paginasi & filter status valid
            const listRes = await fetch(`${baseUrl}/h2h/transactions?page=1&limit=10&status=success`, {
                headers: { 'X-API-Key': apiKeyPlain },
            });
            const listBody = await listRes.json();
            assert.strictEqual(listRes.status, 200);
            assert.strictEqual(listBody.success, true);
            assert.match(capturedListSql, /WHERE t\.user_id = \$1 AND t\.status = \$2/i);
            assert.doesNotMatch(capturedListSql, /target_server_id/i);
            assert.deepStrictEqual(capturedListParams, [701, 'Success', 10, 0]);
            assert.deepStrictEqual(listBody.pagination, { page: 1, limit: 10, total: 1 });
            assert.strictEqual(listBody.data[0].invoice_id, 'H2H-OWN-001');
            assert.strictEqual(listBody.data[0].target_game_id, '123456');
            assert.strictEqual(listBody.data[0].target_server_id, '1001');
            assert.strictEqual(listBody.data[0].provider_sn, 'SN-H2H-777');
            assert.strictEqual(listBody.data[0].price, 19500);

            // 2. Validasi query invalid -> 400
            const badStatusRes = await fetch(`${baseUrl}/h2h/transactions?status=INVALID`, {
                headers: { 'X-API-Key': apiKeyPlain },
            });
            assert.strictEqual(badStatusRes.status, 400);

            const badLimitRes = await fetch(`${baseUrl}/h2h/transactions?limit=999`, {
                headers: { 'X-API-Key': apiKeyPlain },
            });
            assert.strictEqual(badLimitRes.status, 400);

            // 3. Cek status satu order via ref_id -> 200
            const detailRes = await fetch(`${baseUrl}/h2h/order/REF-OWN-1`, {
                headers: { 'X-API-Key': apiKeyPlain },
            });
            const detailBody = await detailRes.json();
            assert.strictEqual(detailRes.status, 200);
            assert.strictEqual(detailBody.success, true);
            assert.match(capturedDetailSql, /WHERE t\.user_id = \$1 AND \(t\.invoice_id = \$2 OR t\.ref_id = \$2\)/i);
            assert.doesNotMatch(capturedDetailSql, /target_server_id/i);
            assert.strictEqual(detailBody.data.invoice_id, 'H2H-OWN-001');
            assert.strictEqual(detailBody.data.target_game_id, '123456');
            assert.strictEqual(detailBody.data.target_server_id, '1001');
            assert.strictEqual(detailBody.data.status, 'Success');

            // 4. Anti-IDOR: order milik user lain / tidak ada -> 404
            const idorRes = await fetch(`${baseUrl}/h2h/order/H2H-OTHER-USER-999`, {
                headers: { 'X-API-Key': apiKeyPlain },
            });
            assert.strictEqual(idorRes.status, 404);

            // 5. Format parameter ilegal -> 400
            const badParamRes = await fetch(`${baseUrl}/h2h/order/invalid%20id!`, {
                headers: { 'X-API-Key': apiKeyPlain },
            });
            assert.strictEqual(badParamRes.status, 400);
        } finally {
            queryMock.mock.restore();
        }
    });

    test('BUG-012: POST /api/foxy/callback menghapus cooldown jika /v1/status gagal 500 sehingga retry segera memproses Success', async () => {
        const prevSecret = process.env.FOXY_CALLBACK_SECRET;
        process.env.FOXY_CALLBACK_SECRET = 'qa-callback-secret-batch2b-12345';
        clearCallbackCooldownCache();

        let statusCalls = 0;
        let txStatus = 'Pending';
        let savedSn = null;

        axios.get = async () => {
            statusCalls += 1;
            if (statusCalls === 1) {
                const err = new Error('Provider 500');
                err.response = { status: 500, statusText: 'Internal Server Error' };
                throw err;
            }
            return {
                data: {
                    data: {
                        trx_id: 'FOXY-RETRY-2B',
                        product_code: 'DUMMY-ML-19',
                        status: 'SUCCESS',
                        sn: 'SN-RETRY-2B-OK',
                    },
                },
            };
        };

        const queryMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('WHERE t.provider_trx_id = $1')) {
                return {
                    rows: [{
                        id: 801,
                        status: txStatus,
                        price: 5601,
                        product_id: 1,
                        provider_trx_id: 'FOXY-RETRY-2B',
                        provider_sku: 'DUMMY-ML-19',
                    }],
                };
            }
            return { rows: [] };
        });

        const connectMock = mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id = $1 FOR UPDATE')) {
                    return {
                        rows: [{
                            id: 801,
                            user_id: 10,
                            invoice_id: 'TRX-RETRY-2B',
                            product_id: 1,
                            provider_trx_id: 'FOXY-RETRY-2B',
                            status: txStatus,
                            price: 5601,
                        }],
                    };
                }
                if (typeof sql === 'string' && sql.includes('SELECT provider_sku FROM products')) {
                    return { rows: [{ provider_sku: 'DUMMY-ML-19' }] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Success'")) {
                    txStatus = 'Success';
                    savedSn = params[0];
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {},
        }));

        try {
            const firstRes = await fetch(`${baseUrl}/api/foxy/callback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Callback-Token': process.env.FOXY_CALLBACK_SECRET,
                },
                body: JSON.stringify({ trx_id: 'FOXY-RETRY-2B' }),
            });
            assert.strictEqual(firstRes.status, 200);
            assert.strictEqual(statusCalls, 1);
            assert.strictEqual(txStatus, 'Pending');

            // Retry langsung (< 5 detik) setelah provider pulih: wajib TIDAK tertahan cooldown
            const retryRes = await fetch(`${baseUrl}/api/foxy/callback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Callback-Token': process.env.FOXY_CALLBACK_SECRET,
                },
                body: JSON.stringify({ trx_id: 'FOXY-RETRY-2B' }),
            });
            assert.strictEqual(retryRes.status, 200);
            assert.strictEqual(statusCalls, 2, 'Retry pasca-500 harus langsung memanggil /v1/status lagi');
            assert.strictEqual(txStatus, 'Success');
            assert.strictEqual(savedSn, 'SN-RETRY-2B-OK');
        } finally {
            axios.get = origAxiosGet;
            clearCallbackCooldownCache();
            if (prevSecret === undefined) delete process.env.FOXY_CALLBACK_SECRET;
            else process.env.FOXY_CALLBACK_SECRET = prevSecret;
            queryMock.mock.restore();
            connectMock.mock.restore();
        }
    });

    test('BUG-013: POST /api/deposit/request mengunci baris users (FOR UPDATE) sebelum hitung Pending sehingga request paralel dibatasi maksimal 2 (429)', async () => {
        const userToken = fixtures.makeUserToken(702, 'BRONZE', 'qa_dep_race');
        let pendingCount = 0;
        let lockCount = 0;
        let lockedBeforePendingCheck = true;
        let lockTail = Promise.resolve();

        const queryMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users')) {
                return { rows: [{ token_version: 1 }] };
            }
            if (typeof sql === 'string' && sql.includes('FROM payment_methods')) {
                return {
                    rows: [{
                        id: 1,
                        code: 'QRIS',
                        name: 'QRIS',
                        type: 'qris',
                        account_number: null,
                        account_name: 'MIKU Store',
                        qris_image_url: 'https://cdn.example.com/qris.png',
                        instructions: null,
                        is_qris: true,
                        min_amount: 10000,
                    }],
                };
            }
            if (typeof sql === 'string' && sql.includes('FROM deposits') && sql.includes('idempotency_key')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const connectMock = mock.method(pool, 'connect', async () => {
            let releaseMutex = null;
            let hasRowLock = false;
            return {
                query: async (sql) => {
                    if (sql === 'BEGIN') return {};
                    if (typeof sql === 'string' && sql.includes('SELECT id FROM users WHERE id = $1 FOR UPDATE')) {
                        const prev = lockTail;
                        let nextResolve;
                        lockTail = new Promise((r) => { nextResolve = r; });
                        await prev;
                        releaseMutex = nextResolve;
                        hasRowLock = true;
                        lockCount += 1;
                        return { rows: [{ id: 702 }] };
                    }
                    if (typeof sql === 'string' && sql.includes("SELECT COUNT(*) AS count FROM deposits WHERE user_id = $1 AND status = 'Pending'")) {
                        if (!hasRowLock) lockedBeforePendingCheck = false;
                        await new Promise((r) => setTimeout(r, 10));
                        return { rows: [{ count: String(pendingCount) }] };
                    }
                    if (typeof sql === 'string' && sql.includes('INSERT INTO deposits')) {
                        pendingCount += 1;
                        return { rows: [{ id: 900 + pendingCount, created_at: new Date().toISOString() }] };
                    }
                    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                        if (releaseMutex) {
                            const fn = releaseMutex;
                            releaseMutex = null;
                            fn();
                        }
                        return {};
                    }
                    return { rows: [] };
                },
                release: () => {
                    if (releaseMutex) {
                        const fn = releaseMutex;
                        releaseMutex = null;
                        fn();
                    }
                },
            };
        });

        try {
            const responses = await Promise.all(
                Array.from({ length: 6 }, () =>
                    fetch(`${baseUrl}/api/deposit/request`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${userToken}`,
                            'Idempotency-Key': crypto.randomUUID(),
                        },
                        body: JSON.stringify({ amount: 15000, method: 'QRIS' }),
                    })
                )
            );
            const statuses = responses.map((r) => r.status);
            assert.strictEqual(lockedBeforePendingCheck, true, 'FOR UPDATE harus dieksekusi sebelum SELECT COUNT(*) Pending');
            assert.strictEqual(lockCount, 6);
            assert.strictEqual(statuses.filter((s) => s === 201).length, 2);
            assert.strictEqual(statuses.filter((s) => s === 429).length, 4);
        } finally {
            queryMock.mock.restore();
            connectMock.mock.restore();
        }
    });

    test('BUG-014: aksi mutasi admin produk, promo, flash sale, dan WA bot approve/reject mencatat admin_audit_logs', async () => {
        const prevBotToken = process.env.WA_BOT_ADMIN_TOKEN;
        process.env.WA_BOT_ADMIN_TOKEN = 'qa-wabot-secret-batch2b-1234567890-secure';
        const adminToken = fixtures.makeAdminToken(1);
        const recordedActions = [];

        const queryMock = mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users')) {
                return { rows: [{ token_version: 1 }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name FROM users u')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO admin_audit_logs')) {
                recordedActions.push(params[1]);
                return { rowCount: 1 };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO products')) return { rowCount: 1 };
            if (typeof sql === 'string' && sql.includes('UPDATE products SET status')) return { rowCount: 1 };
            if (typeof sql === 'string' && sql.includes('INSERT INTO promo_codes')) {
                return { rows: [{ id: 55, code: 'AUDIT2B', type: 'fixed', value: 500 }] };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE promo_codes SET is_active')) {
                return { rows: [{ id: 55, code: 'AUDIT2B', is_active: false }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id, price FROM products WHERE id = $1')) {
                return { rows: [{ id: 10, price: 15000 }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO flash_sales')) {
                return { rows: [{ id: 77, product_id: 10, discount_price: 16000 }] };
            }
            if (typeof sql === 'string' && sql.includes('DELETE FROM flash_sales')) return { rowCount: 1 };
            return { rows: [] };
        });

        const connectMock = mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('INSERT INTO admin_audit_logs')) {
                    recordedActions.push(params[1]);
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('FROM deposits d') && sql.includes('FOR UPDATE OF d')) {
                    return {
                        rows: [{
                            id: params[0],
                            user_id: 99,
                            username: 'buyer_bot',
                            amount: 25000,
                            unique_code: 0,
                            method: 'QRIS',
                            note: null,
                            status: 'Pending',
                            created_at: new Date().toISOString(),
                        }],
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM balance_history')) return { rows: [] };
                return { rowCount: 1, rows: [] };
            },
            release: () => {},
        }));

        try {
            const r1 = await fetch(`${baseUrl}/api/admin/products`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({ game_id: 1, category_id: 1, name: 'Test Audit Prod', provider_sku: 'SKU-AUD-1', price: 15000 }),
            });
            assert.strictEqual(r1.status, 201);

            const r2 = await fetch(`${baseUrl}/api/admin/products/10/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({ status: 'Inactive' }),
            });
            assert.strictEqual(r2.status, 200);

            const r3 = await fetch(`${baseUrl}/api/admin/promos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({ code: 'AUDIT2B', type: 'fixed', value: 500 }),
            });
            assert.strictEqual(r3.status, 201);

            const r4 = await fetch(`${baseUrl}/api/admin/promos/55/toggle`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({ is_active: false }),
            });
            assert.strictEqual(r4.status, 200);

            const r5 = await fetch(`${baseUrl}/api/admin/flash-sales`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
                body: JSON.stringify({
                    product_id: 10,
                    discount_price: 16000,
                    start_at: '2026-11-20T00:00:00.000Z',
                    end_at: '2026-11-21T00:00:00.000Z',
                }),
            });
            assert.strictEqual(r5.status, 201);

            const r6 = await fetch(`${baseUrl}/api/admin/flash-sales/77`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${adminToken}` },
            });
            assert.strictEqual(r6.status, 200);

            const r7 = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WA_BOT_ADMIN_TOKEN}` },
                body: JSON.stringify({ note: 'ok' }),
            });
            assert.strictEqual(r7.status, 200);

            const r8 = await fetch(`${baseUrl}/api/bot/admin/deposits/43/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WA_BOT_ADMIN_TOKEN}` },
                body: JSON.stringify({ reason: 'bukti tidak valid' }),
            });
            assert.strictEqual(r8.status, 200);

            assert.deepStrictEqual(recordedActions, [
                'admin.product.upsert',
                'admin.product.status',
                'admin.promo.create',
                'admin.promo.toggle',
                'admin.flash_sale.create',
                'admin.flash_sale.delete',
                'wabot.deposit.approve',
                'wabot.deposit.reject',
            ]);
        } finally {
            if (prevBotToken === undefined) delete process.env.WA_BOT_ADMIN_TOKEN;
            else process.env.WA_BOT_ADMIN_TOKEN = prevBotToken;
            queryMock.mock.restore();
            connectMock.mock.restore();
        }
    });
});
