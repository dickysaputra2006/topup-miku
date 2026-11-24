const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool, axios, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { createTransactionalMockDb } = require('../helpers/mockDb');
const { invalidateFoxyProductCache } = require('../../services/foxyClient');
const { clearCallbackCooldownCache } = require('../../routes/foxyCallback.routes');

const FORBIDDEN_VENDOR_RE = /foxy|foxygamestore|pgscode|mobapay|buy_price|cost_price|provider_price|base_price|provider_response|foxy_trx_id/i;
const FRONTEND_VENDOR_RE = /foxy|foxygamestore|buy_price|cost_price|provider_price|base_price|provider_response|foxy_trx_id|FOXY_API_KEY/i;

function collectFrontendBuyerFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const norm = full.replace(/\\/g, '/');
        if (entry.isDirectory()) {
            if (norm.endsWith('/js/admin')) continue;
            collectFrontendBuyerFiles(full, results);
        } else if (/\.(html|js|css)$/i.test(entry.name)) {
            if (norm.endsWith('/frontend/admin.html')) continue;
            results.push(full);
        }
    }
    return results.sort();
}

describe('Pre-Deploy Security Audit — Area 3 (Anti-Bypass Foxy) & Area 4 (Strict White-Label)', () => {
    const harness = createServerHarness({ withAxios: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    // === AREA 3 ===
    test('Area 3.1: saldo kurang/nol atau input invalid kirim 0 HTTP call ke Foxy (Web & H2H)', async () => {
        const zeroKey = '1'.repeat(64);
        const lowKey = '2'.repeat(64);
        const db = createTransactionalMockDb(
            [
                { id: 8101, username: 'web_zero', role_id: 1, role_name: 'BRONZE', balance: 0 },
                { id: 8102, username: 'web_low', role_id: 1, role_name: 'BRONZE', balance: 5000 },
                { id: 8103, username: 'h2h_zero', role_id: 2, role_name: 'PARTNER', balance: 0, api_key_hash: crypto.createHash('sha256').update(zeroKey).digest('hex') },
                { id: 8104, username: 'h2h_low', role_id: 2, role_name: 'PARTNER', balance: 5000, api_key_hash: crypto.createHash('sha256').update(lowKey).digest('hex') }
            ],
            [
                { id: 811, name: 'MLBB 86', provider_sku: 'SKU-ZERO', price: 10000, status: 'Active', game_id: 1, needs_server_id: false, use_manual_prices: false, use_custom_margin: false, validation_config: null },
                { id: 812, name: 'MLBB NeedSrv', provider_sku: 'SKU-SRV', price: 10000, status: 'Active', game_id: 2, needs_server_id: true, use_manual_prices: false, use_custom_margin: false, validation_config: null }
            ]
        );

        let foxyGetCalls = 0;
        let foxyPostCalls = 0;
        axios.get = async () => { foxyGetCalls += 1; return { data: { data: [] } }; };
        axios.post = async () => { foxyPostCalls += 1; return { data: { status: true } }; };
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            invalidateFoxyProductCache();
            const tokZero = fixtures.makeUserToken(8101, 'BRONZE', 'web_zero');
            const tokLow = fixtures.makeUserToken(8102, 'BRONZE', 'web_low');

            const responses = await Promise.all([
                fetch(`${baseUrl}/api/order`, { method: 'POST', headers: { 'Authorization': `Bearer ${tokZero}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 811, targetGameId: '1001' }) }),
                fetch(`${baseUrl}/api/order`, { method: 'POST', headers: { 'Authorization': `Bearer ${tokLow}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 811, targetGameId: '1002' }) }),
                fetch(`${baseUrl}/api/order`, { method: 'POST', headers: { 'Authorization': `Bearer ${tokLow}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 812, targetGameId: '1003' }) }),
                fetch(`${baseUrl}/api/order`, { method: 'POST', headers: { 'Authorization': `Bearer ${tokLow}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 99999, targetGameId: '1004' }) }),
                fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': zeroKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 811, targetGameId: '2001' }) }),
                fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': lowKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 811, targetGameId: '2002' }) }),
                fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': lowKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 812, targetGameId: '2003' }) })
            ]);
            for (const r of responses) {
                assert.strictEqual(r.status, 400);
            }
            assert.strictEqual(foxyGetCalls, 0, '0 HTTP GET ke Foxy diizinkan saat saldo tidak cukup atau validasi awal gagal');
            assert.strictEqual(foxyPostCalls, 0, '0 HTTP POST ke Foxy diizinkan saat saldo tidak cukup atau validasi awal gagal');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('Area 3.2: /api/foxy/callback fail-closed tanpa secret valid & anti double-refund saat replay FAILED', async () => {
        const origSecret = process.env.FOXY_CALLBACK_SECRET;
        process.env.FOXY_CALLBACK_SECRET = 'predeploy-cb-secret';
        clearCallbackCooldownCache();

        let statusVerifyCalls = 0;
        let refundCredits = 0;
        const txState = { id: 901, invoice_id: 'TRX-CB-901', user_id: 8201, product_id: 1, price: 11000, status: 'Pending', provider_trx_id: 'WEB-CB-901', flash_sale_id: null, flash_sale_restored: false };
        const refundRefs = new Set();

        axios.get = async (url) => {
            statusVerifyCalls += 1;
            if (url.includes('/v1/status/')) {
                return { data: { status: true, data: { trx_id: 'WEB-CB-901', status: 'FAILED', product_code: 'SKU-CB', message: 'Upstream gagal' } } };
            }
            return { data: {} };
        };

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t') && sql.includes('t.provider_trx_id = $1')) {
                return { rows: [{ ...txState, provider_sku: 'SKU-CB' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql, params = []) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id = $1 FOR UPDATE')) {
                    return { rows: [{ ...txState }] };
                }
                if (typeof sql === 'string' && sql.includes('SELECT provider_sku FROM products WHERE id = $1')) {
                    return { rows: [{ provider_sku: 'SKU-CB' }] };
                }
                if (typeof sql === 'string' && sql.includes("SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund'")) {
                    return { rows: refundRefs.has(params[0]) ? [{ id: 1 }] : [] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    if (!['Pending', 'Processing', 'Partial Refund'].includes(txState.status)) return { rowCount: 0 };
                    txState.status = 'Failed';
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance + $1')) {
                    refundCredits += 1;
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO balance_history')) {
                    refundRefs.add(params[3]);
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const rNoTok = await fetch(`${baseUrl}/api/foxy/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trx_id: 'WEB-CB-901', status: 'FAILED' }) });
            const rBadTok = await fetch(`${baseUrl}/api/foxy/callback?token=wrong-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trx_id: 'WEB-CB-901', status: 'FAILED' }) });
            assert.strictEqual(rNoTok.status, 403);
            assert.strictEqual(rBadTok.status, 403);
            assert.strictEqual(statusVerifyCalls, 0);
            assert.strictEqual(refundCredits, 0);

            const rValid = await fetch(`${baseUrl}/api/foxy/callback?token=predeploy-cb-secret`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-CB-901', status: 'FAILED' })
            });
            assert.strictEqual(rValid.status, 200);
            assert.strictEqual(refundCredits, 1);

            const rReplay = await fetch(`${baseUrl}/api/foxy/callback?token=predeploy-cb-secret`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'WEB-CB-901', status: 'FAILED' })
            });
            assert.strictEqual(rReplay.status, 200);
            assert.strictEqual(refundCredits, 1, 'Replay callback FAILED tidak boleh melakukan double refund');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = origSecret;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    test('Area 3.3 & 3.4: /api/admin/sync-products khusus Admin & error HTTP tidak bocorkan FOXY_API_KEY / FOXY_BASE_URL', async () => {
        const partnerToken = fixtures.makeUserToken(8301, 'PARTNER', 'reseller_no_sync');
        let syncFoxyCalls = 0;
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users WHERE id = $1')) return { rows: [{ token_version: 1 }] };
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return { rows: [{ id: 831, name: 'Test Product', provider_sku: 'SKU-SEC', price: 10000, status: 'Active', game_id: 1, needs_server_id: false, use_manual_prices: false, use_custom_margin: false, validation_config: null }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) return { rows: [{ balance: 100000, role_id: 1, role_name: 'PARTNER' }] };
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) return { rows: [{ margin_percent: 5 }] };
                return { rows: [] };
            },
            release: () => {}
        }));
        axios.get = async () => {
            syncFoxyCalls += 1;
            const err = new Error(`connect ECONNREFUSED https://api.foxygamestore.com key=${process.env.FOXY_API_KEY}`);
            err.code = 'ECONNREFUSED';
            throw err;
        };

        try {
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/sync-products`, { method: 'POST' })).status, 401);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/sync-products`, { method: 'POST', headers: { 'Authorization': `Bearer ${partnerToken}` } })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/sync-products`, { method: 'POST', headers: { 'X-API-Key': '3'.repeat(64) } })).status, 401);
            assert.strictEqual(syncFoxyCalls, 0);

            invalidateFoxyProductCache();
            const ordErrRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${partnerToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 831, targetGameId: '987654' })
            });
            assert.strictEqual(ordErrRes.status, 400);
            const rawErr = JSON.stringify(await ordErrRes.json());
            assert.ok(!rawErr.includes(process.env.FOXY_API_KEY));
            assert.ok(!/foxygamestore\.com|FOXY_API_KEY/i.test(rawErr));
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    // === AREA 4 ===
    test('Area 4.1: runtime white-label — identitas Foxy/PGS/Mobapay & harga modal tidak bocor ke buyer/reseller/webhook', async () => {
        const origSecret = process.env.FOXY_CALLBACK_SECRET;
        const origPgsKey = process.env.PGS_KEY;
        const origPgsApiKey = process.env.PGS_API_KEY;
        process.env.FOXY_CALLBACK_SECRET = 'wl-cb-secret';
        process.env.PGS_KEY = 'dummy-pgs-key';
        process.env.PGS_API_KEY = 'dummy-pgs-api';
        clearCallbackCooldownCache();

        const h2hKey = '9'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const balanceHistoryRows = [];
        let capturedWebhookBody = null;
        let markWebhookDone;
        const webhookPromise = new Promise((resolve) => { markWebhookDone = resolve; });

        const txRecord = {
            id: 951, invoice_id: 'H2H-WL-951', user_id: 8401, product_id: 841,
            price: 10500, status: 'Pending', provider_trx_id: 'H2H-PROVIDER-WL-951',
            flash_sale_id: null, flash_sale_restored: false
        };

        axios.get = async (url) => {
            if (url.includes('/v1/status/')) {
                return {
                    data: {
                        status: true,
                        data: {
                            trx_id: 'H2H-PROVIDER-WL-951',
                            status: 'FAILED',
                            product_code: 'SKU-WL',
                            message: 'Foxy Game Store: insufficient balance on https://api.foxygamestore.com'
                        }
                    }
                };
            }
            return { data: { data: [{ product_code: 'SKU-WL', product_price: 10000 }] } };
        };
        axios.post = async (url, data) => {
            if (url.includes('pgscode.id')) {
                return { data: { status: false, message: 'PGSCODE error from FoxyGameStore https://pgscode.id' } };
            }
            if (url.includes('93.184.216.34')) {
                capturedWebhookBody = typeof data === 'string' ? data : JSON.stringify(data);
                markWebhookDone();
                return { status: 200, data: { ok: true } };
            }
            return { data: { status: false, message: 'Foxy Game Store rejected order' } };
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('SELECT token_version FROM users WHERE id = $1')) return { rows: [{ token_version: 1 }] };
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return params[1] === h2hKeyHash
                    ? { rows: [{ id: 8401, username: 'reseller_wl', balance: 50000, role_id: 2, role_name: 'PARTNER', api_key_hash: h2hKeyHash }] }
                    : { rows: [] };
            }
            if (sql.includes('FROM products p') && sql.includes('WHERE p.id = $1')) {
                return { rows: [{ id: 841, name: 'ML 50', validation_config: { enabled: true, validator: 'mobile-legends' }, game_id: 1, needs_server_id: true }] };
            }
            if (sql.includes('SELECT role_id, r.name as role_name FROM users')) return { rows: [{ role_id: 2, role_name: 'PARTNER' }] };
            if (sql.includes("SELECT name, image_url") && sql.includes('FROM games')) return { rows: [{ name: 'ML', image_url: '/ml.png', needs_server_id: true, target_id_label: 'ID' }] };
            if (sql.includes('p.price as base_price') && sql.includes('FROM products p')) {
                return { rows: [{ id: 841, name: 'ML 50', provider_sku: 'SKU-WL', base_price: 10000, use_manual_prices: false, manual_prices: null, use_custom_margin: false }] };
            }
            if (sql.includes('SELECT name, margin_percent FROM roles') || sql.includes('SELECT margin_percent FROM roles WHERE id = $1')) {
                return { rows: [{ name: 'PARTNER', margin_percent: 5 }] };
            }
            if (sql.includes('SELECT p.id, p.name, p.provider_sku')) {
                return { rows: [{ id: 841, name: 'ML 50', provider_sku: 'SKU-WL', base_price: 10000, category: 'Diamonds', game_name: 'ML', use_manual_prices: false, manual_prices: null, use_custom_margin: false }] };
            }
            if (sql.includes('FROM transactions t') && sql.includes('t.provider_trx_id = $1')) {
                return { rows: [{ ...txRecord, provider_sku: 'SKU-WL' }] };
            }
            if (sql.includes('SELECT u.h2h_callback_url, u.h2h_webhook_secret')) {
                return { rows: [{ h2h_callback_url: 'https://93.184.216.34/webhook', h2h_webhook_secret: 'wh-sec-wl', product_name: 'ML 50' }] };
            }
            if (sql.includes('FROM balance_history WHERE user_id = $1')) {
                return { rows: [...balanceHistoryRows, { amount: 5000, type: 'Refund', description: 'Refund Foxy https://api.foxygamestore.com (TRX-LEGACY)', reference_id: 'TRX-LEGACY', created_at: new Date().toISOString() }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params = []) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return { rows: [{ id: 841, name: 'ML 50', provider_sku: 'SKU-WL', price: 10000, status: 'Active', game_id: 1, needs_server_id: false, use_manual_prices: false, use_custom_margin: false, validation_config: null }] };
                }
                if (typeof sql === 'string' && sql.includes('SELECT balance, role_id FROM users')) return { rows: [{ balance: 50000, role_id: 2 }] };
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) return { rows: [{ margin_percent: 5 }] };
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) return { rows: [{ ...txRecord }] };
                if (typeof sql === 'string' && sql.includes('SELECT provider_sku FROM products WHERE id = $1')) return { rows: [{ provider_sku: 'SKU-WL' }] };
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance')) return { rowCount: 1 };
                if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) return { rows: [{ id: 952 }] };
                if (typeof sql === 'string' && sql.includes('SELECT id, status, provider_trx_id')) return { rows: [{ id: 952, status: 'Pending', provider_trx_id: 'H2H-X', flash_sale_id: null, flash_sale_restored: false }] };
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) { if (params[0] === txRecord.id) txRecord.status = 'Failed'; return { rowCount: 1 }; }
                if (typeof sql === 'string' && sql.includes('INSERT INTO balance_history')) {
                    balanceHistoryRows.push({ amount: params[1], type: 'Refund', description: params[2], reference_id: params[3], created_at: new Date().toISOString() });
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const partnerToken = fixtures.makeUserToken(8401, 'PARTNER', 'reseller_wl');
            const preValRes = await fetch(`${baseUrl}/api/products/841/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: '123', zoneId: '1' }) });
            const fullValRes = await fetch(`${baseUrl}/api/full-validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameCode: 'mobile-legends', userId: '123', zoneId: '1' }) });
            const h2hOrdRes = await fetch(`${baseUrl}/h2h/order`, { method: 'POST', headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 841, targetGameId: '12345' }) });
            const catRes = await fetch(`${baseUrl}/api/games/1/products`, { headers: { 'Authorization': `Bearer ${partnerToken}` } });
            const h2hProdRes = await fetch(`${baseUrl}/h2h/products`, { headers: { 'X-API-Key': h2hKey } });

            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=wl-cb-secret`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'H2H-PROVIDER-WL-951', status: 'FAILED' })
            });
            assert.strictEqual(cbRes.status, 200);
            await Promise.race([webhookPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('Webhook timeout')), 2000))]);

            const bhRes = await fetch(`${baseUrl}/api/user/balance-history`, { headers: { 'Authorization': `Bearer ${partnerToken}` } });
            const allPayloads = JSON.stringify({
                preVal: await preValRes.json(),
                fullVal: await fullValRes.json(),
                h2hOrd: await h2hOrdRes.json(),
                cat: await catRes.json(),
                h2hProd: await h2hProdRes.json(),
                bh: await bhRes.json(),
                webhook: capturedWebhookBody,
                savedRefundDescriptions: balanceHistoryRows.map((r) => r.description)
            });
            assert.doesNotMatch(allPayloads, FORBIDDEN_VENDOR_RE, 'Tidak boleh ada kata Foxy/PGS/Mobapay atau harga modal di respons buyer/reseller/ledger/webhook');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = origSecret;
            process.env.PGS_KEY = origPgsKey;
            process.env.PGS_API_KEY = origPgsApiKey;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('Area 4.2: audit statis frontend buyer & reseller bebas referensi Foxy/harga modal/secret', () => {
        const frontendDir = path.resolve(__dirname, '..', '..', '..', 'frontend');
        const files = collectFrontendBuyerFiles(frontendDir);
        assert.ok(files.length >= 20, 'Harus memindai seluruh berkas buyer/reseller frontend');

        const violations = [];
        for (const filePath of files) {
            const text = fs.readFileSync(filePath, 'utf8');
            const m = text.match(FRONTEND_VENDOR_RE);
            if (m) {
                violations.push(`${path.relative(frontendDir, filePath)}: matched "${m[0]}"`);
            }
        }
        assert.deepStrictEqual(violations, [], `Ditemukan kebocoran vendor/harga modal di frontend non-admin: ${violations.join('; ')}`);
    });
});
