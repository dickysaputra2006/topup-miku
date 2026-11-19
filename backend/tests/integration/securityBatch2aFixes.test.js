const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { JWT_SECRET } = require('../../config/env');

describe('QA Batch 2A: Auth Revocation, Email Cascade, Validation & Public Exposure', () => {
    const harness = createServerHarness();
    let baseUrl;

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('BUG-008: migrasi 013 menambahkan ON UPDATE CASCADE pada fk_password_resets_email & PUT /api/user/profile memperbarui email 200', async () => {
        const migrationPath = path.resolve(__dirname, '../../../migrations/013_auth_revocation_and_email_cascade.sql');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1/i);
        assert.match(migrationSql, /fk_password_resets_email/i);
        assert.match(migrationSql, /ON DELETE CASCADE/i);
        assert.match(migrationSql, /ON UPDATE CASCADE/i);

        let updateParams = null;
        const queryMock = mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users')) {
                return { rows: [{ token_version: 1 }] };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE users SET full_name = $1, email = $2, nomor_wa = $3 WHERE id = $4')) {
                updateParams = params;
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        try {
            const token = fixtures.makeUserToken(301, 'BRONZE', 'qa_email_user');
            const res = await fetch(`${baseUrl}/api/user/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    fullName: 'QA Updated User',
                    email: 'Updated.User@Local.Test',
                    nomorWa: '081234567890',
                    countryCode: '+62',
                }),
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.match(data.message, /berhasil diperbarui/i);
            assert.deepStrictEqual(updateParams, [
                'QA Updated User',
                'updated.user@local.test',
                '+6281234567890',
                301,
            ]);
        } finally {
            queryMock.mock.restore();
        }
    });

    test('BUG-011 (1): login menerima email huruf campuran secara case-insensitive dan menyematkan klaim tokenVersion pada JWT', async () => {
        const passwordHash = bcrypt.hashSync('RahasiaBatch2A!', 4);
        let loginSql = '';
        let loginParams = null;

        const queryMock = mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) {
                loginSql = sql;
                loginParams = params;
                return {
                    rows: [{
                        id: 302,
                        username: 'qa_mixed_user',
                        email: 'qa.mixed@local.test',
                        password: passwordHash,
                        role_name: 'BRONZE',
                        token_version: 3,
                    }],
                };
            }
            return { rows: [] };
        });

        try {
            const res = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: 'QA.MIXED@LOCAL.TEST',
                    password: 'RahasiaBatch2A!',
                }),
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.ok(data.token, 'JWT harus dikembalikan saat login email huruf campuran');
            assert.match(loginSql, /LOWER\(u\.email\)\s*=\s*LOWER\(\$2\)/i);
            assert.deepStrictEqual(loginParams, ['QA.MIXED@LOCAL.TEST', 'QA.MIXED@LOCAL.TEST']);

            const decoded = jwt.verify(data.token, JWT_SECRET, { algorithms: ['HS256'] });
            assert.strictEqual(decoded.id, 302);
            assert.strictEqual(decoded.tokenVersion, 3);
        } finally {
            queryMock.mock.restore();
        }
    });

    test('BUG-011 (2): PUT /api/user/password dan POST /api/auth/reset-password menaikkan token_version serta mencabut JWT lama (401)', async () => {
        const oldPasswordHash = bcrypt.hashSync('PasswordLama123!', 4);
        const resetTokenPlain = crypto.randomBytes(32).toString('hex');
        const resetTokenHash = crypto.createHash('sha256').update(resetTokenPlain).digest('hex');

        let currentTokenVersion = 1;
        let sawPasswordUpdateIncrement = false;
        let sawResetUpdateIncrement = false;

        const queryMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users')) {
                return { rows: [{ token_version: currentTokenVersion }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT u.id, u.full_name')) {
                return {
                    rows: [{
                        id: 303,
                        full_name: 'QA Revoke',
                        username: 'qa_revoke',
                        email: 'qa.revoke@local.test',
                        nomor_wa: '+628120000001',
                        balance: 50000,
                        role: 'BRONZE',
                    }],
                };
            }
            if (typeof sql === 'string' && sql.includes('SELECT password FROM users WHERE id = $1')) {
                return { rows: [{ password: oldPasswordHash }] };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE users SET password = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2')) {
                sawPasswordUpdateIncrement = true;
                currentTokenVersion += 1;
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        const connectMock = mock.method(pool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                if (typeof sql === 'string' && sql.includes('FROM password_resets WHERE token = $1 FOR UPDATE')) {
                    assert.strictEqual(params[0], resetTokenHash);
                    return {
                        rows: [{
                            id: 901,
                            email: 'qa.revoke@local.test',
                            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                            is_valid: true,
                        }],
                    };
                }
                if (typeof sql === 'string' && sql.includes('DELETE FROM password_resets WHERE email = $1')) {
                    return { rowCount: 1, rows: [{ id: 901 }] };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET password = $1, token_version = COALESCE(token_version, 1) + 1 WHERE LOWER(email) = LOWER($2)')) {
                    sawResetUpdateIncrement = true;
                    currentTokenVersion += 1;
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {},
        }));

        try {
            const tokenV1 = jwt.sign({ id: 303, username: 'qa_revoke', role: 'BRONZE', tokenVersion: 1 }, JWT_SECRET, { expiresIn: '1h' });
            const legacyTokenNoClaim = fixtures.makeUserToken(303, 'BRONZE', 'qa_revoke');

            // Sebelum ganti password: kedua token (v1 dan legacy tanpa klaim) masih valid
            const preRes1 = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${tokenV1}` } });
            const preResLegacy = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${legacyTokenNoClaim}` } });
            assert.strictEqual(preRes1.status, 200);
            assert.strictEqual(preResLegacy.status, 200);

            // Ganti password menaikkan token_version 1 -> 2
            const changeRes = await fetch(`${baseUrl}/api/user/password`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${tokenV1}`,
                },
                body: JSON.stringify({
                    currentPassword: 'PasswordLama123!',
                    newPassword: 'PasswordBaru456!',
                }),
            });
            assert.strictEqual(changeRes.status, 200);
            assert.strictEqual(sawPasswordUpdateIncrement, true);
            assert.strictEqual(currentTokenVersion, 2);

            // Kedua token lama langsung ditolak 401
            const postOldRes = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${tokenV1}` } });
            const postLegacyRes = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${legacyTokenNoClaim}` } });
            assert.strictEqual(postOldRes.status, 401);
            assert.strictEqual(postLegacyRes.status, 401);

            // Token baru (v2) diterima 200
            const tokenV2 = jwt.sign({ id: 303, username: 'qa_revoke', role: 'BRONZE', tokenVersion: 2 }, JWT_SECRET, { expiresIn: '1h' });
            const v2Res = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${tokenV2}` } });
            assert.strictEqual(v2Res.status, 200);

            // Reset password menaikkan token_version 2 -> 3
            const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: resetTokenPlain,
                    newPassword: 'PasswordReset789!',
                }),
            });
            assert.strictEqual(resetRes.status, 200);
            assert.strictEqual(sawResetUpdateIncrement, true);
            assert.strictEqual(currentTokenVersion, 3);

            // Token v2 kini ikut dicabut (401)
            const revokedV2Res = await fetch(`${baseUrl}/api/user/profile`, { headers: { Authorization: `Bearer ${tokenV2}` } });
            assert.strictEqual(revokedV2Res.status, 401);
        } finally {
            queryMock.mock.restore();
            connectMock.mock.restore();
        }
    });

    test('BUG-005: POST /api/admin/balance/add dan /reduce menolak "1e5", 0.5, negatif, serta payload bukan objek (400) tanpa membuka transaksi DB', async () => {
        const adminToken = fixtures.makeAdminToken(1);
        let connectCalls = 0;
        const recordedUpdates = [];

        const queryMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users')) {
                return { rows: [{ token_version: 1 }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name FROM users u')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            return { rows: [] };
        });

        const connectMock = mock.method(pool, 'connect', async () => {
            connectCalls += 1;
            return {
                query: async (sql, params) => {
                    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
                    if (typeof sql === 'string' && sql.includes('SELECT id, balance FROM users WHERE username = $1 OR LOWER(email) = LOWER($2) FOR UPDATE')) {
                        if (params[0] === 'missing_user') return { rows: [] };
                        return { rows: [{ id: 404, balance: 100000 }] };
                    }
                    if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance')) {
                        recordedUpdates.push({ sql, params });
                        return { rowCount: 1 };
                    }
                    if (typeof sql === 'string' && sql.includes('INSERT INTO balance_history')) {
                        return { rowCount: 1 };
                    }
                    return { rows: [] };
                },
                release: () => {},
            };
        });

        try {
            const invalidPayloads = [
                { username: 'qa_member', amount: '1e5', description: 'scientific notation' },
                { username: 'qa_member', amount: 0.5, description: 'float amount' },
                { username: 'qa_member', amount: -5000, description: 'negative amount' },
                ['non-object-array'],
            ];

            for (const endpoint of ['/api/admin/balance/add', '/api/admin/balance/reduce']) {
                for (const payload of invalidPayloads) {
                    const res = await fetch(`${baseUrl}${endpoint}`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${adminToken}`,
                        },
                        body: JSON.stringify(payload),
                    });
                    assert.strictEqual(res.status, 400, `${endpoint} harus tolak 400 untuk payload ${JSON.stringify(payload)}`);
                }
            }
            assert.strictEqual(connectCalls, 0, 'pool.connect tidak boleh dipanggil untuk payload invalid');

            // User tidak ditemukan -> 404
            const notFoundRes = await fetch(`${baseUrl}/api/admin/balance/add`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({ username: 'missing_user', amount: 50000, description: 'cek 404' }),
            });
            assert.strictEqual(notFoundRes.status, 404);

            // Nominal integer positif valid -> 200 untuk add dan reduce
            const addRes = await fetch(`${baseUrl}/api/admin/balance/add`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({ username: 'qa_member', amount: 50000, description: 'Topup manual QA' }),
            });
            assert.strictEqual(addRes.status, 200);

            const reduceRes = await fetch(`${baseUrl}/api/admin/balance/reduce`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${adminToken}`,
                },
                body: JSON.stringify({ username: 'qa_member', amount: 25000, description: 'Koreksi saldo QA' }),
            });
            assert.strictEqual(reduceRes.status, 200);
            assert.strictEqual(recordedUpdates.length, 2);
            assert.strictEqual(recordedUpdates[0].params[0], 50000);
            assert.strictEqual(recordedUpdates[1].params[0], 25000);
        } finally {
            queryMock.mock.restore();
            connectMock.mock.restore();
        }
    });

    test('BUG-009: PUT /api/user/whitelisted-ips menolak elemen non-string ([123]), string kosong, dan IP invalid (400) tanpa menghapus whitelist', async () => {
        const userToken = fixtures.makeUserToken(305, 'BRONZE', 'qa_ip_user');
        const savedIpPayloads = [];

        const queryMock = mock.method(pool, 'query', async (sql, params) => {
            if (typeof sql === 'string' && sql.includes('SELECT token_version FROM users')) {
                return { rows: [{ token_version: 1 }] };
            }
            if (typeof sql === 'string' && sql.includes('UPDATE users SET whitelisted_ips = $1 WHERE id = $2')) {
                savedIpPayloads.push(params[0]);
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        try {
            const invalidBodies = [
                { ips: [123] },
                { ips: [''] },
                { ips: ['   '] },
                { ips: ['203.0.113.10', 123] },
                { ips: ['999.999.1.1'] },
                ['not-an-object'],
            ];

            for (const body of invalidBodies) {
                const res = await fetch(`${baseUrl}/api/user/whitelisted-ips`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${userToken}`,
                    },
                    body: JSON.stringify(body),
                });
                assert.strictEqual(res.status, 400, `Harus tolak 400 untuk body ${JSON.stringify(body)}`);
            }
            assert.strictEqual(savedIpPayloads.length, 0, 'UPDATE whitelisted_ips tidak boleh dijalankan saat input invalid');

            // Input valid dengan duplikat & CIDR -> 200 & deduplikasi
            const okRes = await fetch(`${baseUrl}/api/user/whitelisted-ips`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${userToken}`,
                },
                body: JSON.stringify({ ips: ['203.0.113.10', '198.51.100.0/24', '203.0.113.10'] }),
            });
            assert.strictEqual(okRes.status, 200);
            assert.deepStrictEqual(savedIpPayloads[0], ['203.0.113.10', '198.51.100.0/24']);

            // Array kosong eksplisit tetap diizinkan (menonaktifkan whitelist secara sadar)
            const clearRes = await fetch(`${baseUrl}/api/user/whitelisted-ips`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${userToken}`,
                },
                body: JSON.stringify({ ips: [] }),
            });
            assert.strictEqual(clearRes.status, 200);
            assert.deepStrictEqual(savedIpPayloads[1], []);
        } finally {
            queryMock.mock.restore();
        }
    });

    test('BUG-015: GET /api/public/compare-prices memfilter g.status = Active dan tidak membocorkan base_price', async () => {
        let productsSql = '';
        const queryMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM products p') && sql.includes('JOIN games g')) {
                productsSql = sql;
                return {
                    rows: [{
                        id: 101,
                        game_id: 1,
                        name: '86 Diamonds',
                        provider_sku: 'DUMMY-ML-86',
                        price: 19000,
                        game_name: 'Mobile Legends',
                        use_manual_prices: false,
                        manual_prices: null,
                        use_custom_margin: false,
                    }],
                };
            }
            if (typeof sql === 'string' && sql.includes('SELECT name, margin_percent FROM roles')) {
                return {
                    rows: [
                        { name: 'BRONZE', margin_percent: 12 },
                        { name: 'SILVER', margin_percent: 8 },
                    ],
                };
            }
            if (typeof sql === 'string' && sql.includes("SELECT id, name FROM games WHERE status = 'Active'")) {
                return { rows: [{ id: 1, name: 'Mobile Legends' }] };
            }
            if (typeof sql === 'string' && sql.includes('FROM flash_sales')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        try {
            const res = await fetch(`${baseUrl}/api/public/compare-prices`);
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.match(productsSql, /p\.status\s*=\s*'Active'\s+AND\s+g\.status\s*=\s*'Active'/i);
            assert.strictEqual(data.products.length, 1);
            assert.strictEqual('base_price' in data.products[0], false, 'Field modal internal base_price tidak boleh bocor ke publik');
            assert.strictEqual(data.products[0].price_bronze, 21281);
            assert.strictEqual(data.products[0].price_silver, 20520);
        } finally {
            queryMock.mock.restore();
        }
    });
});
