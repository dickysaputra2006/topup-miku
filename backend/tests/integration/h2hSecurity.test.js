const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { pool, axios, cronUtils, cronPool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 13: SEC-004, SEC-007 & SEC-008: H2H Security Hardening', () => {
    const harness = createServerHarness({ withAxios: true, withCronPool: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id = 9001, role = 'PARTNER') {
        return fixtures.makeUserToken(id, role, `reseller${id}`);
    }

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('SEC-004 (1): generate-apikey simpan SHA-256 hash & prefix saja, GET /api/user/apikey tidak return key utuh, regenerate & revoke bekerja', async () => {
        const token = makeUserToken(9001);
        const state = {
            id: 9001,
            api_key: null,
            api_key_hash: null,
            api_key_prefix: null,
            h2h_webhook_secret: null
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('UPDATE users') && sql.includes('api_key_hash') && !sql.includes('api_key_hash = NULL')) {
                assert.ok(sql.includes('api_key = NULL'), 'Generate/Regenerate must explicitly clear plaintext api_key to NULL');
                state.api_key = null;
                state.api_key_hash = params[0];
                state.api_key_prefix = params[1];
                if (!state.h2h_webhook_secret && params[2]) state.h2h_webhook_secret = params[2];
                return { rows: [{ api_key_prefix: state.api_key_prefix, webhook_secret_created: Boolean(params[2]) }] };
            }
            if (sql.includes('UPDATE users') && sql.includes('api_key_hash = NULL')) {
                state.api_key = null;
                state.api_key_hash = null;
                state.api_key_prefix = null;
                return { rows: [] };
            }
            if (sql.includes('FROM users') && sql.includes('api_key_prefix')) {
                return { rows: [{ api_key_prefix: state.api_key_prefix, api_key_hash: state.api_key_hash, api_key: state.api_key }] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                if (state.api_key_hash && params[1] === state.api_key_hash) {
                    return { rows: [{ id: 9001, username: 'reseller9001', balance: 25000, role_id: 2, role_name: 'PARTNER', api_key: state.api_key, api_key_hash: state.api_key_hash, api_key_prefix: state.api_key_prefix, whitelisted_ips: [] }] };
                }
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: [] }] };
            }
            if (sql.includes('SELECT h2h_webhook_secret FROM users')) {
                return { rows: [{ h2h_webhook_secret: state.h2h_webhook_secret }] };
            }
            if (sql.includes('UPDATE users SET h2h_webhook_secret')) {
                state.h2h_webhook_secret = params[0];
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            const genRes = await fetch(`${baseUrl}/api/user/generate-apikey`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(genRes.status, 200);
            const genBody = await genRes.json();
            assert.match(genBody.apiKey, /^[a-f0-9]{64}$/, 'New API key must be 32 random bytes (64 hex chars)');
            assert.strictEqual(genBody.prefix, genBody.apiKey.slice(0, 8));
            assert.strictEqual(state.api_key, null, 'Plaintext api_key must NOT be stored');
            assert.strictEqual(
                state.api_key_hash,
                crypto.createHash('sha256').update(genBody.apiKey).digest('hex'),
                'Stored api_key_hash must be SHA-256 of generated key'
            );

            // GET /api/user/apikey must NEVER return full key again
            const getRes = await fetch(`${baseUrl}/api/user/apikey`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(getRes.status, 200);
            const getRaw = await getRes.text();
            const getBody = JSON.parse(getRaw);
            assert.strictEqual(getBody.apiKey, undefined, 'GET /api/user/apikey must not return full apiKey');
            assert.ok(!getRaw.includes(genBody.apiKey), 'Full API key must not appear in GET response');
            assert.strictEqual(getBody.hasApiKey, true);
            assert.strictEqual(getBody.status, 'active');
            assert.strictEqual(getBody.prefix, genBody.apiKey.slice(0, 8));

            // Regenerate gives a new 64-hex key and invalidates previous key
            const regenRes = await fetch(`${baseUrl}/api/user/apikey/regenerate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(regenRes.status, 200);
            const regenBody = await regenRes.json();
            assert.match(regenBody.apiKey, /^[a-f0-9]{64}$/);
            assert.notStrictEqual(regenBody.apiKey, genBody.apiKey);

            // Revoke clears key hash + prefix and blocks subsequent H2H usage
            const revRes = await fetch(`${baseUrl}/api/user/apikey`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(revRes.status, 200);
            const revBody = await revRes.json();
            assert.strictEqual(revBody.hasApiKey, false);
            assert.strictEqual(revBody.status, 'inactive');

            const getAfterRevoke = await fetch(`${baseUrl}/api/user/apikey`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const afterBody = await getAfterRevoke.json();
            assert.strictEqual(afterBody.hasApiKey, false);
            assert.strictEqual(afterBody.prefix, null);

            const h2hRevokedRes = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': regenBody.apiKey }
            });
            assert.strictEqual(h2hRevokedRes.status, 403, 'Revoked API key must be rejected');

            // Webhook secret status never returns full secret; rotate returns new secret once
            const getWhRes = await fetch(`${baseUrl}/api/user/webhook-secret`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(getWhRes.status, 200);
            const getWhBody = await getWhRes.json();
            assert.strictEqual(getWhBody.webhookSecret, undefined, 'GET /api/user/webhook-secret must not return full secret');
            assert.strictEqual(getWhBody.hasWebhookSecret, true);

            const rotWhRes = await fetch(`${baseUrl}/api/user/webhook-secret/rotate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            assert.strictEqual(rotWhRes.status, 200);
            const rotWhBody = await rotWhRes.json();
            assert.match(rotWhBody.webhookSecret, /^[a-f0-9]{64}$/);
            assert.strictEqual(rotWhBody.webhookSecret, state.h2h_webhook_secret);
        } finally {
            pool.query.mock.restore();
        }
    });

    test('SEC-004 (2): legacy 48-hex API key tetap lolos dan lazy-migrate ke SHA-256 hash dengan api_key jadi NULL', async () => {
        const legacyKey = 'c'.repeat(48);
        const expectedHash = crypto.createHash('sha256').update(legacyKey).digest('hex');
        const userRow = {
            id: 9002,
            username: 'legacy_reseller',
            balance: 75000,
            role_id: 2,
            role_name: 'PARTNER',
            api_key: legacyKey,
            api_key_hash: null,
            api_key_prefix: null,
            h2h_callback_url: null,
            whitelisted_ips: []
        };
        let lazyMigratedCount = 0;

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                const matchPlain = userRow.api_key !== null && params[0] === userRow.api_key;
                const matchHash = userRow.api_key_hash !== null && params[1] === userRow.api_key_hash;
                return (matchPlain || matchHash) ? { rows: [{ ...userRow }] } : { rows: [] };
            }
            if (sql.includes('UPDATE users') && sql.includes('SET api_key_hash') && sql.includes('api_key = NULL')) {
                lazyMigratedCount += 1;
                userRow.api_key_hash = params[0];
                userRow.api_key_prefix = params[1];
                userRow.api_key = null;
                return { rows: [] };
            }
            if (sql.includes('whitelisted_ips')) {
                return { rows: [{ whitelisted_ips: userRow.whitelisted_ips }] };
            }
            return { rows: [] };
        });

        try {
            // Request 1: legacy plaintext key succeeds AND triggers lazy migration
            const res1 = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': legacyKey }
            });
            assert.strictEqual(res1.status, 200, 'Legacy 48-char key must still authenticate');
            assert.strictEqual(lazyMigratedCount, 1, 'First valid request must lazy-migrate legacy key');
            assert.strictEqual(userRow.api_key, null, 'Plaintext api_key must be cleared to NULL after lazy migration');
            assert.strictEqual(userRow.api_key_hash, expectedHash);
            assert.strictEqual(userRow.api_key_prefix, legacyKey.slice(0, 8));

            // Request 2: SAME legacy key still succeeds purely via api_key_hash without re-migrating
            const res2 = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': legacyKey }
            });
            assert.strictEqual(res2.status, 200, 'Legacy key must continue working via hash after plaintext is NULL');
            assert.strictEqual(lazyMigratedCount, 1, 'Lazy migration should only run once');

            // Request 3: wrong key rejected
            const resBad = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': 'd'.repeat(48) }
            });
            assert.strictEqual(resBad.status, 403);
        } finally {
            pool.query.mock.restore();
        }
    });

    test('SEC-008 (1): protectH2HIp dukung CIDR IPv4/IPv6 & ::ffff:x.x.x.x, lindungi /h2h/profile & /h2h/profile/callback, blok loopback di production', async () => {
        const apiKey = 'e'.repeat(64);
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const origNodeEnv = process.env.NODE_ENV;
        const userRow = {
            id: 9003,
            username: 'cidr_reseller',
            balance: 50000,
            role_id: 2,
            role_name: 'PARTNER',
            api_key: null,
            api_key_hash: keyHash,
            api_key_prefix: apiKey.slice(0, 8),
            h2h_callback_url: null,
            whitelisted_ips: ['203.0.113.0/24', '2001:db8:cafe::/48']
        };

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                if (params[1] === keyHash) {
                    return { rows: [{ id: userRow.id, whitelisted_ips: userRow.whitelisted_ips, api_key: null, api_key_hash: keyHash }] };
                }
                return { rows: [] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                return params[1] === keyHash ? { rows: [{ ...userRow }] } : { rows: [] };
            }
            return { rows: [] };
        });

        try {
            process.env.NODE_ENV = 'test';

            // Loopback allowed in non-production
            const resDevLoop = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey }
            });
            assert.strictEqual(resDevLoop.status, 200, 'Loopback may pass in non-production');

            // IPv4 matching CIDR /24
            const resV4Match = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '203.0.113.77' }
            });
            assert.strictEqual(resV4Match.status, 200, 'IPv4 inside CIDR 203.0.113.0/24 must pass');

            // IPv4-mapped IPv6 matching IPv4 CIDR /24
            const resMappedMatch = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '::ffff:203.0.113.99' }
            });
            assert.strictEqual(resMappedMatch.status, 200, '::ffff:203.0.113.99 must normalize and match 203.0.113.0/24');

            // IPv6 matching CIDR /48
            const resV6Match = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '2001:db8:cafe:0001::42' }
            });
            assert.strictEqual(resV6Match.status, 200, 'IPv6 inside 2001:db8:cafe::/48 must pass');

            // IPv4 outside CIDR rejected on /h2h/profile AND /h2h/profile/callback
            const resV4Deny = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '203.0.114.77' }
            });
            assert.strictEqual(resV4Deny.status, 403, 'GET /h2h/profile outside whitelist must return 403');

            const resCbDeny = await fetch(`${baseUrl}/h2h/profile/callback`, {
                method: 'PUT',
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '203.0.114.77', 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_url: 'https://93.184.216.34/webhook' })
            });
            assert.strictEqual(resCbDeny.status, 403, 'PUT /h2h/profile/callback outside whitelist must return 403');

            // IPv4-mapped outside CIDR rejected
            const resMappedDeny = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '::ffff:198.51.100.10' }
            });
            assert.strictEqual(resMappedDeny.status, 403, '::ffff:x.x.x.x outside whitelist must return 403');

            // IPv6 outside CIDR rejected
            const resV6Deny = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '2001:db8:beef::1' }
            });
            assert.strictEqual(resV6Deny.status, 403, 'IPv6 outside 2001:db8:cafe::/48 must return 403');

            // NODE_ENV=production MUST NOT bypass loopback 127.0.0.1 / ::1
            process.env.NODE_ENV = 'production';
            const resProdLoopDirect = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey }
            });
            assert.strictEqual(resProdLoopDirect.status, 403, 'Direct loopback 127.0.0.1 must be blocked in production when not whitelisted');

            const resProdLoopV6 = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '::1' }
            });
            assert.strictEqual(resProdLoopV6.status, 403, 'Loopback ::1 must be blocked in production when not whitelisted');

            const resProdLoopV4Header = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': apiKey, 'X-Forwarded-For': '127.0.0.1' }
            });
            assert.strictEqual(resProdLoopV4Header.status, 403, 'Loopback 127.0.0.1 header must be blocked in production when not whitelisted');
        } finally {
            process.env.NODE_ENV = origNodeEnv;
            pool.query.mock.restore();
        }
    });

    test('SEC-008 (2): rate limit per user_id & API key memblokir meski IP berganti + kuota harian opsional via env', async () => {
        const key1 = '1'.repeat(64);
        const key2 = '2'.repeat(64);
        const hash1 = crypto.createHash('sha256').update(key1).digest('hex');
        const hash2 = crypto.createHash('sha256').update(key2).digest('hex');
        let activeHash = hash1;
        const origMaxOrdersEnv = process.env.H2H_DAILY_MAX_ORDERS;
        const origMaxAmountEnv = process.env.H2H_DAILY_MAX_AMOUNT;
        const origEnv = process.env.NODE_ENV;

        mock.method(pool, 'query', async (sql, params = []) => {
            if (typeof sql !== 'string') return { rows: [] };
            if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                return { rows: [{ id: 9808, whitelisted_ips: [], api_key: null, api_key_hash: activeHash }] };
            }
            if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                if (params[1] === activeHash) {
                    return {
                        rows: [{
                            id: 9808,
                            username: 'ratelimit_reseller',
                            balance: 500000,
                            role_id: 2,
                            role_name: 'PARTNER',
                            api_key: null,
                            api_key_hash: activeHash,
                            api_key_prefix: key1.slice(0, 8),
                            h2h_callback_url: null,
                            whitelisted_ips: []
                        }]
                    };
                }
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            process.env.NODE_ENV = 'test';
            for (let i = 1; i <= 60; i++) {
                const resOk = await fetch(`${baseUrl}/h2h/profile`, {
                    headers: { 'X-API-Key': key1, 'X-Forwarded-For': `198.51.100.${i}` }
                });
                assert.strictEqual(resOk.status, 200, `Request #${i} from distributed IP should pass under 60/min quota`);
            }

            // 61st request with SAME API key from a brand new IP must be 429
            const resKeyBlocked = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': key1, 'X-Forwarded-For': '198.51.100.61' }
            });
            assert.strictEqual(resKeyBlocked.status, 429, '61st request with same API key across rotating IPs must be blocked with 429');

            // Rotate to a NEW key for the SAME user_id (9808) from yet another new IP -> STILL blocked by per-user limiter!
            activeHash = hash2;
            const resUserBlocked = await fetch(`${baseUrl}/h2h/profile`, {
                headers: { 'X-API-Key': key2, 'X-Forwarded-For': '198.51.100.62' }
            });
            assert.strictEqual(resUserBlocked.status, 429, '62nd request for same user_id after rotating API key & IP must still be blocked with 429');

            // Test optional daily quota H2H_DAILY_MAX_ORDERS using a fresh user (id: 9809)
            const { invalidateFoxyProductCache } = require('../../server');
            invalidateFoxyProductCache();
            const quotaKey = '3'.repeat(64);
            const quotaHash = crypto.createHash('sha256').update(quotaKey).digest('hex');
            activeHash = quotaHash;
            process.env.H2H_DAILY_MAX_ORDERS = '2';

            axios.get = async () => ({
                data: { data: [{ product_code: 'ML-QUOTA', product_price: 10000 }] }
            });
            let balanceDeducted = false;
            mock.method(pool, 'connect', async () => ({
                query: async (sql) => {
                    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                    if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                        return {
                            rows: [{
                                id: 33, name: 'Quota Test Product', provider_sku: 'ML-QUOTA', price: 12000, status: 'Active',
                                game_id: 1, needs_server_id: false, validation_config: null,
                                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                            }]
                        };
                    }
                    if (typeof sql === 'string' && sql.includes('SELECT balance, role_id FROM users WHERE id')) {
                        return { rows: [{ balance: 500000, role_id: 2 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                        return { rows: [{ margin_percent: 10 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                        return { rows: [] };
                    }
                    if (typeof sql === 'string' && sql.includes('order_count')) {
                        return { rows: [{ order_count: 2, total_amount: 24000 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) {
                        balanceDeducted = true;
                        return { rowCount: 1 };
                    }
                    return { rows: [] };
                },
                release: () => {}
            }));

            // Use different user id 9809 via pool.query override
            pool.query.mock.restore();
            mock.method(pool, 'query', async (sql, params = []) => {
                if (typeof sql !== 'string') return { rows: [] };
                if (sql.includes('whitelisted_ips') && !sql.includes('FROM users u')) {
                    return { rows: [{ id: 9809, whitelisted_ips: [], api_key: null, api_key_hash: quotaHash }] };
                }
                if (sql.includes('FROM users u') && sql.includes('u.api_key = $1')) {
                    return { rows: [{ id: 9809, username: 'quota_reseller', balance: 500000, role_id: 2, role_name: 'PARTNER', api_key: null, api_key_hash: quotaHash, whitelisted_ips: [] }] };
                }
                return { rows: [] };
            });

            const resQuota = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': quotaKey, 'X-Forwarded-For': '198.51.100.63', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 33, targetGameId: '123456' })
            });
            assert.strictEqual(resQuota.status, 429, 'H2H order exceeding H2H_DAILY_MAX_ORDERS must be rejected with 429');
            assert.strictEqual(balanceDeducted, false, 'Daily quota rejection must NOT deduct balance');

            delete process.env.H2H_DAILY_MAX_ORDERS;
            process.env.H2H_DAILY_MAX_AMOUNT = '30000';
            const resAmountQuota = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': quotaKey, 'X-Forwarded-For': '198.51.100.64', 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 33, targetGameId: '123456' })
            });
            assert.strictEqual(resAmountQuota.status, 429, 'H2H order exceeding H2H_DAILY_MAX_AMOUNT must be rejected with 429');
            assert.strictEqual(balanceDeducted, false, 'Daily amount quota rejection must NOT deduct balance');
            delete process.env.H2H_DAILY_MAX_AMOUNT;
        } finally {
            if (origMaxOrdersEnv === undefined) delete process.env.H2H_DAILY_MAX_ORDERS;
            else process.env.H2H_DAILY_MAX_ORDERS = origMaxOrdersEnv;
            if (origMaxAmountEnv === undefined) delete process.env.H2H_DAILY_MAX_AMOUNT;
            else process.env.H2H_DAILY_MAX_AMOUNT = origMaxAmountEnv;
            process.env.NODE_ENV = origEnv;
            axios.get = origAxiosGet;
            require('../../server').invalidateFoxyProductCache();
            if (pool.connect.mock) pool.connect.mock.restore();
            if (pool.query.mock) pool.query.mock.restore();
        }
    });
});
