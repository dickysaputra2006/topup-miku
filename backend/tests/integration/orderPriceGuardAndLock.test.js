const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, axios, cronUtils, cronPool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 11: SEC-002 & SEC-003 Compensation, Promo Cost Guard & Cache Hardening', () => {
    const harness = createServerHarness({ withAxios: true, withCronPool: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id = 42, role = 'BRONZE') {
        return fixtures.makeUserToken(id, role, `user${id}`);
    }

    function makeAdminToken(id = 1) {
        return fixtures.makeAdminToken(id, 'admin');
    }

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
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
            const serverMod = require('../../server.js');
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
        require('../../server.js').invalidateFoxyProductCache();

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
