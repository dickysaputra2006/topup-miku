const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

function createInMemoryUserOpsDb(initialUsers, initialRoles) {
    const users = new Map(initialUsers.map((u) => [u.id, { ...u }]));
    const roles = new Map(initialRoles.map((r) => [r.id, { ...r }]));
    const history = [];
    const auditLogs = [];
    const notifications = [];

    const findUser = (identifier) => {
        const key = String(identifier || '').trim().toLowerCase();
        for (const u of users.values()) {
            if (u.username.toLowerCase() === key || (u.email && u.email.toLowerCase() === key)) {
                return u;
            }
        }
        return null;
    };

    const runQuery = async (sql, params = []) => {
        if (typeof sql !== 'string') return { rows: [] };
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
        if (sql.includes('SELECT token_version FROM users WHERE id = $1')) {
            const u = users.get(params[0]);
            return u ? { rows: [{ token_version: u.token_version ?? 1 }] } : { rows: [] };
        }
        if (sql.includes('SELECT r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1')) {
            const u = users.get(params[0]);
            const r = u ? roles.get(u.role_id) : null;
            return r ? { rows: [{ role_name: r.name }] } : { rows: [] };
        }
        if (sql.includes('FROM users u') && sql.includes('JOIN roles r ON u.role_id = r.id') && sql.includes('LOWER(u.username) = LOWER($1)')) {
            const u = findUser(params[0]);
            if (!u) return { rows: [] };
            const r = roles.get(u.role_id);
            return {
                rows: [{
                    id: u.id, username: u.username, email: u.email, full_name: u.full_name,
                    balance: u.balance, role_id: u.role_id, role_name: r ? r.name : 'BRONZE',
                }],
            };
        }
        if (sql.includes('SELECT id, username, email, balance FROM users WHERE LOWER(username) = LOWER($1)')) {
            const u = findUser(params[0]);
            return u ? { rows: [{ id: u.id, username: u.username, email: u.email, balance: u.balance }] } : { rows: [] };
        }
        if (sql.includes('SELECT id, name FROM roles WHERE UPPER(name) = $1')) {
            const target = String(params[0] || '').toUpperCase();
            for (const r of roles.values()) {
                if (r.name.toUpperCase() === target) return { rows: [{ id: r.id, name: r.name }] };
            }
            return { rows: [] };
        }
        if (sql.includes('UPDATE users SET balance = balance + $1 WHERE id = $2')) {
            const u = users.get(params[1]);
            if (!u) return { rowCount: 0 };
            u.balance += Number(params[0]);
            return { rowCount: 1 };
        }
        if (sql.includes('UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1')) {
            const u = users.get(params[1]);
            if (!u || u.balance < Number(params[0])) return { rowCount: 0 };
            u.balance -= Number(params[0]);
            return { rowCount: 1 };
        }
        if (sql.includes('UPDATE users SET role_id = $1, token_version = COALESCE(token_version, 1) + 1')) {
            const u = users.get(params[1]);
            if (!u) return { rowCount: 0 };
            u.role_id = params[0];
            u.token_version = (u.token_version || 1) + 1;
            return { rowCount: 1 };
        }
        if (sql.includes('INSERT INTO balance_history')) {
            history.push({ user_id: params[0], amount: Number(params[1]), type: params[2], description: params[3], reference_id: params[4] });
            return { rowCount: 1 };
        }
        if (sql.includes('INSERT INTO admin_audit_logs')) {
            auditLogs.push({ action: params[1], target_type: params[2], target_id: params[3], after_data: params[5] });
            return { rowCount: 1 };
        }
        if (sql.includes('INSERT INTO notifications')) {
            notifications.push({ user_id: params[0], message: params[1] });
            return { rowCount: 1 };
        }
        return { rows: [] };
    };

    return {
        users, roles, history, auditLogs, notifications,
        poolQuery: (sql, params) => runQuery(sql, params),
        poolConnect: async () => ({ query: (sql, params) => runQuery(sql, params), release: () => {} }),
    };
}

