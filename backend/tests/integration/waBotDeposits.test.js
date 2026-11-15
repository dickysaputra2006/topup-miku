const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, createServerHarness } = require('../helpers/appFactory');

describe('Phase 7A: WA Bot Admin Deposit Read-Only API', () => {
    const harness = createServerHarness();
    let baseUrl;
    const VALID_BOT_TOKEN = 'test-wa-bot-token-phase7a-secure-xyz';

    before(() => {
        process.env.WA_BOT_ADMIN_TOKEN = VALID_BOT_TOKEN;
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        delete process.env.WA_BOT_ADMIN_TOKEN;
        await harness.stop();
    });

    // ── Helper: mock query for deposit list ───────────────────
    function mockDepositQuery(rows) {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM deposits d')) {
                return { rows };
            }
            return { rows: [] };
        });
    }

    const sampleDeposit = {
        id:          42,
        username:    'buyer99',
        amount:      '50500',
        unique_code: 500,
        method:      'GoPay',
        note:        null,
        status:      'Pending',
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString()
    };

    // ── TEST 1: tanpa token → 401 ─────────────────────────────
    test('GET /api/bot/admin/deposits/pending — tanpa token ditolak 401', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`);
        assert.strictEqual(res.status, 401, 'No token must return 401');
        // Auth rejected before any DB call — no mock to restore
    });

    // ── TEST 2: token salah → 403 ─────────────────────────────
    test('GET /api/bot/admin/deposits/pending — token salah ditolak 403', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': 'Bearer wrong-token-xyz' }
        });
        assert.strictEqual(res.status, 403, 'Wrong token must return 403');
    });

    // ── TEST 3: env token kosong → 503 ───────────────────────
    test('GET /api/bot/admin/deposits/pending — env kosong → 503 aman', async () => {
        // Temporarily hide the env token
        const savedToken = process.env.WA_BOT_ADMIN_TOKEN;
        delete process.env.WA_BOT_ADMIN_TOKEN;

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${savedToken}` }
        });
        assert.strictEqual(res.status, 503, 'Unconfigured env must return 503');
        const data = await res.json();
        assert.ok(data.message.includes('dikonfigurasi'), 'Message should mention configuration');

        process.env.WA_BOT_ADMIN_TOKEN = savedToken;
    });

    // ── TEST 4: token benar → list pending sukses ─────────────
    test('GET /api/bot/admin/deposits/pending — token benar → 200 dengan daftar deposit', async () => {
        mockDepositQuery([sampleDeposit]);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 200, 'Valid token must return 200');
        const data = await res.json();
        assert.ok(Array.isArray(data.deposits), 'Response must have deposits array');
        assert.ok(data.deposits.length > 0, 'Should have deposits');
        assert.ok('count'        in data, 'Response must have count');
        assert.ok('generated_at' in data, 'Response must have generated_at');

        pool.query.mock.restore();
    });

    // ── TEST 5: hanya status Pending dikembalikan ─────────────
    test('GET /api/bot/admin/deposits/pending — SQL harus filter status Pending', async () => {
        let capturedSql = '';
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') capturedSql = sql;
            return { rows: [] };
        });

        await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });

        assert.ok(capturedSql.includes("status = 'Pending'"), "SQL must filter by status = 'Pending'");
        assert.ok(!capturedSql.includes("'Approved'"), 'SQL must not include Approved');
        assert.ok(!capturedSql.includes("'Rejected'"), 'SQL must not include Rejected');
        pool.query.mock.restore();
    });

    // ── TEST 6: limit max dibatasi 50 ────────────────────────
    test('GET /api/bot/admin/deposits/pending?limit=999 — limit capped at 50', async () => {
        mockDepositQuery([]);
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending?limit=999`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 200, 'Oversized limit must not error');
        const data = await res.json();
        assert.ok(Array.isArray(data.deposits), 'Must return deposits array');
        pool.query.mock.restore();
    });

    // ── TEST 7: tidak expose password/email/nomor_wa ──────────
    test('GET /api/bot/admin/deposits/pending — tidak expose field sensitif', async () => {
        mockDepositQuery([sampleDeposit]);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        const data = await res.json();
        const raw = JSON.stringify(data);

        assert.ok(!raw.includes('"password"'), 'password must not be exposed');
        assert.ok(!raw.includes('"email"'),    'email must not be exposed');
        assert.ok(!raw.includes('"nomor_wa"'), 'nomor_wa must not be exposed');
        assert.ok(!raw.includes('"user_id"'),  'user_id must not be exposed');
        assert.ok(!raw.includes('"api_key"'),  'api_key must not be exposed');

        pool.query.mock.restore();
    });

    // ── TEST 8: detail deposit dengan token benar → 200 ───────
    test('GET /api/bot/admin/deposits/:id — token benar → 200 detail deposit', async () => {
        mockDepositQuery([sampleDeposit]);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 200, 'Valid token + valid id must return 200');
        const data = await res.json();

        // Cek field yang diharapkan ada
        assert.ok('id'           in data, 'id must be present');
        assert.ok('username'     in data, 'username must be present');
        assert.ok('amount'       in data, 'amount must be present');
        assert.ok('method'       in data, 'method must be present');
        assert.ok('status'       in data, 'status must be present');
        assert.ok('summary_text' in data, 'summary_text must be present for WA bot');

        // summary_text harus mengandung info berguna, bukan data sensitif
        assert.ok(data.summary_text.includes('Deposit'), 'summary_text must mention Deposit');
        assert.ok(!data.summary_text.includes('@'), 'summary_text must not contain email');

        pool.query.mock.restore();
    });

    // ── TEST 9: detail deposit tidak ditemukan → 404 ──────────
    test('GET /api/bot/admin/deposits/:id — tidak ditemukan → 404', async () => {
        mockDepositQuery([]); // empty = not found

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/9999`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });
        assert.strictEqual(res.status, 404, 'Missing deposit must return 404');
        const data = await res.json();
        assert.ok(data.message, 'Must return a message');

        pool.query.mock.restore();
    });

    // ── TEST 10: endpoint read-only — tidak ada UPDATE/INSERT ──
    test('GET /api/bot/admin/deposits/pending — tidak ada UPDATE/INSERT di DB (read-only)', async () => {
        const executedStatements = [];
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') executedStatements.push(sql.trim().toUpperCase().slice(0, 6));
            return { rows: [] };
        });

        await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });

        // Hanya SELECT yang boleh dieksekusi
        assert.ok(!executedStatements.includes('UPDATE'), 'Must not execute UPDATE');
        assert.ok(!executedStatements.includes('INSERT'), 'Must not execute INSERT');
        assert.ok(!executedStatements.includes('DELETE'), 'Must not execute DELETE');

        pool.query.mock.restore();
    });
});

