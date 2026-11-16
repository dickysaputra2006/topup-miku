const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { pool, axios, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { createPhase13MockDb } = require('../helpers/mockDb');
const { invalidateFoxyProductCache } = require('../../services/foxyClient');
const { clearCallbackCooldownCache } = require('../../routes/foxyCallback.routes');

describe('Phase 15: SEC-013: Connection Pool & 3-Phase Order Flow', () => {
    const harness = createServerHarness({ withAxios: true });
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

    test('SEC-013 (1): /api/order & /h2h/order release DB client before validator, price check & /v1/order, and persist provider_trx_id in Fase (a)', async () => {
        const h2hKey = 'e'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createPhase13MockDb([
            { id: 9301, username: 'sec13_web', role_id: 1, role_name: 'User', balance: 100000 },
            { id: 9302, username: 'sec13_h2h', role_id: 2, role_name: 'Bronze', balance: 100000, api_key: null, api_key_hash: h2hKeyHash, api_key_prefix: h2hKey.slice(0, 8), whitelisted_ips: [] }
        ], [
            {
                id: 71,
                name: 'MLBB 50 Diamonds',
                provider_sku: 'ML50-SEC13',
                price: 10000,
                status: 'Active',
                game_id: 1,
                needs_server_id: true,
                use_manual_prices: false,
                use_custom_margin: false,
                validation_config: { enabled: true, validator: 'Mobile Legends' }
            }
        ]);

        const origPgsKey = process.env.PGS_KEY;
        const origPgsApiKey = process.env.PGS_API_KEY;
        process.env.PGS_KEY = 'test-pgs-key';
        process.env.PGS_API_KEY = 'test-pgs-api-key';

        const snapshots = [];
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        invalidateFoxyProductCache();

        axios.get = async (url) => {
            if (url.includes('/v1/products')) {
                snapshots.push({
                    stage: 'foxy_products',
                    activeClients: db.getActiveClients(),
                    txCount: db.transactions.length
                });
                return { data: { data: [{ product_code: 'ML50-SEC13', product_price: 10000 }] } };
            }
            return { data: {} };
        };

        axios.post = async (url, body) => {
            if (url.includes('pgscode.id')) {
                snapshots.push({
                    stage: 'validator',
                    activeClients: db.getActiveClients(),
                    txCount: db.transactions.length
                });
                return { data: { status: true, data: { username: 'MikuPlayer' } } };
            }
            if (url.includes('/v1/order')) {
                snapshots.push({
                    stage: 'foxy_order',
                    activeClients: db.getActiveClients(),
                    txCount: db.transactions.length,
                    latestTx: db.transactions.length > 0 ? { ...db.transactions[db.transactions.length - 1] } : null,
                    postedTrxId: body.trx_id
                });
                return { data: { status: true } };
            }
            return { data: {} };
        };

        try {
            const webToken = makeUserToken(9301, 'User');
            const webRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': '11111111-1111-4111-8111-111111111301'
                },
                body: JSON.stringify({ productId: 71, targetGameId: '100200', targetServerId: '3001' })
            });
            assert.strictEqual(webRes.status, 201);
            const webBody = await webRes.json();

            assert.strictEqual(db.getActiveClients(), 0, 'Web order must leave 0 active DB clients');
            const webValSnap = snapshots.find((s) => s.stage === 'validator');
            const webProdSnap = snapshots.find((s) => s.stage === 'foxy_products');
            const webOrderSnap = snapshots.find((s) => s.stage === 'foxy_order');
            assert.strictEqual(webValSnap.activeClients, 0, 'Validator HTTP call must hold 0 DB clients');
            assert.strictEqual(webProdSnap.activeClients, 0, 'Foxy price check must hold 0 DB clients');
            assert.strictEqual(webOrderSnap.activeClients, 0, 'Foxy /v1/order must hold 0 DB clients');
            assert.ok(webOrderSnap.latestTx, 'Fase (a) must commit Pending transaction before Fase (b)');
            assert.strictEqual(webOrderSnap.latestTx.status, 'Pending');
            assert.match(webOrderSnap.postedTrxId, /^WEB-/, 'Web trx_id must use WEB- prefix');
            assert.strictEqual(webOrderSnap.latestTx.provider_trx_id, webOrderSnap.postedTrxId, 'provider_trx_id must already be saved in Fase (a) INSERT');
            assert.strictEqual(db.users.get(9301).balance, 89000);

            const committedWebTx = db.transactions.find((t) => t.invoice_id === webBody.invoiceId);
            assert.strictEqual(committedWebTx.status, 'Pending');
            assert.strictEqual(committedWebTx.provider_trx_id, webOrderSnap.postedTrxId, 'Fase (c) must save provider_trx_id');

            // H2H order with invalidated cache so both external HTTP steps run
            snapshots.length = 0;
            invalidateFoxyProductCache();
            const h2hRes = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 71, targetGameId: '400500', targetServerId: '3002', ref_id: 'H2H-SEC13-1' })
            });
            assert.strictEqual(h2hRes.status, 201);
            const h2hBody = await h2hRes.json();

            assert.strictEqual(db.getActiveClients(), 0, 'H2H order must leave 0 active DB clients');
            const h2hValSnap = snapshots.find((s) => s.stage === 'validator');
            const h2hProdSnap = snapshots.find((s) => s.stage === 'foxy_products');
            const h2hOrderSnap = snapshots.find((s) => s.stage === 'foxy_order');
            assert.strictEqual(h2hValSnap.activeClients, 0, 'H2H validator must hold 0 DB clients');
            assert.strictEqual(h2hProdSnap.activeClients, 0, 'H2H Foxy price check must hold 0 DB clients');
            assert.strictEqual(h2hOrderSnap.activeClients, 0, 'H2H Foxy /v1/order must hold 0 DB clients');
            assert.strictEqual(h2hOrderSnap.latestTx.status, 'Pending');
            assert.match(h2hOrderSnap.postedTrxId, /^H2H-PROVIDER-/, 'H2H trx_id must use H2H-PROVIDER- prefix');
            assert.strictEqual(h2hOrderSnap.latestTx.provider_trx_id, h2hOrderSnap.postedTrxId, 'H2H provider_trx_id must already be saved in Fase (a) INSERT');

            const committedH2hTx = db.transactions.find((t) => t.invoice_id === h2hBody.data.invoiceId);
            assert.strictEqual(committedH2hTx.status, 'Pending');
            assert.strictEqual(committedH2hTx.provider_trx_id, h2hOrderSnap.postedTrxId);
            assert.strictEqual(db.users.get(9302).balance, 89000);
        } finally {
            if (origPgsKey === undefined) delete process.env.PGS_KEY;
            else process.env.PGS_KEY = origPgsKey;
            if (origPgsApiKey === undefined) delete process.env.PGS_API_KEY;
            else process.env.PGS_API_KEY = origPgsApiKey;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-013 (2): /api/order & /h2h/order Fase (c) preserves Success if real POST /api/foxy/callback committed Success during Fase (b)', async () => {
        const h2hKey = 'f'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createPhase13MockDb([
            { id: 9303, username: 'sec13_cb_web', role_id: 1, role_name: 'User', balance: 100000 },
            { id: 9304, username: 'sec13_cb_h2h', role_id: 2, role_name: 'Bronze', balance: 100000, api_key: null, api_key_hash: h2hKeyHash, api_key_prefix: h2hKey.slice(0, 8), whitelisted_ips: [] }
        ], [
            {
                id: 72,
                name: 'MLBB 50 Diamonds',
                provider_sku: 'ML50-CB',
                price: 10000,
                status: 'Active',
                game_id: 1,
                needs_server_id: false,
                use_manual_prices: false,
                use_custom_margin: false,
                validation_config: null
            }
        ]);

        const origCallbackSecret = process.env.FOXY_CALLBACK_SECRET;
        process.env.FOXY_CALLBACK_SECRET = 'sec13-race-secret';
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        invalidateFoxyProductCache();

        let simulateRejectAfterSuccess = false;
        let lastPostedTrxId = null;

        axios.get = async (url) => {
            if (url.includes('/v1/products')) {
                return { data: { data: [{ product_code: 'ML50-CB', product_price: 10000 }] } };
            }
            if (url.includes('/v1/status/')) {
                const trxIdFromUrl = decodeURIComponent(url.split('/v1/status/')[1]);
                return {
                    data: {
                        status: true,
                        data: {
                            trx_id: trxIdFromUrl,
                            status: 'SUCCESS',
                            sn: simulateRejectAfterSuccess ? 'SN-CB-H2H' : 'SN-CB-WEB'
                        }
                    }
                };
            }
            return { data: {} };
        };

        axios.post = async (url, body) => {
            if (url.includes('/v1/order')) {
                assert.strictEqual(db.getActiveClients(), 0, 'Must hold 0 DB clients during /v1/order');
                const latestTx = db.transactions[db.transactions.length - 1];
                assert.ok(latestTx, 'Fase (a) transaction must exist during Fase (b)');
                assert.strictEqual(latestTx.provider_trx_id, body.trx_id, 'provider_trx_id must already exist during Fase (b)');
                lastPostedTrxId = body.trx_id;

                // Kirim POST /api/foxy/callback nyata sebelum /v1/order selesai (Fase (b) sedang berjalan)
                clearCallbackCooldownCache();
                const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec13-race-secret`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        trx_id: body.trx_id,
                        status: 'SUCCESS',
                        sn: simulateRejectAfterSuccess ? 'SN-CB-H2H' : 'SN-CB-WEB'
                    })
                });
                assert.strictEqual(cbRes.status, 200, 'Real Foxy callback during Fase (b) must succeed');
                assert.strictEqual(db.getActiveClients(), 0, 'Callback must release DB client');

                if (!simulateRejectAfterSuccess) {
                    return { data: { status: true } };
                }
                const err = new Error('Explicit reject after callback won');
                err.response = { status: 400, data: { status: false } };
                throw err;
            }
            return { data: {} };
        };

        try {
            // Case A: callback set Success before /v1/order returns 200
            const webToken = makeUserToken(9303, 'User');
            const resA = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 72, targetGameId: '123456' })
            });
            assert.strictEqual(resA.status, 201);
            const bodyA = await resA.json();
            const txA = db.transactions.find((t) => t.invoice_id === bodyA.invoiceId);
            assert.strictEqual(txA.status, 'Success', 'Fase (c) must preserve Success');
            assert.strictEqual(txA.provider_trx_id, lastPostedTrxId, 'COALESCE must preserve existing provider_trx_id');
            assert.strictEqual(txA.provider_sn, 'SN-CB-WEB', 'Callback SN must remain intact');
            assert.strictEqual(db.users.get(9303).balance, 89000);

            // Case B: callback set Success while /v1/order explicitly rejects (H2H)
            simulateRejectAfterSuccess = true;
            const resB = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 72, targetGameId: '654321', ref_id: 'CB-BEAT-H2H-1' })
            });
            assert.strictEqual(resB.status, 201);
            const bodyB = await resB.json();
            assert.strictEqual(bodyB.data.status, 'Success');
            const txB = db.transactions.find((t) => t.invoice_id === bodyB.data.invoiceId);
            assert.strictEqual(txB.status, 'Success', 'Fase (c) must not rollback or overwrite Success');
            assert.strictEqual(txB.provider_trx_id, lastPostedTrxId);
            assert.strictEqual(txB.provider_sn, 'SN-CB-H2H');
            assert.strictEqual(db.users.get(9304).balance, 89000, 'Balance must NOT be refunded when Success already committed');
            assert.strictEqual(db.balanceHistory.filter((h) => h.reference_id === txB.invoice_id && h.type === 'Refund').length, 0);
        } finally {
            if (origCallbackSecret === undefined) delete process.env.FOXY_CALLBACK_SECRET;
            else process.env.FOXY_CALLBACK_SECRET = origCallbackSecret;
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-013 (3): /api/order & /h2h/order timeout keeps Pending and saves provider_trx_id in Fase (c), explicit 400 refunds without holding connections', async () => {
        const h2hKey = 'a'.repeat(64);
        const h2hKeyHash = crypto.createHash('sha256').update(h2hKey).digest('hex');
        const db = createPhase13MockDb([
            { id: 9305, username: 'sec13_to_web', role_id: 1, role_name: 'User', balance: 100000 },
            { id: 9306, username: 'sec13_err_h2h', role_id: 2, role_name: 'Bronze', balance: 100000, api_key: null, api_key_hash: h2hKeyHash, api_key_prefix: h2hKey.slice(0, 8), whitelisted_ips: [] }
        ], [
            {
                id: 73,
                name: 'MLBB 50 Diamonds',
                provider_sku: 'ML50-TO',
                price: 10000,
                status: 'Active',
                game_id: 1,
                needs_server_id: false,
                use_manual_prices: false,
                use_custom_margin: false,
                validation_config: null
            }
        ]);

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);
        invalidateFoxyProductCache();

        axios.get = async () => ({ data: { data: [{ product_code: 'ML50-TO', product_price: 10000 }] } });

        let mode = 'timeout';
        let lastPostedTrxId = null;
        axios.post = async (url, body) => {
            if (url.includes('/v1/order')) {
                assert.strictEqual(db.getActiveClients(), 0, 'Must release DB client before /v1/order');
                lastPostedTrxId = body.trx_id;
                const latestTx = db.transactions[db.transactions.length - 1];
                assert.strictEqual(latestTx.provider_trx_id, body.trx_id, 'Fase (a) already commits provider_trx_id before Fase (b)');
                if (mode === 'timeout') {
                    const toErr = new Error('timeout of 15000ms exceeded');
                    toErr.code = 'ECONNABORTED';
                    throw toErr;
                }
                const err = new Error('Bad Request from provider');
                err.response = { status: 400, data: { status: false } };
                throw err;
            }
            return { data: {} };
        };

        try {
            // 1. Timeout on Web /api/order -> returns 201, keeps Pending, saves provider_trx_id in Fase (c), no refund
            const webToken = makeUserToken(9305, 'User');
            const toRes = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 73, targetGameId: '111222' })
            });
            assert.strictEqual(toRes.status, 201);
            const toBody = await toRes.json();
            const txTo = db.transactions.find((t) => t.invoice_id === toBody.invoiceId);
            assert.strictEqual(txTo.status, 'Pending');
            assert.strictEqual(txTo.provider_trx_id, lastPostedTrxId, 'Timeout path must still save provider_trx_id in Fase (c) for cron');
            assert.strictEqual(db.users.get(9305).balance, 89000);
            assert.strictEqual(db.getActiveClients(), 0);

            // 2. Explicit 400 on H2H /h2h/order -> returns 400, sets Failed, refunds balance, no leaked clients
            mode = 'reject';
            const rejRes = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 73, targetGameId: '333444', ref_id: 'REJ-H2H-1' })
            });
            assert.strictEqual(rejRes.status, 400);
            const txRej = db.transactions.find((t) => t.ref_id === 'REJ-H2H-1');
            assert.strictEqual(txRej.status, 'Failed');
            assert.strictEqual(db.users.get(9306).balance, 100000);
            assert.strictEqual(db.balanceHistory.filter((h) => h.reference_id === txRej.invoice_id && h.type === 'Refund').length, 1);
            assert.strictEqual(db.getActiveClients(), 0);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });
});
