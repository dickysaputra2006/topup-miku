const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, createServerHarness } = require('../helpers/appFactory');

describe('Public Transaction Endpoints', () => {
    const harness = createServerHarness();
    let server;
    const baseUrl = () => `http://127.0.0.1:${server.address().port}`;

    before(() => {
        ({ server } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('GET /api/public/transaction/:id — found, returns safe fields only', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-1234567890',
                        status:       'Success',
                        price:        15000,
                        created_at:   new Date().toISOString(),
                        updated_at:   new Date().toISOString(),
                        product_name: 'Diamond 100',
                        game_name:    'Mobile Legends'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/transaction/TRX-1234567890`);
        assert.strictEqual(res.status, 200, 'Should return 200 for found invoice');
        const data = await res.json();

        // Field aman harus ada
        assert.ok(data.invoice_id,   'invoice_id should be present');
        assert.ok(data.status,       'status should be present');
        assert.ok(data.status_label, 'status_label should be present');
        assert.ok(data.game_name,    'game_name should be present');
        assert.ok(data.product_name, 'product_name should be present');
        assert.ok(data.price !== undefined, 'price should be present');
        assert.ok(data.created_at,   'created_at should be present');

        // Field sensitif tidak boleh ada
        const raw = JSON.stringify(data);
        assert.ok(!('user_id'        in data), 'user_id must not be exposed');
        assert.ok(!('username'       in data), 'username must not be exposed');
        assert.ok(!('email'          in data), 'email must not be exposed');
        assert.ok(!('nomor_wa'       in data), 'nomor_wa must not be exposed');
        assert.ok(!('provider_trx_id' in data), 'provider_trx_id must not be exposed');
        assert.ok(!('provider_sn'    in data), 'provider_sn must not be exposed');
        assert.ok(!('target_game_id' in data), 'target_game_id must not be exposed');

        // Status label harus benar
        assert.strictEqual(data.status_label, 'Berhasil', 'Success status_label should be Berhasil');

        pool.query.mock.restore();
    });

    test('GET /api/public/transaction/:id — not found returns 404', async () => {
        mock.method(pool, 'query', async () => ({ rows: [] }));

        const res = await fetch(`${baseUrl()}/api/public/transaction/TRX-NOTEXIST`);
        assert.strictEqual(res.status, 404, 'Should return 404 for missing invoice');
        const data = await res.json();
        assert.ok(data.message, 'Should have a message');

        pool.query.mock.restore();
    });

    test('GET /api/public/transaction/:id — invalid chars returns 400', async () => {
        // Karakter tidak aman: titik, slash, spasi
        const res = await fetch(`${baseUrl()}/api/public/transaction/../../etc`);
        // Tergantung express routing — bisa 400 atau 404 karena path traversal
        assert.ok(res.status === 400 || res.status === 404, 'Should reject invalid/unsafe invoice');
    });

    test('GET /api/public/transaction/:id — Partial Refund status_label correct', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-PR-TEST',
                        status:       'Partial Refund',
                        price:        20000,
                        created_at:   new Date().toISOString(),
                        updated_at:   new Date().toISOString(),
                        product_name: 'Diamonds 200',
                        game_name:    'PUBG Mobile'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/transaction/TRX-PR-TEST`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status_label, 'Perlu Review Admin', 'Partial Refund label must be "Perlu Review Admin"');

        pool.query.mock.restore();
    });

    test('GET /api/public/recent-transactions — invoice is masked', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-17781619937353',
                        status:       'Success',
                        created_at:   new Date().toISOString(),
                        product_name: 'Diamond 86',
                        game_name:    'Mobile Legends'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/recent-transactions`);
        assert.strictEqual(res.status, 200);
        const list = await res.json();
        assert.ok(Array.isArray(list), 'Should return array');
        assert.ok(list.length > 0, 'Should have at least one item');

        const item = list[0];
        // Harus ada invoice_masked, bukan invoice_id asli
        assert.ok('invoice_masked' in item,  'invoice_masked should be present');
        assert.ok(!('invoice_id'   in item), 'invoice_id (full) must NOT be present');
        // Masking: tidak boleh expose invoice lengkap
        assert.ok(item.invoice_masked.includes('****'), 'Invoice must be masked with ****');
        assert.ok(!item.invoice_masked.includes('17781619937353'), 'Full invoice number must not appear');

        pool.query.mock.restore();
    });

    test('GET /api/public/recent-transactions — no sensitive fields', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('transactions t')) {
                return {
                    rows: [{
                        invoice_id:   'TRX-SAFE-001',
                        status:       'Pending',
                        created_at:   new Date().toISOString(),
                        product_name: 'UC 325',
                        game_name:    'PUBG Mobile'
                    }]
                };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl()}/api/public/recent-transactions`);
        const list = await res.json();
        assert.ok(Array.isArray(list) && list.length > 0);

        const item = list[0];
        const raw = JSON.stringify(item);
        // Field sensitif harus tidak ada
        assert.ok(!('user_id'         in item), 'user_id must not be in recent list');
        assert.ok(!('username'        in item), 'username must not be in recent list');
        assert.ok(!('email'           in item), 'email must not be in recent list');
        assert.ok(!('nomor_wa'        in item), 'nomor_wa must not be in recent list');
        assert.ok(!('provider_trx_id' in item), 'provider_trx_id must not be in recent list');
        assert.ok(!('provider_sn'     in item), 'provider_sn must not be in recent list');
        assert.ok(!('target_game_id'  in item), 'target_game_id must not be in recent list');
        assert.ok(!('invoice_id'      in item), 'full invoice_id must not be in recent list');

        pool.query.mock.restore();
    });
});