describe('Admin Panel User Role Management & WA Bot Admin Balance/Role Endpoints', () => {
    const harness = createServerHarness();
    let baseUrl;
    const origBotToken = process.env.WA_BOT_ADMIN_TOKEN;
    const VALID_BOT_TOKEN = 'x'.repeat(40);

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        if (origBotToken === undefined) delete process.env.WA_BOT_ADMIN_TOKEN;
        else process.env.WA_BOT_ADMIN_TOKEN = origBotToken;
        await harness.stop();
    });

    test('Admin Panel GET /api/admin/users/lookup & PUT /api/admin/users/role (otorisasi, ubah role, blokir Admin)', async () => {
        const db = createInMemoryUserOpsDb([
            { id: 1, username: 'super_admin', email: 'admin@mikutopup.my.id', full_name: 'Admin', balance: 0, role_id: 2, token_version: 1 },
            { id: 2, username: 'reseller_satu', email: 'reseller1@example.com', full_name: 'Reseller Satu', balance: 25000, role_id: 5, token_version: 1 },
        ], [
            { id: 2, name: 'Admin' },
            { id: 3, name: 'GOLD' },
            { id: 4, name: 'SILVER' },
            { id: 5, name: 'BRONZE' },
            { id: 7, name: 'PARTNER' },
        ]);
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        const adminToken = fixtures.makeAdminToken(1, 'super_admin');
        const userToken = fixtures.makeUserToken(2, 'BRONZE', 'reseller_satu');

        try {
            // Non-admin & guest ditolak
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/lookup?q=reseller_satu`)).status, 401);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/lookup?q=reseller_satu`, { headers: { Authorization: `Bearer ${userToken}` } })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/role`, {
                method: 'PUT', headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: 'reseller_satu', role: 'PARTNER' }),
            })).status, 403);

            // Lookup via email (case-insensitive) -> data aman
            const lookRes = await fetch(`${baseUrl}/api/admin/users/lookup?q=RESELLER1@EXAMPLE.COM`, {
                headers: { Authorization: `Bearer ${adminToken}` },
            });
            assert.strictEqual(lookRes.status, 200);
            const lookBody = await lookRes.json();
            assert.strictEqual(lookBody.user.username, 'reseller_satu');
            assert.strictEqual(lookBody.user.role, 'BRONZE');
            assert.strictEqual('password' in lookBody.user, false);

            // Ubah role BRONZE -> PARTNER sukses, token_version naik, audit tercatat
            const updRes = await fetch(`${baseUrl}/api/admin/users/role`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: 'reseller_satu', role: 'partner' }),
            });
            assert.strictEqual(updRes.status, 200);
            const updBody = await updRes.json();
            assert.strictEqual(updBody.user.previous_role, 'BRONZE');
            assert.strictEqual(updBody.user.role, 'PARTNER');
            assert.strictEqual(db.users.get(2).role_id, 7);
            assert.strictEqual(db.users.get(2).token_version, 2);
            assert.strictEqual(db.auditLogs.some((a) => a.action === 'admin.user.role_update' && a.target_id === '2'), true);

            // Blokir promosi Admin/Owner & ubah akun Admin
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/role`, {
                method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: 'reseller_satu', role: 'Admin' }),
            })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/role`, {
                method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: 'super_admin', role: 'GOLD' }),
            })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/role`, {
                method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: 'reseller_satu', role: 'HACKER' }),
            })).status, 400);
            assert.strictEqual((await fetch(`${baseUrl}/api/admin/users/role`, {
                method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: 'tidak_ada', role: 'GOLD' }),
            })).status, 404);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
        }
    });

    test('WA Bot /api/bot/admin/balance/add, /reduce, & /users/role via username/email beserta guard keamanan', async () => {
        const db = createInMemoryUserOpsDb([
            { id: 10, username: 'bot_admin', email: 'botadm@mikutopup.my.id', full_name: 'Admin', balance: 0, role_id: 2, token_version: 1 },
            { id: 11, username: 'agen_miku', email: 'agen@mikutopup.my.id', full_name: 'Agen Miku', balance: 30000, role_id: 5, token_version: 1 },
        ], [
            { id: 2, name: 'Admin' },
            { id: 3, name: 'GOLD' },
            { id: 4, name: 'SILVER' },
            { id: 5, name: 'BRONZE' },
            { id: 7, name: 'PARTNER' },
        ]);
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // Env belum diset -> 503
            delete process.env.WA_BOT_ADMIN_TOKEN;
            assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/balance/add`, {
                method: 'POST', headers: { Authorization: `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'agen_miku', amount: 10000 }),
            })).status, 503);

            process.env.WA_BOT_ADMIN_TOKEN = VALID_BOT_TOKEN;
            assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/balance/reduce`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'agen_miku', amount: 10000 }),
            })).status, 401);
            assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/users/role`, {
                method: 'POST', headers: { Authorization: 'Bearer salah-token', 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'agen_miku', role: 'GOLD' }),
            })).status, 403);

            const botHeaders = { Authorization: `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' };

            // Add saldo via username
            const addRes = await fetch(`${baseUrl}/api/bot/admin/balance/add`, {
                method: 'POST', headers: botHeaders,
                body: JSON.stringify({ username: 'agen_miku', amount: 50000, description: 'Topup manual WA' }),
            });
            assert.strictEqual(addRes.status, 200);
            const addBody = await addRes.json();
            assert.strictEqual(addBody.success, true);
            assert.strictEqual(addBody.user.balance_after, 80000);
            assert.ok(addBody.summary_text.includes('Rp 50.000') && addBody.summary_text.includes('Rp 80.000'));
            assert.strictEqual(db.users.get(11).balance, 80000);

            // Reduce saldo via email
            const redRes = await fetch(`${baseUrl}/api/bot/admin/balance/reduce`, {
                method: 'POST', headers: botHeaders,
                body: JSON.stringify({ email: 'AGEN@MIKUTOPUP.MY.ID', amount: 20000, note: 'Koreksi salah transfer' }),
            });
            assert.strictEqual(redRes.status, 200);
            const redBody = await redRes.json();
            assert.strictEqual(redBody.user.balance_after, 60000);
            assert.strictEqual(db.users.get(11).balance, 60000);

            // Reduce lebih dari saldo -> 400; invalid amount -> 400
            assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/balance/reduce`, {
                method: 'POST', headers: botHeaders,
                body: JSON.stringify({ identifier: 'agen_miku', amount: 90000 }),
            })).status, 400);
            assert.strictEqual(db.users.get(11).balance, 60000);

            for (const badAmt of [-1000, 0, '1e5', 100.5, true]) {
                assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/balance/add`, {
                    method: 'POST', headers: botHeaders,
                    body: JSON.stringify({ username: 'agen_miku', amount: badAmt }),
                })).status, 400);
            }

            // Ubah role via email lewat bot
            const roleRes = await fetch(`${baseUrl}/api/bot/admin/users/role`, {
                method: 'POST', headers: botHeaders,
                body: JSON.stringify({ email: 'agen@mikutopup.my.id', role: 'GOLD' }),
            });
            assert.strictEqual(roleRes.status, 200);
            const roleBody = await roleRes.json();
            assert.strictEqual(roleBody.user.previous_role, 'BRONZE');
            assert.strictEqual(roleBody.user.role, 'GOLD');
            assert.strictEqual(db.users.get(11).role_id, 3);
            assert.strictEqual(db.users.get(11).token_version, 2);
            assert.ok(roleBody.summary_text.includes('GOLD'));

            // Blokir promosi Admin / ubah akun Admin lewat bot
            assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/users/role`, {
                method: 'POST', headers: botHeaders,
                body: JSON.stringify({ username: 'agen_miku', role: 'Admin' }),
            })).status, 403);
            assert.strictEqual((await fetch(`${baseUrl}/api/bot/admin/users/role`, {
                method: 'POST', headers: botHeaders,
                body: JSON.stringify({ username: 'bot_admin', role: 'PARTNER' }),
            })).status, 403);
            assert.strictEqual(db.auditLogs.some((a) => a.action === 'wabot.balance.add'), true);
            assert.strictEqual(db.auditLogs.some((a) => a.action === 'wabot.balance.reduce'), true);
            assert.strictEqual(db.auditLogs.some((a) => a.action === 'wabot.user.role_update'), true);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
        }
    });
});
