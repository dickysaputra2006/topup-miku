const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { pool, axios, cronUtils, cronPool, serverMod, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { createPhase13MockDb } = require('../helpers/mockDb');
const { webhookDns } = require('../../utils/webhookClient');
const { invalidateFoxyProductCache, clearCallbackCooldownCache } = serverMod;

describe('Phase 15: SEC-013: Connection Pool & 3-Phase Order Flow', () => {
    const harness = createServerHarness({ withAxios: true, withCronPool: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id, role = 'User') {
        return fixtures.makeUserToken(id, role, `sec13_user_${id}`);
    }

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
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

        const mailerPath = require.resolve('../../utils/mailer');
        delete require.cache[mailerPath];

        const { validateGameId } = require('../../utils/validators/cek-id-game');
        const { cekPromoMcggMobapay } = require('../../utils/validators/stalk-mcgg');
        const { checkAllMobapayPromosML, checkMobapayMlbbEligibility } = require('../../utils/validators/stalk-ml-promo');
        const { sendPasswordResetEmail } = require('../../utils/mailer');

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