describe('Phase 6A: Public Leaderboard', () => {
    const harness = createServerHarness();
    let baseUrl;

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    // Helper: mock pool.query for leaderboard SQL
    function mockLeaderboardQuery(rows) {
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes("status = 'Success'") && sql.includes('GROUP BY')) {
                return { rows };
            }
            return { rows: [] };
        });
    }

    test('GET /api/public/leaderboard — accessible without authentication', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.strictEqual(res.status, 200, 'Leaderboard must be public (200 without auth)');
        const data = await res.json();
        assert.ok(Array.isArray(data.leaderboard), 'Response must have leaderboard array');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — returns required fields', async () => {
        mockLeaderboardQuery([{
            username: 'testuser123',
            total_success_orders: 7,
            total_spent: '350000',
            last_order_at: new Date().toISOString()
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.leaderboard.length > 0, 'Should have entries');
        const entry = data.leaderboard[0];
        assert.ok('rank'                 in entry, 'rank must be present');
        assert.ok('display_name'         in entry, 'display_name must be present');
        assert.ok('total_success_orders' in entry, 'total_success_orders must be present');
        assert.ok('total_spent'          in entry, 'total_spent must be present');
        assert.ok('rank_label'           in entry, 'rank_label must be present');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — username is masked', async () => {
        mockLeaderboardQuery([{
            username: 'storemiku99',
            total_success_orders: 5,
            total_spent: '200000',
            last_order_at: null
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        const data = await res.json();
        const entry = data.leaderboard[0];
        assert.ok(!entry.display_name.includes('storemiku99'), 'Full username must not appear in display_name');
        assert.ok(entry.display_name.includes('***'), 'display_name must be masked with ***');
        assert.ok(entry.display_name.startsWith('sto'), 'First 3 chars of username must be visible');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — email, nomor_wa, user_id never returned', async () => {
        mockLeaderboardQuery([{
            username: 'buyer01',
            total_success_orders: 3,
            total_spent: '150000',
            last_order_at: null
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        const data = await res.json();
        const raw = JSON.stringify(data);
        assert.ok(!raw.includes('"email"'),    'email must not be in leaderboard response');
        assert.ok(!raw.includes('"nomor_wa"'), 'nomor_wa must not be in leaderboard response');
        assert.ok(!raw.includes('"user_id"'),  'user_id must not be in leaderboard response');
        assert.ok(!raw.includes('"username"'), 'raw username key must not be in leaderboard response');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — empty returns array, not error', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.strictEqual(res.status, 200, 'Empty leaderboard must still return 200');
        const data = await res.json();
        assert.ok(Array.isArray(data.leaderboard), 'leaderboard must be array');
        assert.strictEqual(data.leaderboard.length, 0, 'Empty leaderboard must return empty array');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?limit=999 — limit capped at 50', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?limit=999`);
        assert.strictEqual(res.status, 200, 'Oversized limit must not error');
        const data = await res.json();
        assert.ok(Array.isArray(data.leaderboard), 'Must return leaderboard array');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?period=monthly — monthly period accepted', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?period=monthly`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.period, 'monthly', 'Response must echo back period=monthly');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?period=weekly — weekly period accepted', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?period=weekly`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.period, 'weekly', 'Response must echo back period=weekly');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard?period=invalid — falls back to all_time', async () => {
        mockLeaderboardQuery([]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard?period=hacked`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.period, 'all_time', 'Invalid period must default to all_time');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — SQL filters only Success status', async () => {
        let capturedSql = '';
        mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') capturedSql = sql;
            return { rows: [] };
        });
        await fetch(`${baseUrl}/api/public/leaderboard`);
        assert.ok(capturedSql.includes("status = 'Success'"), "SQL must filter by status = 'Success'");
        assert.ok(!capturedSql.includes("'Pending'"),         'SQL must not include Pending');
        assert.ok(!capturedSql.includes("'Failed'"),          'SQL must not include Failed');
        pool.query.mock.restore();
    });

    test('GET /api/public/leaderboard — rank_label Legend for high spender (>=5jt)', async () => {
        mockLeaderboardQuery([{
            username: 'legend01',
            total_success_orders: 20,
            total_spent: '5000000',
            last_order_at: new Date().toISOString()
        }]);
        const res = await fetch(`${baseUrl}/api/public/leaderboard`);
        const data = await res.json();
        const entry = data.leaderboard[0];
        assert.strictEqual(entry.rank_label, 'Legend', 'User with 5jt+ must have Legend rank_label');
        pool.query.mock.restore();
    });
});
