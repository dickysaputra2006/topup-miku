const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { pool, axios, cronUtils, cronPool, createServerHarness } = require('../helpers/appFactory');

describe('Phase 13: SEC-004, SEC-007 & SEC-008: H2H Security Hardening', () => {
    const harness = createServerHarness({ withAxios: true, withCronPool: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('SEC-007 (1): tolak webhook SSRF (127.0.0.1, 169.254.169.254, 100.64.x.x, 0.0.0.0, ::ffff:127.0.0.1, DNS private) & PUT /h2h/profile/callback', async () => {
        const { sendH2HWebhook, validateWebhookUrl } = require('../../utils/webhookClient');
        const apiKey = '4'.repeat(64);
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        let dbUpdatedCallback = false;

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                return { rows: [{ id: 9004, whitelisted_ips: [], api_key: null, api_key_hash: keyHash }] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return { rows: [{ id: 9004, username: 'ssrf_tester', balance: 10000, role_id: 2, role_name: 'PARTNER', api_key: null, api_key_hash: keyHash, whitelisted_ips: [] }] };
            }
            if (sql.includes('SET h2h_callback_url')) {
                dbUpdatedCallback = true;
            }
            return { rows: [] };
        });

        let outboundCalls = 0;
        axios.post = async () => {
            outboundCalls += 1;
            return { status: 200, data: 'ok' };
        };

        try {
            const badLiteralUrls = [
                'https://127.0.0.1/cb',
                'https://169.254.169.254/latest/meta-data/',
                'https://100.64.5.10/cb',
                'https://0.0.0.0/cb',
                'https://[::ffff:127.0.0.1]/cb',
                'https://[::ffff:169.254.169.254]/cb',
                'https://[::1]/cb',
                'https://[fe80::1]/cb',
                'https://[fd00::1]/cb',
                'http://93.184.216.34/cb'
            ];

            for (const badUrl of badLiteralUrls) {
                await assert.rejects(
                    () => sendH2HWebhook({ url: badUrl, payload: { invoice_id: 'T1' }, secret: 'sec' }),
                    { message: /tidak diizinkan|tidak valid|HTTPS/i },
                    `sendH2HWebhook must reject SSRF URL: ${badUrl}`
                );

                const resPut = await fetch(`${baseUrl}/h2h/profile/callback`, {
                    method: 'PUT',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_url: badUrl })
                });
                assert.strictEqual(resPut.status, 400, `PUT /h2h/profile/callback must reject SSRF URL: ${badUrl}`);
            }

            // Domain resolving via DNS to private IP (single A or mixed public+private A/AAAA) MUST be rejected
            await assert.rejects(
                () => validateWebhookUrl('https://private-dns.reseller.example/cb', {
                    dnsLookup: async () => [{ address: '10.0.0.8', family: 4 }]
                }),
                { message: /tidak diizinkan/i },
                'Domain resolving to RFC1918 IP must be rejected'
            );
            await assert.rejects(
                () => validateWebhookUrl('https://mixed-dns.reseller.example/cb', {
                    dnsLookup: async () => [
                        { address: '93.184.216.34', family: 4 },
                        { address: '169.254.169.254', family: 4 }
                    ]
                }),
                { message: /tidak diizinkan/i },
                'Domain resolving with any private/link-local record must be rejected'
            );
            await assert.rejects(
                () => validateWebhookUrl('https://cgnat-dns.reseller.example/cb', {
                    dnsLookup: async () => [{ address: '100.127.255.250', family: 4 }]
                }),
                { message: /tidak diizinkan/i },
                'Domain resolving to CGNAT 100.64.0.0/10 must be rejected'
            );

            // PUT /h2h/profile/callback must also run DNS resolution and reject domains resolving to private IPs
            const { webhookDns } = require('../../utils/webhookClient');
            mock.method(webhookDns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
            try {
                const resPutDnsPrivate = await fetch(`${baseUrl}/h2h/profile/callback`, {
                    method: 'PUT',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_url: 'https://ssrf-rebind.reseller.example/cb' })
                });
                assert.strictEqual(resPutDnsPrivate.status, 400, 'PUT /h2h/profile/callback must reject domain resolving to loopback/private IP');
            } finally {
                if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            }

            assert.strictEqual(dbUpdatedCallback, false, 'None of the bad URLs should be saved to DB');
            assert.strictEqual(outboundCalls, 0, 'SSRF checks must reject before calling axios.post');
        } finally {
            axios.post = origAxiosPost;
            pool.query.mock.restore();
        }
    });

    test('SEC-007 (2): redirect (302) tidak diikuti, DNS pinning mengikat IP, X-Signature & X-Timestamp valid di Foxy callback & cron', async () => {
        const { webhookDns, buildSignedWebhookHeaders } = require('../../utils/webhookClient');
        const webhookSecret = 'whsec_test_' + 'a'.repeat(48);

        // 1. Real HTTP redirect test proving maxRedirects: 0 blocks 302 redirect target
        let targetHitCount = 0;
        const targetServer = http.createServer((req, res) => {
            targetHitCount += 1;
            res.writeHead(200);
            res.end('ok');
        });
        await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
        const targetPort = targetServer.address().port;

        const redirectServer = http.createServer((req, res) => {
            res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/internal` });
            res.end();
        });
        await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
        const redirectPort = redirectServer.address().port;

        const { buildAxiosWebhookConfig } = require('../../utils/webhookClient');
        try {
            const payload = { invoice_id: 'TRX-REDIR-1', status: 'Success' };
            const rawBody = JSON.stringify(payload);
            const signedHeaders = buildSignedWebhookHeaders(rawBody, webhookSecret, 1700000123);
            const axiosConfig = buildAxiosWebhookConfig({ headers: signedHeaders });
            assert.strictEqual(axiosConfig.maxRedirects, 0, 'Webhook config must force maxRedirects: 0');

            await assert.rejects(
                () => axios.post(`http://127.0.0.1:${redirectPort}/hook`, rawBody, axiosConfig),
                /status code 302|maxRedirects|redirect/i,
                '302 redirect must cause axios.post rejection and never follow Location'
            );
            assert.strictEqual(targetHitCount, 0, 'Redirect target MUST receive zero requests');

            // 2. End-to-end callback (server.js) + cron (cronUtils.js) webhook dispatch
            process.env.FOXY_CALLBACK_SECRET = 'sec7-foxy-secret';
            let dnsReturnedIp = '93.184.216.34';
            mock.method(webhookDns, 'lookup', async () => [{ address: dnsReturnedIp, family: 4 }]);

            const capturedWebhooks = [];
            axios.get = async (url) => {
                if (url.includes('/v1/status')) {
                    return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-SEC7-OK' } } };
                }
                return { data: { data: [] } };
            };
            axios.post = async (url, rawData, config) => {
                capturedWebhooks.push({ url, rawData, config });
                // Simulate DNS rebinding AFTER resolution to verify pinned agent lookup STILL returns initial validated IP!
                dnsReturnedIp = '127.0.0.1';
                const pinnedIps = await new Promise((resolve, reject) => {
                    config.httpsAgent.options.lookup('webhook.reseller.example', { all: true }, (err, res) => (err ? reject(err) : resolve(res)));
                });
                assert.deepStrictEqual(pinnedIps, [{ address: '93.184.216.34', family: 4 }], 'Agent lookup must pin initial validated IP');
                dnsReturnedIp = '93.184.216.34';
                return { status: 200, data: 'ok' };
            };

            mock.method(pool, 'query', async (sql) => {
                if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                    return { rows: [{ id: 9501, status: 'Pending', price: 15000, product_id: 1, provider_trx_id: 'TRX-SEC7-CB', cost_price: 12000 }] };
                }
                if (typeof sql === 'string' && sql.includes('h2h_webhook_secret')) {
                    return {
                        rows: [{
                            h2h_callback_url: 'https://webhook.reseller.example/h2h',
                            h2h_webhook_secret: webhookSecret,
                            product_name: 'Diamond SEC7'
                        }]
                    };
                }
                return { rows: [] };
            });

            mock.method(pool, 'connect', async () => ({
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                    if (typeof sql === 'string' && sql.includes('FOR UPDATE') && sql.includes('transactions')) {
                        return { rows: [{ id: 9501, invoice_id: 'INV-SEC7-CB', user_id: 9010, product_id: 1, price: 15000, status: 'Pending', provider_trx_id: 'TRX-SEC7-CB', flash_sale_id: null, flash_sale_restored: false }] };
                    }
                    return { rows: [] };
                },
                release: () => {}
            }));

            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec7-foxy-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-SEC7-CB', status: 'SUCCESS', sn: 'SN-SEC7-OK' })
            });
            assert.strictEqual(cbRes.status, 200);
            // Allow background webhook promise microtasks to flush
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            // Now also test cronUtils.checkPendingTransactions() outbound webhook
            mock.method(cronPool, 'query', async (sql) => {
                if (typeof sql === 'string' && sql.includes('FROM transactions t')) {
                    return {
                        rows: [{
                            id: 9502,
                            invoice_id: 'INV-SEC7-CRON',
                            user_id: 9011,
                            price: 20000,
                            provider_trx_id: 'TRX-SEC7-CRON',
                            check_attempts: 0,
                            flash_sale_id: null,
                            flash_sale_restored: false,
                            product_name: 'Diamond Cron SEC7',
                            h2h_callback_url: 'https://webhook.reseller.example/cron-h2h',
                            h2h_webhook_secret: webhookSecret
                        }]
                    };
                }
                return { rows: [] };
            });
            mock.method(cronPool, 'connect', async () => ({
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                    if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                        return { rows: [{ id: 9502, invoice_id: 'INV-SEC7-CRON', user_id: 9011, price: 20000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                    }
                    return { rows: [] };
                },
                release: () => {}
            }));

            await cronUtils.checkPendingTransactions();
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            assert.strictEqual(capturedWebhooks.length, 2, 'Both callback and cron must dispatch signed SSRF-safe H2H webhooks');
            for (const wh of capturedWebhooks) {
                assert.strictEqual(typeof wh.rawData, 'string', 'Signed webhook must send deterministic JSON string body');
                assert.strictEqual(wh.config.maxRedirects, 0);
                assert.ok(wh.config.timeout > 0 && wh.config.timeout <= 5000, 'Strict webhook timeout must be <= 5000ms');
                assert.ok(wh.config.maxContentLength > 0 && wh.config.maxBodyLength > 0, 'Response and body limits must be configured');
                const ts = wh.config.headers['X-Timestamp'];
                assert.ok(/^\d+$/.test(ts), 'X-Timestamp must be Unix epoch string');
                const expectedSig = crypto
                    .createHmac('sha256', webhookSecret)
                    .update(`${ts}.${wh.rawData}`)
                    .digest('hex');
                assert.strictEqual(
                    wh.config.headers['X-Signature'],
                    expectedSig,
                    'X-Signature must equal HMAC-SHA256 of `${X-Timestamp}.${rawBody}`'
                );
            }
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect.mock) cronPool.connect.mock.restore();
            await new Promise(resolve => redirectServer.close(resolve));
            await new Promise(resolve => targetServer.close(resolve));
        }
    });

    test('SEC-007 (3): reseller lama tanpa h2h_webhook_secret dibuatkan secret secara lazy agar X-Signature selalu ada', async () => {
        const { webhookDns } = require('../../utils/webhookClient');
        const legacyKey = 'f'.repeat(48);
        const userState = {
            id: 9020,
            username: 'legacy_no_whsec',
            balance: 100000,
            role_id: 2,
            role_name: 'PARTNER',
            api_key: legacyKey,
            api_key_hash: null,
            api_key_prefix: null,
            h2h_callback_url: 'https://legacy-hook.reseller.example/cb',
            h2h_webhook_secret: null,
            whitelisted_ips: []
        };

        // 1. Lazy migration API key juga men-seed h2h_webhook_secret bila masih NULL
        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return params[0] === userState.api_key ? { rows: [{ ...userState }] } : { rows: [] };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET api_key_hash') && sql.includes('h2h_webhook_secret')) {
                userState.api_key_hash = params[0];
                userState.api_key_prefix = params[1];
                userState.api_key = null;
                if (!userState.h2h_webhook_secret && params[3]) userState.h2h_webhook_secret = params[3];
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            return { rows: [] };
        });

        try {
            const profRes = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': legacyKey }
            });
            assert.strictEqual(profRes.status, 200);
            assert.match(userState.h2h_webhook_secret || '', /^[a-f0-9]{64}$/, 'Lazy key migration must also provision h2h_webhook_secret when NULL');
        } finally {
            pool.query.mock.restore();
        }

        // 2. Jika user tetap tanpa h2h_webhook_secret saat webhook dikirim (callback & cron), secret dibuat lazily sebelum mengirim
        const sentWebhooks = [];
        let cbLazySecret = null;
        let cronLazySecret = null;
        process.env.FOXY_CALLBACK_SECRET = 'sec7-lazy-cb-secret';
        mock.method(webhookDns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);

        axios.get = async (url) => {
            if (url.includes('/v1/status')) {
                return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-LAZY-WHSEC' } } };
            }
            return { data: { data: [] } };
        };
        axios.post = async (url, rawData, config) => {
            sentWebhooks.push({ url, rawData, config });
            return { status: 200, data: 'ok' };
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9601, status: 'Pending', price: 15000, product_id: 1, provider_trx_id: 'TRX-LAZY-CB', cost_price: 12000 }] };
            }
            if (sql.includes('u.h2h_webhook_secret')) {
                return { rows: [{ h2h_callback_url: 'https://legacy-cb.reseller.example/cb', h2h_webhook_secret: null, product_name: 'MLBB 50' }] };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET h2h_webhook_secret = COALESCE')) {
                cbLazySecret = params[0];
                return { rows: [{ h2h_webhook_secret: cbLazySecret }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 9601, invoice_id: 'INV-LAZY-CB', user_id: 9021, product_id: 1, price: 15000, status: 'Pending', provider_trx_id: 'TRX-LAZY-CB', flash_sale_id: null, flash_sale_restored: false }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        mock.method(cronPool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return {
                    rows: [{
                        id: 9602,
                        invoice_id: 'INV-LAZY-CRON',
                        user_id: 9022,
                        price: 18000,
                        provider_trx_id: 'TRX-LAZY-CRON',
                        check_attempts: 0,
                        flash_sale_id: null,
                        flash_sale_restored: false,
                        product_name: 'MLBB 86',
                        h2h_callback_url: 'https://legacy-cron.reseller.example/cb',
                        h2h_webhook_secret: ''
                    }]
                };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET h2h_webhook_secret = COALESCE')) {
                cronLazySecret = params[0];
                return { rows: [{ h2h_webhook_secret: cronLazySecret }] };
            }
            return { rows: [] };
        });
        mock.method(cronPool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 9602, invoice_id: 'INV-LAZY-CRON', user_id: 9022, price: 18000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec7-lazy-cb-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-LAZY-CB', status: 'SUCCESS', sn: 'SN-LAZY-WHSEC' })
            });
            assert.strictEqual(cbRes.status, 200);
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            await cronUtils.checkPendingTransactions();

            assert.strictEqual(sentWebhooks.length, 2);
            assert.match(cbLazySecret || '', /^[a-f0-9]{64}$/, 'Callback path must lazily generate h2h_webhook_secret');
            assert.match(cronLazySecret || '', /^[a-f0-9]{64}$/, 'Cron path must lazily generate h2h_webhook_secret');

            const secrets = [cbLazySecret, cronLazySecret];
            sentWebhooks.forEach((wh, idx) => {
                const ts = wh.config.headers['X-Timestamp'];
                const sig = wh.config.headers['X-Signature'];
                assert.ok(/^\d+$/.test(ts), 'X-Timestamp must exist');
                assert.ok(sig && sig.length === 64, 'X-Signature must ALWAYS be sent for legacy resellers');
                const expected = crypto.createHmac('sha256', secrets[idx]).update(`${ts}.${wh.rawData}`).digest('hex');
                assert.strictEqual(sig, expected);
            });
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect.mock) cronPool.connect.mock.restore();
        }
    });

    test('SEC-007 (4): webhook invalid (http:// / URL berkredensial) atau gagal kirim mencatat warning aman dan tidak menghentikan callback/cron', async () => {
        const { webhookDns } = require('../../utils/webhookClient');
        process.env.FOXY_CALLBACK_SECRET = 'sec7-warn-secret';

        const warnings = [];
        mock.method(console, 'warn', (...args) => {
            warnings.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        });

        let cbStatusUpdatedToSuccess = false;
        let cronFirstUpdatedToSuccess = false;
        let cronSecondProcessed = false;
        const secretValue = 'super_secret_hmac_key_never_log_12345';

        mock.method(webhookDns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
        axios.get = async (url) => {
            if (url.includes('/v1/status')) {
                return { data: { status: true, data: { status: 'SUCCESS', sn: 'SN-RESILIENT' } } };
            }
            return { data: { data: [] } };
        };
        axios.post = async () => {
            const err = new Error('Request failed with status code 502 (https://user:topsecret@hook.reseller.example/cb?token=leak123)');
            err.response = { status: 502, statusText: 'Bad Gateway', config: { method: 'post', url: 'https://user:topsecret@hook.reseller.example/cb?token=leak123' } };
            throw err;
        };

        // 1. Callback Foxy dengan URL http:// lama -> harus tetap 200 & status Success, log warning aman
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return { rows: [{ id: 9701, status: 'Pending', price: 10000, product_id: 1, provider_trx_id: 'TRX-BADURL-CB', cost_price: 8000 }] };
            }
            if (sql.includes('h2h_webhook_secret')) {
                return { rows: [{ h2h_callback_url: 'http://legacy-insecure.reseller.example/cb?token=shouldnotleak', h2h_webhook_secret: secretValue, product_name: 'ML 10' }] };
            }
            return { rows: [] };
        });
        mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    return { rows: [{ id: 9701, invoice_id: 'INV-BADURL-CB', user_id: 9030, product_id: 1, price: 10000, status: 'Pending', provider_trx_id: 'TRX-BADURL-CB', flash_sale_id: null, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Success'")) {
                    cbStatusUpdatedToSuccess = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        // 2. Cron batch dengan 2 transaksi: tx1 gagal validasi URL berkredensial, tx2 gagal HTTP 502; status KEDUANYA tetap Success
        mock.method(cronPool, 'query', async (sql) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM transactions t')) {
                return {
                    rows: [
                        {
                            id: 9702,
                            invoice_id: 'INV-CREDURL-CRON',
                            user_id: 9031,
                            price: 12000,
                            provider_trx_id: 'TRX-CREDURL-1',
                            check_attempts: 0,
                            flash_sale_id: null,
                            flash_sale_restored: false,
                            product_name: 'ML 12',
                            h2h_callback_url: 'https://adminuser:superpass99@bad.reseller.example/cb?token=urltok99',
                            h2h_webhook_secret: secretValue
                        },
                        {
                            id: 9703,
                            invoice_id: 'INV-HTTP502-CRON',
                            user_id: 9032,
                            price: 14000,
                            provider_trx_id: 'TRX-HTTP502-2',
                            check_attempts: 0,
                            flash_sale_id: null,
                            flash_sale_restored: false,
                            product_name: 'ML 14',
                            h2h_callback_url: 'https://hook.reseller.example/cb?token=leak123',
                            h2h_webhook_secret: secretValue
                        }
                    ]
                };
            }
            return { rows: [] };
        });
        mock.method(cronPool, 'connect', async () => ({
            query: async (sql, params = []) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FOR UPDATE')) {
                    if (params[0] === 9702) {
                        return { rows: [{ id: 9702, invoice_id: 'INV-CREDURL-CRON', user_id: 9031, price: 12000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                    }
                    return { rows: [{ id: 9703, invoice_id: 'INV-HTTP502-CRON', user_id: 9032, price: 14000, status: 'Pending', flash_sale_id: null, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE transactions SET status = $1') && params[0] === 'Success') {
                    if (params[2] === 9702) cronFirstUpdatedToSuccess = true;
                    if (params[2] === 9703) cronSecondProcessed = true;
                }
                return { rows: [] };
            },
            release: () => {}
        }));

        try {
            const cbRes = await fetch(`${baseUrl}/api/foxy/callback?token=sec7-warn-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trx_id: 'TRX-BADURL-CB', status: 'SUCCESS', sn: 'SN-RESILIENT' })
            });
            assert.strictEqual(cbRes.status, 200, 'Rejected webhook URL must NOT fail Foxy callback response');
            assert.strictEqual(cbStatusUpdatedToSuccess, true, 'Callback transaction status must still commit Success');
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 20));

            await cronUtils.checkPendingTransactions();
            assert.strictEqual(cronFirstUpdatedToSuccess, true, 'First cron tx must commit Success even if webhook URL is invalid');
            assert.strictEqual(cronSecondProcessed, true, 'Cron loop must continue processing subsequent transactions cleanly');

            const combinedWarnings = warnings.join('\n');
            assert.ok(combinedWarnings.includes('INV-BADURL-CB'), 'Warning log must include invoice ID for callback http:// rejection');
            assert.ok(combinedWarnings.includes('INV-CREDURL-CRON'), 'Warning log must include invoice ID for credential URL rejection');
            assert.ok(combinedWarnings.includes('INV-HTTP502-CRON'), 'Warning log must include invoice ID for failed webhook delivery');
            assert.ok(!combinedWarnings.includes(secretValue), 'Warning log must NEVER leak webhook secret');
            assert.ok(!combinedWarnings.includes('superpass99'), 'Warning log must NEVER leak URL password credentials');
            assert.ok(!combinedWarnings.includes('topsecret'), 'Warning log must NEVER leak Axios URL password credentials');
            assert.ok(!combinedWarnings.includes('urltok99'), 'Warning log must NEVER leak URL query token');
            assert.ok(!combinedWarnings.includes('leak123'), 'Warning log must NEVER leak URL query token in error');
            assert.ok(!combinedWarnings.includes('shouldnotleak'), 'Warning log must NEVER leak URL query string');
        } finally {
            process.env.FOXY_CALLBACK_SECRET = '';
            console.warn.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
            if (webhookDns.lookup && webhookDns.lookup.mock) webhookDns.lookup.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (cronPool.query.mock) cronPool.query.mock.restore();
            if (cronPool.connect.mock) cronPool.connect.mock.restore();
        }
    });
});