describe('Phase 7B: WA Bot Admin Deposit Approve/Reject API', () => {
    const harness = createServerHarness();
    let baseUrl;
    const VALID_BOT_TOKEN = 'test-wa-bot-token-phase7b-secure-xyz';

    before(() => {
        process.env.WA_BOT_ADMIN_TOKEN = VALID_BOT_TOKEN;
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        delete process.env.WA_BOT_ADMIN_TOKEN;
        await harness.stop();
    });

    // ── Helper: sample deposit row ────────────────────────────
    const sampleDeposit = {
        id:          42,
        user_id:     5,
        username:    'buyer99',
        amount:      '50500',
        unique_code: 500,
        method:      'GoPay',
        note:        null,
        status:      'Pending',
        created_at:  new Date().toISOString()
    };

    // ── Helper: create fakeClient for transactional endpoints ─
    function makeFakeClient(depositRow, opts = {}) {
        const tracked = {
            balanceUpdateCount: 0,
            balanceHistoryInsertCount: 0,
            statusSetTo: null,
            committed: false
        };

        const fakeClient = {
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
                if (sql === 'COMMIT') { tracked.committed = true; return {}; }
                // SELECT deposit FOR UPDATE
                if (typeof sql === 'string' && sql.includes('FROM deposits d') && sql.includes('FOR UPDATE')) {
                    return { rows: depositRow ? [depositRow] : [] };
                }
                // balance_history existence check
                if (typeof sql === 'string' && sql.includes('FROM balance_history') && sql.includes('reference_id')) {
                    const existingRows = opts.balanceHistoryExists ? [{ id: 999 }] : [];
                    return { rows: existingRows };
                }
                // UPDATE deposits SET status
                if (typeof sql === 'string' && sql.includes("UPDATE deposits SET status")) {
                    if (sql.includes("'Approved'")) tracked.statusSetTo = 'Approved';
                    if (sql.includes("'Rejected'")) tracked.statusSetTo = 'Rejected';
                    return {};
                }
                // UPDATE users SET balance
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    tracked.balanceUpdateCount++;
                    return {};
                }
                // INSERT INTO balance_history
                if (typeof sql === 'string' && sql.includes('INSERT INTO balance_history')) {
                    tracked.balanceHistoryInsertCount++;
                    return {};
                }
                return { rows: [] };
            },
            release: () => {}
        };

        return { fakeClient, tracked };
    }

    // ════════════════════════════════════════════════════════════
    // AUTH TESTS
    // ════════════════════════════════════════════════════════════

    // ── TEST 1: Approve tanpa token → 401 ─────────────────────
    test('POST /api/bot/admin/deposits/42/approve — tanpa token ditolak 401', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 401, 'No token must return 401');
    });

    // ── TEST 2: Approve token salah → 403 ─────────────────────
    test('POST /api/bot/admin/deposits/42/approve — token salah ditolak 403', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer wrong-token-xyz', 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 403, 'Wrong token must return 403');
    });

    // ── TEST 3: Reject tanpa token → 401 ──────────────────────
    test('POST /api/bot/admin/deposits/42/reject — tanpa token ditolak 401', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 401, 'No token must return 401');
    });

    // ── TEST 4: Reject token salah → 403 ──────────────────────
    test('POST /api/bot/admin/deposits/42/reject — token salah ditolak 403', async () => {
        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer wrong-token-xyz', 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.strictEqual(res.status, 403, 'Wrong token must return 403');
    });

    // ════════════════════════════════════════════════════════════
    // APPROVE TESTS
    // ════════════════════════════════════════════════════════════

    // ── TEST 5: Approve deposit Pending sukses ────────────────
    test('POST /api/bot/admin/deposits/:id/approve — Pending berhasil di-approve', async () => {
        const { fakeClient, tracked } = makeFakeClient(sampleDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'test approve' })
        });

        assert.strictEqual(res.status, 200, 'Must return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true, 'success must be true');
        assert.ok(data.message.includes('approve'), 'message must mention approve');
        assert.ok(data.summary_text.includes('✅'), 'summary_text must include check emoji');
        assert.ok(data.deposit, 'Must have deposit object');
        assert.strictEqual(data.deposit.id, 42, 'deposit.id must match');
        assert.strictEqual(data.deposit.username, 'buyer99', 'deposit.username must match');
        assert.strictEqual(data.deposit.status, 'Approved', 'deposit.status must be Approved');

        // Verify no sensitive fields
        const raw = JSON.stringify(data);
        assert.ok(!raw.includes('"user_id"'), 'user_id must not be exposed');
        assert.ok(!raw.includes('"email"'), 'email must not be exposed');
        assert.ok(!raw.includes('"password"'), 'password must not be exposed');
        assert.ok(!raw.includes('"nomor_wa"'), 'nomor_wa must not be exposed');
        assert.ok(!raw.includes('"api_key"'), 'api_key must not be exposed');

        // Verify DB operations
        assert.strictEqual(tracked.statusSetTo, 'Approved', 'Status must be set to Approved');
        assert.strictEqual(tracked.balanceUpdateCount, 1, 'Balance must be updated exactly once');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 1, 'balance_history must be inserted exactly once');
        assert.strictEqual(tracked.committed, true, 'Transaction must be committed');

        pool.connect.mock.restore();
    });

    // ── TEST 6: Approve deposit tidak ditemukan → 404 ─────────
    test('POST /api/bot/admin/deposits/:id/approve — tidak ditemukan → 404', async () => {
        const { fakeClient } = makeFakeClient(null); // empty row
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/9999/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 404, 'Missing deposit must return 404');
        const data = await res.json();
        assert.strictEqual(data.success, false);

        pool.connect.mock.restore();
    });

    // ── TEST 7: Approve deposit non-Pending (Approved) → 409 ──
    test('POST /api/bot/admin/deposits/:id/approve — non-Pending → 409', async () => {
        const approvedDeposit = { ...sampleDeposit, status: 'Approved' };
        const { fakeClient, tracked } = makeFakeClient(approvedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Non-Pending must return 409');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Message must indicate already processed');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'balance_history must NOT be inserted');

        pool.connect.mock.restore();
    });

    // ── TEST 8: Double approve — saldo tidak double ───────────
    test('POST /api/bot/admin/deposits/:id/approve — double approve 409, saldo tidak double', async () => {
        const approvedDeposit = { ...sampleDeposit, status: 'Approved' };
        const { fakeClient, tracked } = makeFakeClient(approvedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Double approve must return 409');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated on double approve');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'CRITICAL: balance_history must NOT be inserted on double approve');

        pool.connect.mock.restore();
    });

    // ── TEST 9: Approve Pending tapi balance_history sudah ada → 409 ──
    test('POST /api/bot/admin/deposits/:id/approve — balance_history reference sudah ada → 409, saldo tidak bertambah', async () => {
        // Deposit masih Pending di DB, tapi balance_history DEPOSIT-42 sudah ada (anomali / inkonsistensi)
        const { fakeClient, tracked } = makeFakeClient(sampleDeposit, { balanceHistoryExists: true });
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Existing balance_history must return 409');
        const data = await res.json();
        assert.strictEqual(data.success, false);
        assert.ok(data.message.includes('sudah pernah dikreditkan'), 'Message must mention already credited');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT be updated when history already exists');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'CRITICAL: balance_history must NOT be inserted again');
        assert.strictEqual(tracked.committed, false, 'Transaction must NOT be committed (ROLLBACK)');

        pool.connect.mock.restore();
    });

    // ════════════════════════════════════════════════════════════
    // REJECT TESTS
    // ════════════════════════════════════════════════════════════

    // ── TEST 10: Reject deposit Pending sukses ────────────────
    test('POST /api/bot/admin/deposits/:id/reject — Pending berhasil ditolak', async () => {
        const { fakeClient, tracked } = makeFakeClient(sampleDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'bukti tidak valid' })
        });

        assert.strictEqual(res.status, 200, 'Must return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true, 'success must be true');
        assert.ok(data.message.includes('ditolak'), 'message must mention rejection');
        assert.ok(data.summary_text.includes('❌'), 'summary_text must include cross emoji');
        assert.strictEqual(data.deposit.status, 'Rejected', 'deposit.status must be Rejected');

        // Verify no sensitive fields
        const raw = JSON.stringify(data);
        assert.ok(!raw.includes('"user_id"'), 'user_id must not be exposed');
        assert.ok(!raw.includes('"email"'), 'email must not be exposed');
        assert.ok(!raw.includes('"password"'), 'password must not be exposed');

        // Verify NO balance/history operations
        assert.strictEqual(tracked.statusSetTo, 'Rejected', 'Status must be set to Rejected');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'Balance must NOT be updated on reject');
        assert.strictEqual(tracked.balanceHistoryInsertCount, 0, 'balance_history must NOT be inserted on reject');
        assert.strictEqual(tracked.committed, true, 'Transaction must be committed');

        pool.connect.mock.restore();
    });

    // ── TEST 11: Reject deposit tidak ditemukan → 404 ─────────
    test('POST /api/bot/admin/deposits/:id/reject — tidak ditemukan → 404', async () => {
        const { fakeClient } = makeFakeClient(null);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/9999/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 404, 'Missing deposit must return 404');

        pool.connect.mock.restore();
    });

    // ── TEST 12: Reject deposit non-Pending → 409 ─────────────
    test('POST /api/bot/admin/deposits/:id/reject — non-Pending → 409', async () => {
        const rejectedDeposit = { ...sampleDeposit, status: 'Rejected' };
        const { fakeClient, tracked } = makeFakeClient(rejectedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Non-Pending must return 409');
        const data = await res.json();
        assert.ok(data.message.includes('sudah diproses'), 'Message must indicate already processed');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'Balance must NOT be updated');

        pool.connect.mock.restore();
    });

    // ── TEST 13: Double reject tidak mengubah saldo ───────────
    test('POST /api/bot/admin/deposits/:id/reject — double reject 409, saldo tidak berubah', async () => {
        const rejectedDeposit = { ...sampleDeposit, status: 'Rejected' };
        const { fakeClient, tracked } = makeFakeClient(rejectedDeposit);
        mock.method(pool, 'connect', async () => fakeClient);

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/42/reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        assert.strictEqual(res.status, 409, 'Double reject must return 409');
        assert.strictEqual(tracked.balanceUpdateCount, 0, 'CRITICAL: balance must NOT change on double reject');

        pool.connect.mock.restore();
    });

    // ════════════════════════════════════════════════════════════
    // REGRESSION: Phase 7A read-only still works
    // ════════════════════════════════════════════════════════════

    // ── TEST 14: Phase 7A GET pending masih normal ────────────
    test('GET /api/bot/admin/deposits/pending — Phase 7A regression: masih 200 dengan array', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('FROM deposits d')) {
                return { rows: [] };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/bot/admin/deposits/pending`, {
            headers: { 'Authorization': `Bearer ${VALID_BOT_TOKEN}` }
        });

        assert.strictEqual(res.status, 200, 'Phase 7A pending list must still return 200');
        const data = await res.json();
        assert.ok(Array.isArray(data.deposits), 'Must return deposits array');
        assert.ok('count' in data, 'Must have count field');

        pool.query.mock.restore();
    });
});
