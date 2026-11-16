const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { errorHandler } = require('../../middleware/errorHandler');
const { recordAdminAuditLog } = require('../../services/auditLogService');
const { redactSensitiveData, safeErrorDetail, logSafeError } = require('../../utils/logger');
const { isSafeAssetUrl } = require('../../utils/validation');
const { hashApiKey } = require('../../utils/crypto');

describe('Security Hardening Tests (SEC-016a..d)', () => {
    const harness = createServerHarness();
    let baseUrl;

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('Global error handler mengembalikan JSON 400 untuk JSON rusak tanpa stack trace atau path server', async () => {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.161',
            },
            body: '{"broken":',
        });

        assert.strictEqual(res.status, 400);
        assert.ok((res.headers.get('content-type') || '').includes('application/json'));
        const text = await res.text();
        const body = JSON.parse(text);
        assert.strictEqual(body.message, 'Format JSON pada request body tidak valid.');
        assert.ok(!text.includes('SyntaxError'), 'Tidak boleh membocorkan tipe error parser internal');
        assert.ok(!text.includes('node_modules') && !text.includes('backend'), 'Tidak boleh membocorkan path server');
    });

    test('Global error handler menahan kebocoran stack trace, SQL, dan secret pada error 500 tak terduga', async () => {
        const tempApp = express();
        tempApp.get('/boom', () => {
            throw new Error('SELECT password_hash FROM users WHERE token=supersecret123 at D:\\topup-miku\\backend\\secret.js');
        });
        tempApp.use(errorHandler);

        const logs = [];
        mock.method(console, 'error', (...args) => logs.push(args));
        const srv = tempApp.listen(0);
        try {
            const port = srv.address().port;
            const res = await fetch(`http://127.0.0.1:${port}/boom`);
            assert.strictEqual(res.status, 500);
            const text = await res.text();
            const body = JSON.parse(text);
            assert.strictEqual(body.message, 'Terjadi kesalahan internal pada server.');
            assert.ok(!text.includes('SELECT'), 'Respons 500 tidak boleh membocorkan query SQL');
            assert.ok(!text.includes('supersecret123'), 'Respons 500 tidak boleh membocorkan secret');
            assert.ok(!text.includes('topup-miku'), 'Respons 500 tidak boleh membocorkan path filesystem');

            const serializedLog = JSON.stringify(logs);
            assert.ok(!serializedLog.includes('supersecret123'), 'Log error 500 wajib meredaksi token sensitif');
            assert.ok(serializedLog.includes('[REDACTED]'), 'Log error 500 harus mengganti token dengan [REDACTED]');
        } finally {
            console.error.mock.restore();
            await new Promise(resolve => srv.close(resolve));
        }
    });

    test('Security headers ketat, CSP tanpa unsafe-eval/script unsafe-inline, HSTS kondisional, dan CORS whitelist 403 JSON', async () => {
        const resAllowed = await fetch(`${baseUrl}/healthz`, {
            headers: {
                'Origin': 'http://localhost:3000',
                'X-Forwarded-Proto': 'https',
            },
        });
        assert.strictEqual(resAllowed.status, 200);
        assert.strictEqual(resAllowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
        assert.strictEqual(resAllowed.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(resAllowed.headers.get('x-frame-options'), 'DENY');
        assert.strictEqual(resAllowed.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        assert.strictEqual(resAllowed.headers.get('x-powered-by'), null);
        assert.strictEqual(resAllowed.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');

        const csp = resAllowed.headers.get('content-security-policy') || '';
        assert.ok(csp.includes("default-src 'self'"));
        assert.ok(csp.includes("script-src 'self'"));
        assert.ok(!csp.includes("'unsafe-eval'"), 'CSP tidak boleh mengandung unsafe-eval');
        assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'script-src tidak boleh mengizinkan unsafe-inline');
        assert.ok(csp.includes("frame-ancestors 'none'"));
        assert.ok(csp.includes("object-src 'none'"));

        const resBlocked = await fetch(`${baseUrl}/healthz`, {
            headers: { 'Origin': 'https://evil.example' },
        });
        assert.strictEqual(resBlocked.status, 403);
        const allowOrigin = resBlocked.headers.get('access-control-allow-origin');
        assert.ok(allowOrigin !== '*' && allowOrigin !== 'https://evil.example');
        const corsBody = await resBlocked.json();
        assert.strictEqual(corsBody.message, 'Origin tidak diizinkan oleh CORS.');
    });

    test('auditLogService meredaksi rahasia payload, mencatat parameter terstruktur, dan fail-safe saat DB error', async () => {
        const captured = [];
        const okPool = {
            query: async (sql, params) => {
                captured.push({ sql, params });
                return { rows: [] };
            },
        };

        const resOk = await recordAdminAuditLog(okPool, {
            req: {
                user: { id: 7 },
                ip: '127.0.0.1',
                headers: { 'user-agent': 'MikuTestAgent/1.0' },
            },
            action: 'admin.test.update',
            targetType: 'config',
            targetId: '42',
            beforeData: { api_key: 'plain-secret-key', note: 'lama' },
            afterData: { token: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb', note: 'baru' },
        });

        assert.strictEqual(resOk.recorded, true);
        assert.strictEqual(captured.length, 1);
        assert.ok(captured[0].sql.includes('INSERT INTO admin_audit_logs'));
        assert.strictEqual(captured[0].params[0], 7);
        assert.strictEqual(captured[0].params[1], 'admin.test.update');
        assert.strictEqual(captured[0].params[2], 'config');
        assert.strictEqual(captured[0].params[3], '42');
        assert.ok(!captured[0].params[4].includes('plain-secret-key'));
        assert.ok(captured[0].params[4].includes('[REDACTED]'));
        assert.ok(!captured[0].params[5].includes('aaaa.bbbb'));

        mock.method(console, 'error', () => {});
        try {
            const failPool = {
                query: async () => {
                    throw new Error('relation "admin_audit_logs" does not exist');
                },
            };
            const resFail = await recordAdminAuditLog(failPool, {
                adminId: 7,
                action: 'admin.test.fail',
                targetType: 'config',
                targetId: '1',
            });
            assert.strictEqual(resFail.recorded, false);
        } finally {
            console.error.mock.restore();
        }
    });

    test('Mutasi sensitif admin mencatat audit log dengan action, target_type, target_id, dan IP/admin_id', async () => {
        const adminToken = fixtures.makeAdminToken(99, 'admin_audit');
        const recordedAudits = [];

        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO admin_audit_logs')) {
                recordedAudits.push({
                    adminId: params[0],
                    action: params[1],
                    targetType: params[2],
                    targetId: params[3],
                    beforeJson: params[4],
                    afterJson: params[5],
                });
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO game_margins')) {
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO games')) {
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO payment_methods')) {
                return {
                    rows: [{
                        id: 33, code: params[0], name: params[1], type: params[2],
                        account_number: params[3], account_name: params[4], qris_image_url: params[5],
                        instructions: params[6], is_qris: params[7], min_amount: params[8],
                        is_active: params[9], sort_order: params[10],
                    }],
                };
            }
            return { rows: [] };
        });

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (sql.includes('FROM users WHERE username = $1')) {
                    return { rows: [{ id: 15, balance: 25000 }] };
                }
                if (sql.includes('FROM deposits WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 88, user_id: 15, amount: 50000, status: 'Pending', method: 'GoPay' }] };
                }
                if (sql.includes('SELECT * FROM transactions WHERE invoice_id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 77, invoice_id: 'TRX-AUDIT-1', user_id: 15, price: 20000, status: 'Partial Refund' }] };
                }
                return { rows: [], rowCount: 1 };
            },
            release: () => {},
        }));

        try {
            const headers = {
                'Authorization': `Bearer ${adminToken}`,
                'Content-Type': 'application/json',
            };

            const r1 = await fetch(`${baseUrl}/api/admin/balance/add`, {
                method: 'POST', headers, body: JSON.stringify({ username: 'member', amount: 10000, description: 'Bonus audit' }),
            });
            assert.strictEqual(r1.status, 200);

            const r2 = await fetch(`${baseUrl}/api/admin/deposits/approve`, {
                method: 'POST', headers, body: JSON.stringify({ depositId: 88 }),
            });
            assert.strictEqual(r2.status, 200);

            const r3 = await fetch(`${baseUrl}/api/admin/transactions/TRX-AUDIT-1/resolve`, {
                method: 'PUT', headers, body: JSON.stringify({ action: 'success' }),
            });
            assert.strictEqual(r3.status, 200);

            const r4 = await fetch(`${baseUrl}/api/admin/games/5/margins`, {
                method: 'POST', headers,
                body: JSON.stringify({ use_custom_margin: true, bronze_margin: 5, silver_margin: 4, gold_margin: 3, partner_margin: 2 }),
            });
            assert.strictEqual(r4.status, 200);

            const r5 = await fetch(`${baseUrl}/api/admin/games`, {
                method: 'POST', headers,
                body: JSON.stringify({ name: 'Audit Game', category: 'Mobile Game', imageUrl: 'https://cdn.example.com/game.png' }),
            });
            assert.strictEqual(r5.status, 201);

            const r6 = await fetch(`${baseUrl}/api/admin/payment-methods`, {
                method: 'POST', headers,
                body: JSON.stringify({ code: 'QRIS_AUDIT', name: 'QRIS Audit', type: 'qris', qris_image_url: 'https://cdn.example.com/qris.png' }),
            });
            assert.strictEqual(r6.status, 201);

            const actions = recordedAudits.map(a => a.action);
            assert.deepStrictEqual(actions, [
                'admin.balance.add',
                'admin.deposit.approve',
                'admin.transaction.resolve',
                'admin.game_margins.update',
                'admin.game.create',
                'admin.payment_method.create',
            ]);
            assert.ok(recordedAudits.every(a => a.adminId === 99));
        } finally {
            harness.restorePool();
        }
    });

    test('Logger deep redaction menyensor password, token, jwt, api_key, secret, authorization, dan x-api-key', () => {
        const payload = {
            password: 'myPassword123',
            nested: {
                jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MX0.sig',
                api_key: 'abcdef123456',
                secret: 'foxySecret',
            },
            headers: {
                Authorization: 'Bearer secret-bearer-token',
                'x-api-key': 'raw-h2h-key',
                'x-callback-token': 'cb-secret',
                'content-type': 'application/json',
            },
        };
        payload.self = payload;

        const clean = redactSensitiveData(payload);
        assert.strictEqual(clean.password, '[REDACTED]');
        assert.strictEqual(clean.nested.jwt, '[REDACTED]');
        assert.strictEqual(clean.nested.api_key, '[REDACTED]');
        assert.strictEqual(clean.nested.secret, '[REDACTED]');
        assert.strictEqual(clean.headers.Authorization, '[REDACTED]');
        assert.strictEqual(clean.headers['x-api-key'], '[REDACTED]');
        assert.strictEqual(clean.headers['x-callback-token'], '[REDACTED]');
        assert.strictEqual(clean.headers['content-type'], 'application/json');
        assert.strictEqual(clean.self, '[Circular]');

        const detail = safeErrorDetail(new Error('Failed calling https://x.test?token=tok123 with Authorization: Bearer topsecret'));
        assert.ok(!detail.message.includes('tok123'));
        assert.ok(!detail.message.includes('topsecret'));

        let logged = '';
        mock.method(console, 'error', (label, data) => {
            logged = `${label} ${JSON.stringify(data)}`;
        });
        try {
            logSafeError('[logger-test]', { api_key: 'leak-nope', ok: 'visible' });
            assert.ok(!logged.includes('leak-nope'));
            assert.ok(logged.includes('[REDACTED]') && logged.includes('visible'));
        } finally {
            console.error.mock.restore();
        }
    });

    test('Validasi anti-SSRF menolak localhost, IP privat, link-local, metadata, dan HTTP di prod secara konsisten', async () => {
        const blockedUrls = [
            'http://127.0.0.1/img.png',
            'https://localhost/img.png',
            'http://169.254.169.254/latest/meta-data',
            'https://10.0.0.5/img.png',
            'https://172.16.0.1/img.png',
            'https://192.168.1.1/img.png',
            'https://[::1]/img.png',
            'https://[::ffff:127.0.0.1]/img.png',
            'https://metadata.google.internal/computeMetadata/v1/',
            'https://user:pass@cdn.example.com/img.png',
            'javascript:alert(1)',
            '//evil.example/img.png',
            '/images/../../secret.png',
        ];
        for (const url of blockedUrls) {
            assert.strictEqual(isSafeAssetUrl(url, { allowEmpty: false }), false, `Harusnya ditolak: ${url}`);
        }
        assert.strictEqual(isSafeAssetUrl('https://cdn.example.com/mlbb.png', { allowEmpty: false }), true);
        assert.strictEqual(isSafeAssetUrl('/images/qris.png', { allowEmpty: false }), true);

        const prevEnv = process.env.NODE_ENV;
        const adminToken = fixtures.makeAdminToken(99, 'admin_ssrf');
        const h2hKey = 'a'.repeat(64);
        const h2hHash = hashApiKey(h2hKey);

        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('WHERE u.api_key_hash = $2')) {
                return { rows: [{ id: 50, username: 'h2h_ssrf', balance: 10000, api_key_hash: h2hHash, api_key_prefix: 'aaaaaaaa', role_id: 2, role_name: 'PARTNER' }] };
            }
            return { rows: [] };
        });

        try {
            process.env.NODE_ENV = 'production';
            assert.strictEqual(isSafeAssetUrl('http://cdn.example.com/mlbb.png', { allowEmpty: false }), false);

            const badGameRes = await fetch(`${baseUrl}/api/admin/games`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'SSRF Game', category: 'Mobile Game', imageUrl: 'http://169.254.169.254/latest/meta-data' }),
            });
            assert.strictEqual(badGameRes.status, 400);

            const httpGameProdRes = await fetch(`${baseUrl}/api/admin/games`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'HTTP Game', category: 'Mobile Game', imageUrl: 'http://cdn.example.com/game.png' }),
            });
            assert.strictEqual(httpGameProdRes.status, 400);

            const badPmRes = await fetch(`${baseUrl}/api/admin/payment-methods`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: 'QRIS_SSRF', name: 'QRIS SSRF', type: 'qris', qris_image_url: 'http://127.0.0.1/qris.png' }),
            });
            assert.strictEqual(badPmRes.status, 400);

            process.env.NODE_ENV = 'test';
            const badH2hCbRes = await fetch(`${baseUrl}/h2h/profile/callback`, {
                method: 'PUT',
                headers: { 'X-API-Key': h2hKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_url: 'https://192.168.1.10/callback' }),
            });
            assert.strictEqual(badH2hCbRes.status, 400);
        } finally {
            process.env.NODE_ENV = prevEnv;
            harness.restorePool();
        }
    });
});
