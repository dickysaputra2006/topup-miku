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
});
