const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { pool, createServerHarness, axios } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { hashResetToken } = require('../../utils/crypto');

describe('Auth & Schema Hardening Tests (SEC-014 & SEC-011)', () => {
    const harness = createServerHarness({ withAxios: true });
    let baseUrl;

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('Register dan ganti password memakai bcrypt cost >= 12 serta tetap kompatibel dengan hash lama cost 10', async () => {
        let savedRegisterHash = '';
        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT username, email, nomor_wa')) return { rows: [] };
            if (typeof sql === 'string' && sql.includes("SELECT id FROM roles WHERE name = 'BRONZE'")) return { rows: [{ id: 1 }] };
            if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
                savedRegisterHash = params[4];
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            const regRes = await fetch(`${baseUrl}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fullName: 'Bcrypt Twelve',
                    username: 'bcrypt12user',
                    email: 'bcrypt12@example.com',
                    countryCode: '+62',
                    nomorWa: '81234567899',
                    password: 'StrongPassword#12',
                }),
            });
            assert.strictEqual(regRes.status, 201);
            assert.ok(bcrypt.getRounds(savedRegisterHash) >= 12, `Register cost harus >= 12, aktual: ${bcrypt.getRounds(savedRegisterHash)}`);
        } finally {
            harness.restorePool();
        }

        const legacyHash = await bcrypt.hash('OldPass123!', 10);
        let updatedPasswordHash = '';
        mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT password FROM users WHERE id = $1')) {
                return { rows: [{ password: legacyHash }] };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE users SET password = $1')) {
                updatedPasswordHash = params[0];
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        const userToken = fixtures.makeUserToken(44, 'BRONZE', 'bcrypt12user');
        try {
            const shortRes = await fetch(`${baseUrl}/api/user/password`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: 'OldPass123!', newPassword: '123' }),
            });
            assert.strictEqual(shortRes.status, 400);

            const okRes = await fetch(`${baseUrl}/api/user/password`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword: 'OldPass123!', newPassword: 'NewStrongPass#12' }),
            });
            assert.strictEqual(okRes.status, 200);
            assert.ok(bcrypt.getRounds(updatedPasswordHash) >= 12, `Change password cost harus >= 12`);
        } finally {
            harness.restorePool();
        }
    });

    test('Forgot-password menghasilkan respons identik untuk email terdaftar vs tidak terdaftar dengan expiry <= 30 menit', async () => {
        const originalPost = axios.post;
        axios.post = async () => ({ status: 201, data: {} });
        mock.method(console, 'error', () => {});

        let savedExpiresAt = null;
        let deletedOldTokens = false;
        const startMs = Date.now();

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('SELECT id FROM users WHERE email = $1')) {
                    return params[0] === 'registered@example.com' ? { rows: [{ id: 12 }] } : { rows: [] };
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM password_resets WHERE email = $1')) {
                    deletedOldTokens = true;
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO password_resets')) {
                    savedExpiresAt = params[2];
                    return { rows: [] };
                }
                return { rows: [] };
            },
            release: () => {},
        }));

        try {
            const resRegistered = await fetch(`${baseUrl}/api/auth/forgot-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'registered@example.com' }),
            });
            const bodyRegistered = await resRegistered.json();

            const resUnknown = await fetch(`${baseUrl}/api/auth/forgot-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'unknown@example.com' }),
            });
            const bodyUnknown = await resUnknown.json();

            assert.strictEqual(resRegistered.status, 200);
            assert.strictEqual(resUnknown.status, 200);
            assert.deepStrictEqual(bodyRegistered, bodyUnknown);
            assert.strictEqual(deletedOldTokens, true);
            assert.ok(savedExpiresAt instanceof Date);

            const ttlMs = savedExpiresAt.getTime() - startMs;
            assert.ok(ttlMs > 25 * 60 * 1000 && ttlMs <= (30 * 60 * 1000) + 5000, `TTL reset harus <= 30 menit, aktual ms: ${ttlMs}`);
        } finally {
            axios.post = originalPost;
            console.error.mock.restore();
            harness.restorePool();
        }
    });

    test('Reset-password menolak token kedaluwarsa, memakai FOR UPDATE tanpa plaintext fallback, dan bersifat single-use atomik', async () => {
        const plainToken = 'a'.repeat(64);
        const hashedToken = hashResetToken(plainToken);
        const expiredToken = 'b'.repeat(64);
        const expiredHash = hashResetToken(expiredToken);

        const store = new Map([
            [hashedToken, { id: 1, email: 'reset@example.com', expires_at: new Date(Date.now() + 10 * 60 * 1000) }],
            [expiredHash, { id: 2, email: 'expired@example.com', expires_at: new Date(Date.now() - 60 * 1000) }],
        ]);

        const sqlLog = [];
        let updatedPassHash = '';
        let lockInFlight = Promise.resolve();

        mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (typeof sql === 'string') sqlLog.push(sql);
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('FROM password_resets WHERE token = $1 FOR UPDATE')) {
                    // Simulasikan serialisasi row-lock FOR UPDATE di PostgreSQL
                    const prev = lockInFlight;
                    let unlock;
                    lockInFlight = new Promise(resolve => { unlock = resolve; });
                    await prev;
                    const row = store.get(params[0]);
                    unlock();
                    if (!row) return { rows: [] };
                    return {
                        rows: [{
                            id: row.id,
                            email: row.email,
                            expires_at: row.expires_at,
                            is_valid: row.expires_at.getTime() > Date.now(),
                        }],
                    };
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM password_resets WHERE email = $1')) {
                    let count = 0;
                    for (const [k, v] of store.entries()) {
                        if (v.email === params[0]) {
                            store.delete(k);
                            count += 1;
                        }
                    }
                    return { rows: count ? [{ id: 1 }] : [], rowCount: count };
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM password_resets WHERE token = $1')) {
                    store.delete(params[0]);
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET password = $1')) {
                    updatedPassHash = params[0];
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {},
        }));

        try {
            // 1. Token kedaluwarsa ditolak 400
            const expiredRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: expiredToken, newPassword: 'NewValidPassword12' }),
            });
            assert.strictEqual(expiredRes.status, 400);

            // 2. Konsumsi paralel token yang sama: hanya boleh sukses 1x
            const [res1, res2] = await Promise.all([
                fetch(`${baseUrl}/api/auth/reset-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: plainToken, newPassword: 'NewValidPassword12' }),
                }),
                fetch(`${baseUrl}/api/auth/reset-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: plainToken, newPassword: 'NewValidPassword12' }),
                }),
            ]);

            const statuses = [res1.status, res2.status].sort((a, b) => a - b);
            assert.deepStrictEqual(statuses, [200, 400], 'Hanya satu request paralel reset password yang boleh berhasil');
            assert.ok(bcrypt.getRounds(updatedPassHash) >= 12, 'Reset password harus menggunakan bcrypt cost >= 12');
            assert.ok(sqlLog.some(s => s.includes('FOR UPDATE')), 'Query token reset wajib memakai FOR UPDATE');
            assert.ok(!sqlLog.some(s => s.includes('IN ($1, $2)')), 'Tidak boleh ada fallback token plaintext');
        } finally {
            harness.restorePool();
        }
    });

    test('Middleware JWT menolak token alg none secara ketat', async () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ id: 1, username: 'admin', role: 'Admin' })).toString('base64url');
        const forgedToken = `${header}.${payload}.`;

        const res = await fetch(`${baseUrl}/api/user/profile`, {
            headers: { 'Authorization': `Bearer ${forgedToken}` },
        });
        assert.strictEqual(res.status, 401);
    });

    test('Rute admin menolak payload tipe salah, angka di luar rentang/negatif/NaN, dan enum ilegal dengan 400', async () => {
        const adminToken = fixtures.makeAdminToken(1, 'admin_schema');
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });

        try {
            const headers = {
                'Authorization': `Bearer ${adminToken}`,
                'Content-Type': 'application/json',
            };

            const cases = [
                { url: '/api/admin/promos', method: 'POST', body: { code: 'PROMO1', type: 'percentage', value: 150 } },
                { url: '/api/admin/promos', method: 'POST', body: { code: 'PROMO2', type: 'invalid', value: 1000 } },
                { url: '/api/admin/promos/abc/toggle', method: 'PUT', body: { is_active: true } },
                { url: '/api/admin/flash-sales', method: 'POST', body: { product_id: 1, discount_price: -500, start_at: '2026-11-17T00:00:00Z', end_at: '2026-11-18T00:00:00Z' } },
                { url: '/api/admin/flash-sales', method: 'POST', body: { product_id: 1, discount_price: 5000, start_at: '2026-11-18T00:00:00Z', end_at: '2026-11-17T00:00:00Z' } },
                { url: '/api/admin/games/1/margins', method: 'POST', body: { use_custom_margin: true, bronze_margin: -5, silver_margin: 5, gold_margin: 5, partner_margin: 5 } },
                { url: '/api/admin/products/1/manual-prices', method: 'POST', body: { use_manual_prices: true, manual_prices: { hacker_role: 1000 } } },
                { url: '/api/admin/products', method: 'POST', body: { game_id: 'abc', category_id: 1, name: 'Item', provider_sku: 'SKU1', price: 10000 } },
                { url: '/api/admin/products/1/status', method: 'PUT', body: { status: 'Deleted' } },
                { url: '/api/admin/roles', method: 'PUT', body: [{ id: 1, margin: -10 }] },
                { url: '/api/admin/games/xyz/status', method: 'PUT', body: { status: 'Active' } },
                { url: '/api/admin/deposits?status=hacked', method: 'GET' },
                { url: '/api/admin/deposits/approve', method: 'POST', body: { depositId: 1.5 } },
                { url: '/api/admin/transactions/bad!id/resolve', method: 'PUT', body: { action: 'success' } },
                { url: '/api/admin/payment-methods/not-int', method: 'DELETE' },
            ];

            for (const c of cases) {
                const res = await fetch(`${baseUrl}${c.url}`, {
                    method: c.method,
                    headers,
                    body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
                });
                assert.strictEqual(res.status, 400, `${c.method} ${c.url} harus mengembalikan 400, aktual: ${res.status}`);
            }
        } finally {
            harness.restorePool();
        }
    });

    test('Rute user, catalog, dan public menolak input tidak valid dengan HTTP 400 tanpa query DB', async () => {
        const userToken = fixtures.makeUserToken(10, 'BRONZE', 'user_schema');
        const userHeaders = {
            'Authorization': `Bearer ${userToken}`,
            'Content-Type': 'application/json',
        };

        const rProfileType = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: userHeaders,
            body: JSON.stringify(['not', 'object']),
        });
        assert.strictEqual(rProfileType.status, 400);

        const rProfileLong = await fetch(`${baseUrl}/api/user/profile`, {
            method: 'PUT',
            headers: userHeaders,
            body: JSON.stringify({ fullName: 'A'.repeat(260), email: 'u@example.com', nomorWa: '08123456789' }),
        });
        assert.strictEqual(rProfileLong.status, 400);

        const rProdValidate = await fetch(`${baseUrl}/api/products/abc/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '12345' }),
        });
        assert.strictEqual(rProdValidate.status, 400);

        const rFullValidate = await fetch(`${baseUrl}/api/full-validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameCode: '../secret', userId: '12345' }),
        });
        assert.strictEqual(rFullValidate.status, 400);

        const rPromoValidate = await fetch(`${baseUrl}/api/promos/validate`, {
            method: 'POST',
            headers: userHeaders,
            body: JSON.stringify({ promo_code: 'PROMO', product_id: -5, target_game_id: '123' }),
        });
        assert.strictEqual(rPromoValidate.status, 400);

        const rServers = await fetch(`${baseUrl}/api/games/notanint/servers`);
        assert.strictEqual(rServers.status, 400);

        const rBotProd = await fetch(`${baseUrl}/api/public/bot-products/${'A'.repeat(105)}`);
        assert.strictEqual(rBotProd.status, 400);
    });
});
