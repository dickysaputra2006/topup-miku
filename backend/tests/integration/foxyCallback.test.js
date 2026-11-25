const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, axios, createServerHarness } = require('../helpers/appFactory');
const { validateEnvironment } = require('../../config/env');
const { callbackClock, clearCallbackCooldownCache } = require('../../routes/foxyCallback.routes');

describe('SEC-001: Foxy Callback Security Hardening', () => {
    const harness = createServerHarness({ withAxios: true });
    let secCallbackUrl;
    let origAxiosGet;

    before(() => {
        const started = harness.start();
        secCallbackUrl = `${started.baseUrl}/api/foxy/callback`;
        origAxiosGet = started.origAxiosGet;
    });

    after(async () => {
        delete process.env.FOXY_CALLBACK_SECRET_PREVIOUS;
        delete process.env.ALLOW_INSECURE_CALLBACK;
        process.env.FOXY_CALLBACK_SECRET = '';
        if (typeof clearCallbackCooldownCache === 'function') clearCallbackCooldownCache();
        await harness.stop();
    });

    test('validateEnvironment wajib menolak startup production jika FOXY_CALLBACK_SECRET kosong', () => {
        const prevNodeEnv = process.env.NODE_ENV;
        const prevSecret = process.env.FOXY_CALLBACK_SECRET;
        const prevAllow = process.env.ALLOW_INSECURE_CALLBACK;

        try {
            process.env.NODE_ENV = 'production';
            process.env.FOXY_CALLBACK_SECRET = '';
            process.env.ALLOW_INSECURE_CALLBACK = 'true';
            assert.throws(
                () => validateEnvironment({ strict: true }),
                /FOXY_CALLBACK_SECRET/,
                'NODE_ENV=production must fail startup when FOXY_CALLBACK_SECRET is empty'
            );

            process.env.FOXY_CALLBACK_SECRET = 'prod-strong-secret-value';
            assert.doesNotThrow(
                () => validateEnvironment({ strict: true }),
                'NODE_ENV=production should start when FOXY_CALLBACK_SECRET is set'
            );
        } finally {
            if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prevNodeEnv;
            process.env.FOXY_CALLBACK_SECRET = prevSecret || '';
            if (prevAllow === undefined) delete process.env.ALLOW_INSECURE_CALLBACK;
            else process.env.ALLOW_INSECURE_CALLBACK = prevAllow;
        }
    });

    test('fail-closed: tanpa secret ditolak 403, hanya bisa dilewati non-prod dengan ALLOW_INSECURE_CALLBACK=true', async () => {
        const prevNodeEnv = process.env.NODE_ENV;
        const prevSecret = process.env.FOXY_CALLBACK_SECRET;
        const prevAllow = process.env.ALLOW_INSECURE_CALLBACK;

        let foxyCalled = 0;
        axios.get = async () => {
            foxyCalled += 1;
            return { data: { status: true, data: { status: 'SUCCESS' } } };
        };
        mock.method(pool, 'query', async () => ({ rows: [] }));

        try {
            process.env.NODE_ENV = 'test';
            process.env.FOXY_CALLBACK_SECRET = '';
            delete process.env.ALLOW_INSECURE_CALLBACK;

            const resNoSecret = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FAILCLOSED-1', status: 'SUCCESS', sn: 'SN-FC-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resNoSecret.status, 403, 'Callback without configured secret must fail-closed with 403');
            assert.strictEqual(foxyCalled, 0);

            // Production MUST ignore ALLOW_INSECURE_CALLBACK=true
            process.env.NODE_ENV = 'production';
            process.env.ALLOW_INSECURE_CALLBACK = 'true';
            const resProdOptIn = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FAILCLOSED-2', status: 'SUCCESS', sn: 'SN-FC-2', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resProdOptIn.status, 403, 'Production must never honor ALLOW_INSECURE_CALLBACK=true');

            // Local/non-production with ALLOW_INSECURE_CALLBACK=true allows missing secret
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_INSECURE_CALLBACK = 'true';
            const resLocalOptIn = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FAILCLOSED-3', status: 'SUCCESS', sn: 'SN-FC-3', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resLocalOptIn.status, 200);
            assert.deepStrictEqual(await resLocalOptIn.json(), { message: 'Callback berhasil diproses.' });
        } finally {
            axios.get = origAxiosGet;
            pool.query.mock.restore();
            if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prevNodeEnv;
            process.env.FOXY_CALLBACK_SECRET = prevSecret || '';
            if (prevAllow === undefined) delete process.env.ALLOW_INSECURE_CALLBACK;
            else process.env.ALLOW_INSECURE_CALLBACK = prevAllow;
        }
    });

    test('tanpa token atau token salah ditolak 403 tanpa panggil Foxy', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-primary-secret-token';
        let foxyCalled = 0;
        axios.get = async () => {
            foxyCalled += 1;
            return { data: { status: true, data: { status: 'SUCCESS' } } };
        };

        try {
            const resMissing = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-NO-TOKEN', status: 'SUCCESS', sn: 'SN-AUTH-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resMissing.status, 403);

            const resWrongLen = await fetch(`${secCallbackUrl}?token=short`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-WRONG-LEN', status: 'SUCCESS', sn: 'SN-AUTH-2', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resWrongLen.status, 403);

            const resArrayQuery = await fetch(`${secCallbackUrl}?token=sec1-primary-secret-token&token=extra`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-ARR-TOKEN', status: 'SUCCESS', sn: 'SN-AUTH-3', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resArrayQuery.status, 403);
            assert.strictEqual(foxyCalled, 0);
        } finally {
            axios.get = origAxiosGet;
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('token di query ?token=, rotasi FOXY_CALLBACK_SECRET_PREVIOUS, dan tidak bocor ke log', async () => {
        const curSecret = 'rot-current-secret-987654';
        const prevSecret = 'rot-previous-secret-123456';
        process.env.FOXY_CALLBACK_SECRET = curSecret;
        process.env.FOXY_CALLBACK_SECRET_PREVIOUS = prevSecret;

        const loggedMessages = [];
        const origLog = console.log;
        const origWarn = console.warn;
        const origErr = console.error;
        console.log = (...args) => loggedMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
        console.warn = (...args) => loggedMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
        console.error = (...args) => loggedMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));

        axios.get = async (url) => {
            const err = new Error(`Simulated Foxy error for ${url}?token=${curSecret}`);
            err.response = {
                status: 500,
                statusText: 'Internal Error',
                headers: {},
                config: { method: 'GET', url: `${url}?token=${curSecret}` }
            };
            throw err;
        };

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9101, status: 'Pending', price: 10000, product_id: 2, provider_trx_id: 'SEC1-ROT-1', provider_sku: 'SKU-ROT', product_price: 9000 }] };
            }
            return { rows: [] };
        });

        try {
            // Token baru via query ?token=
            const resCur = await fetch(`${secCallbackUrl}?token=${encodeURIComponent(curSecret)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-ROT-1', status: 'SUCCESS', sn: 'SN-ROT-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resCur.status, 200);
            assert.deepStrictEqual(await resCur.json(), { message: 'Callback berhasil diproses.' });

            // Token lama via query ?token= saat masa rotasi
            const resPrevQuery = await fetch(`${secCallbackUrl}?token=${encodeURIComponent(prevSecret)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-ROT-2-UNKNOWN', status: 'SUCCESS', sn: 'SN-ROT-2', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resPrevQuery.status, 200);
            assert.deepStrictEqual(await resPrevQuery.json(), { message: 'Callback berhasil diproses.' });

            // Token lama via header X-Callback-Token
            const resPrevHeader = await fetch(secCallbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-callback-token': prevSecret },
                body: JSON.stringify({ trx_id: 'SEC1-ROT-3-UNKNOWN', status: 'SUCCESS', sn: 'SN-ROT-3', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resPrevHeader.status, 200);
            assert.deepStrictEqual(await resPrevHeader.json(), { message: 'Callback berhasil diproses.' });

            const combinedLogs = loggedMessages.join('\n');
            assert.strictEqual(combinedLogs.includes(curSecret), false, 'Current callback token must NEVER appear in logs');
            assert.strictEqual(combinedLogs.includes(prevSecret), false, 'Previous callback token must NEVER appear in logs');
        } finally {
            console.log = origLog;
            console.warn = origWarn;
            console.error = origErr;
            axios.get = origAxiosGet;
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
            delete process.env.FOXY_CALLBACK_SECRET_PREVIOUS;
        }
    });

    test('zero-trust payload: sn/message/status di req.body tidak pernah dipakai atau tersimpan', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-zt-secret';

        let savedSnParam = null;
        let savedSnWithNoSn = 'UNTOUCHED';
        let savedRefundDescription = '';
        let foxyMode = 'SUCCESS_NO_SN';

        axios.get = async (url) => {
            if (foxyMode === 'SUCCESS_NO_SN') {
                return { data: { status: true, data: { trx_id: 'SEC1-ZT-1', status: 'SUCCESS', product_code: 'SKU-ZT', product_price: 9000 } } };
            }
            return { data: { status: true, data: { trx_id: 'SEC1-ZT-2', status: 'FAILED', message: 'UPSTREAM-VERIFIED-REASON', product_code: 'SKU-ZT', product_price: 9000 } } };
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                const trxId = params && params[0];
                return { rows: [{ id: trxId === 'SEC1-ZT-1' ? 9201 : 9202, status: 'Pending', price: 10000, product_id: 3, provider_trx_id: trxId, provider_sku: 'SKU-ZT', product_price: 9000 }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    const trxId = params && params[0];
                    return {
                        rows: [{
                            id: trxId === 'SEC1-ZT-1' ? 9201 : 9202,
                            invoice_id: trxId === 'SEC1-ZT-1' ? 'INV-ZT-1' : 'INV-ZT-2',
                            user_id: 33,
                            product_id: 3,
                            status: 'Pending',
                            price: 10000,
                            provider_trx_id: trxId
                        }]
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM products WHERE id')) {
                    return { rows: [{ provider_sku: 'SKU-ZT', price: 9000 }] };
                }
                if (typeof sql === 'string' && sql.includes("SET status = 'Success', provider_sn")) {
                    savedSnParam = params && params[0];
                }
                if (typeof sql === 'string' && sql.includes("SET status = 'Success', updated_at")) {
                    savedSnWithNoSn = null;
                }
                if (typeof sql === 'string' && sql.includes("INSERT INTO balance_history") && sql.includes("'Refund'")) {
                    savedRefundDescription = params && params[2];
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            // 1. Body menyuntikkan sn/serial_number/provider_sn palsu, Foxy tidak mengembalikan SN -> SN body DILARANG tersimpan
            foxyMode = 'SUCCESS_NO_SN';
            const res1 = await fetch(`${secCallbackUrl}?token=sec1-zt-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trx_id: 'SEC1-ZT-1',
                    status: 'FAILED',
                    sn: 'SPOOFED-BODY-SN',
                    serial_number: 'SPOOFED-SERIAL',
                    provider_sn: 'SPOOFED-PSN',
                    message: 'SPOOFED-MESSAGE'
                })
            });
            assert.strictEqual(res1.status, 200);
            assert.deepStrictEqual(await res1.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(savedSnParam, null, 'Spoofed SN in req.body must NEVER be saved to provider_sn');
            assert.strictEqual(savedSnWithNoSn, null, 'Should update Success without req.body SN fallback');

            // 2. Body mengaku SUCCESS & menyuntikkan message palsu, Foxy bilang FAILED dengan message asli
            foxyMode = 'FAILED_WITH_MSG';
            const res2 = await fetch(`${secCallbackUrl}?token=sec1-zt-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    trx_id: 'SEC1-ZT-2',
                    status: 'SUCCESS',
                    sn: 'SPOOFED-SN-2',
                    message: 'SPOOFED-BODY-REASON'
                })
            });
            assert.strictEqual(res2.status, 200);
            assert.deepStrictEqual(await res2.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(savedRefundDescription.includes('SPOOFED-BODY-REASON'), false, 'req.body.message must NEVER enter refund description');
            assert.ok(savedRefundDescription.includes('UPSTREAM-VERIFIED-REASON'), 'Refund description should come from verified upstream status response');
        } finally {
            axios.get = origAxiosGet;
            pool.connect.mock.restore();
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('cross-check /v1/status vs DB: SKU atau trx_id tidak cocok -> log warning (invoice + reason saja) & status tidak berubah', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-xcheck-secret';

        let statusMutated = false;
        let currentScenario = 'SKU_MISMATCH';
        const warnLogs = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));

        axios.get = async (url) => {
            if (currentScenario === 'SKU_MISMATCH') {
                return { data: { status: true, data: { trx_id: 'SEC1-XC-1', status: 'SUCCESS', product_code: 'SKU-WRONG', sn: 'SN1' } } };
            }
            if (currentScenario === 'TRX_MISMATCH') {
                return { data: { status: true, data: { trx_id: 'TRX-OTHER', status: 'SUCCESS', product_code: 'SKU-REAL', sn: 'SN3' } } };
            }
            // products.price saat ini (mis. berubah ke 9000 sementara tx.price 12000 atau Foxy 15000) tidak boleh memblokir selama kolom modal transaksi belum ada
            return { data: { status: true, data: { trx_id: 'SEC1-XC-4', status: 'SUCCESS', product_code: 'SKU-REAL', product_price: 15000, sn: 'SN4' } } };
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                const trxId = params && params[0];
                return { rows: [{ id: 9300, status: 'Pending', price: 12000, product_id: 5, provider_trx_id: trxId, provider_sku: 'SKU-REAL' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    const trxId = params && params[0];
                    return { rows: [{ id: 9300, invoice_id: `INV-${trxId}`, user_id: 12, product_id: 5, status: 'Pending', price: 12000, provider_trx_id: trxId }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM products WHERE id')) {
                    return { rows: [{ provider_sku: 'SKU-REAL' }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE transactions')) {
                    statusMutated = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            currentScenario = 'SKU_MISMATCH';
            const r1 = await fetch(`${secCallbackUrl}?token=sec1-xcheck-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-XC-1', status: 'SUCCESS', sn: 'BODY-SENSITIVE-SN-1', message: 'BODY-SENSITIVE-MSG-1' })
            });
            assert.strictEqual(r1.status, 200);
            assert.deepStrictEqual(await r1.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusMutated, false, 'SKU mismatch must NOT change transaction status');

            currentScenario = 'TRX_MISMATCH';
            const r3 = await fetch(`${secCallbackUrl}?token=sec1-xcheck-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-XC-3', status: 'SUCCESS', sn: 'BODY-SENSITIVE-SN-3', message: 'BODY-SENSITIVE-MSG-3' })
            });
            assert.strictEqual(r3.status, 200);
            assert.deepStrictEqual(await r3.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusMutated, false, 'trx_id mismatch must NOT change transaction status');

            const combinedWarns = warnLogs.join('\n');
            assert.ok(combinedWarns.includes('INV-SEC1-XC-1') && combinedWarns.includes('SKU mismatch'), 'SKU mismatch warning must include invoice and reason');
            assert.ok(combinedWarns.includes('INV-SEC1-XC-3') && combinedWarns.includes('trx_id mismatch'), 'trx_id mismatch warning must include invoice and reason');
            assert.strictEqual(combinedWarns.includes('sec1-xcheck-secret'), false, 'Mismatch warning must NOT leak callback token');
            assert.strictEqual(combinedWarns.includes('BODY-SENSITIVE'), false, 'Mismatch warning must NOT include req.body contents');

            currentScenario = 'VALID_NOT_BLOCKED_BY_LIVE_PRODUCT_PRICE';
            const r4 = await fetch(`${secCallbackUrl}?token=sec1-xcheck-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-XC-4', status: 'SUCCESS', sn: 'SN4', message: 'Transaksi sukses' })
            });
            assert.strictEqual(r4.status, 200);
            assert.deepStrictEqual(await r4.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(statusMutated, true, 'Matching trx_id & SKU must commit Success without comparing against live products.price');
        } finally {
            console.warn = origWarn;
            axios.get = origAxiosGet;
            pool.connect.mock.restore();
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('respons /v1/status tanpa SKU dan nominal tetap diproses normal', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-minimal-secret';

        let updatedToSuccess = false;
        let savedSn = null;

        axios.get = async () => ({
            // Hanya memuat trx_id, status, sn (tanpa product_code/sku dan tanpa price/amount)
            data: { status: true, data: { trx_id: 'SEC1-MINIMAL-1', status: 'SUCCESS', sn: 'SN-MINIMAL-OK' } }
        });

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9350, status: 'Pending', price: 15000, product_id: 7, provider_trx_id: 'SEC1-MINIMAL-1', provider_sku: 'SKU-DB-7' }] };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('SELECT * FROM transactions WHERE provider_trx_id')) {
                    return { rows: [{ id: 9350, invoice_id: 'INV-MINIMAL-1', user_id: 21, product_id: 7, status: 'Pending', price: 15000, provider_trx_id: 'SEC1-MINIMAL-1' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM products WHERE id')) {
                    return { rows: [{ provider_sku: 'SKU-DB-7' }] };
                }
                if (typeof sql === 'string' && sql.includes("SET status = 'Success', provider_sn")) {
                    updatedToSuccess = true;
                    savedSn = params && params[0];
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const res = await fetch(`${secCallbackUrl}?token=sec1-minimal-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-MINIMAL-1', status: 'SUCCESS', sn: 'SN-MINIMAL-OK', message: 'Transaksi sukses' })
            });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(await res.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(updatedToSuccess, true, 'Status response without SKU or nominal must be processed normally');
            assert.strictEqual(savedSn, 'SN-MINIMAL-OK');
        } finally {
            axios.get = origAxiosGet;
            pool.connect.mock.restore();
            pool.query.mock.restore();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });

    test('transaksi sudah final atau tidak ditemukan -> Foxy tidak dipanggil, serta cooldown 5 detik pakai injectable clock', async () => {
        process.env.FOXY_CALLBACK_SECRET = 'sec1-limit-secret';
        if (typeof clearCallbackCooldownCache === 'function') clearCallbackCooldownCache();

        let foxyCalls = 0;
        let currentDbStatus = 'Success';
        let fakeNow = 1_700_000_000_000;
        mock.method(callbackClock, 'now', () => fakeNow);

        axios.get = async () => {
            foxyCalls += 1;
            return { data: { status: true, data: { status: 'PENDING' } } };
        };

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                const trxId = params && params[0];
                if (trxId === 'SEC1-UNKNOWN') return { rows: [] };
                return { rows: [{ id: 9400, status: currentDbStatus, price: 10000, product_id: 1, provider_trx_id: trxId }] };
            }
            return { rows: [] };
        });

        try {
            // 1. Transaksi sudah final ('Success') -> Foxy tidak boleh dipanggil
            currentDbStatus = 'Success';
            const resFinal = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-FINAL-1', status: 'SUCCESS', sn: 'SN-FIN-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resFinal.status, 200);
            assert.deepStrictEqual(await resFinal.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(foxyCalls, 0, 'Final transaction must not trigger Foxy /v1/status call');

            // 2. Transaksi tidak ada -> tetap 200 tanpa bocor eksistensi, Foxy 0 panggilan
            const resUnknown = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-UNKNOWN', status: 'SUCCESS', sn: 'SN-UNK-1', message: 'Transaksi sukses' })
            });
            assert.strictEqual(resUnknown.status, 200);
            assert.deepStrictEqual(await resUnknown.json(), { message: 'Callback berhasil diproses.' });
            assert.strictEqual(foxyCalls, 0, 'Unknown transaction must not call Foxy');

            // 3. Cooldown 5 detik: dua callback beruntun pada Pending trx_id yang sama -> hanya 1x panggilan Foxy, lalu lolos lagi setelah > 5000ms
            currentDbStatus = 'Pending';
            const resCool1 = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-COOLDOWN-1', status: 'PENDING', message: 'Sedang diproses' })
            });
            fakeNow += 2000;
            const resCool2 = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-COOLDOWN-1', status: 'PENDING', message: 'Sedang diproses' })
            });
            assert.strictEqual(resCool1.status, 200);
            assert.strictEqual(resCool2.status, 200);
            assert.strictEqual(foxyCalls, 1, 'Repeated callback within 5s cooldown must only call Foxy once');

            fakeNow += 3001; // Total elapsed: 5001ms (> 5000ms cooldown)
            const resCool3 = await fetch(`${secCallbackUrl}?token=sec1-limit-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'SEC1-COOLDOWN-1', status: 'PENDING', message: 'Sedang diproses' })
            });
            assert.strictEqual(resCool3.status, 200);
            assert.strictEqual(foxyCalls, 2, 'Callback after cooldown window expires should call Foxy again');
        } finally {
            axios.get = origAxiosGet;
            pool.query.mock.restore();
            callbackClock.now.mock.restore();
            if (typeof clearCallbackCooldownCache === 'function') clearCallbackCooldownCache();
            process.env.FOXY_CALLBACK_SECRET = '';
        }
    });
});
