const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');

describe('Phase 5C-2A: Mobapay MLBB Eligibility Engine', () => {
    const harness = createServerHarness();
    let baseUrl;

    function makeAdminToken() {
        return fixtures.makeAdminToken(1, 'admin');
    }
    function makeUserToken() {
        return fixtures.makeUserToken(99, 'BRONZE', 'user');
    }

    before(() => {
        ({ baseUrl } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    // ---- ADMIN SANITIZER: Mobapay config validation ----

    test('PUT /api/admin/products/bulk-validation — checks invalid untuk mobapay ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    checks: ['invalid_check_xyz']
                }
            })
        });

        assert.strictEqual(res.status, 400, 'Invalid check must return 400');
        const data = await res.json();
        assert.ok(data.message.includes('invalid_check_xyz'), 'Error must mention invalid check');
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — double_diamond tanpa target ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    checks: ['double_diamond']
                    // rules.target missing
                }
            })
        });

        assert.strictEqual(res.status, 400, 'double_diamond without target must return 400');
        const data = await res.json();
        assert.ok(data.message.toLowerCase().includes('target'), 'Error must mention target');
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — double_diamond target tidak valid ditolak 400', async () => {
        const token = makeAdminToken();
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    checks: ['double_diamond'],
                    rules: { target: '999+999' }
                }
            })
        });

        assert.strictEqual(res.status, 400, 'Invalid DD target must return 400');
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — config mobapay WDP valid berhasil 200', async () => {
        const token = makeAdminToken();
        let savedConfig = null;
        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                return { rowCount: 2 };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [1, 2],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    country: 'ID',
                    checks: ['wdp_available']
                }
            })
        });

        assert.strictEqual(res.status, 200, 'Valid Mobapay WDP config must return 200');
        assert.ok(savedConfig !== null, 'Config must be saved');
        assert.strictEqual(savedConfig.validator, 'mobapay-mlbb-eligibility');
        assert.deepStrictEqual(savedConfig.checks, ['wdp_available']);
        pool.query.mock.restore();
    });

    test('PUT /api/admin/products/bulk-validation — config mobapay DD 50+50 valid berhasil 200', async () => {
        const token = makeAdminToken();
        let savedConfig = null;
        mock.method(pool, 'query', async (sql, params) => {
            if (sql.includes('SELECT r.name as role_name')) return { rows: [{ role_name: 'Admin' }] };
            if (sql.includes('UPDATE products SET validation_config')) {
                savedConfig = params[0];
                return { rowCount: 1 };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/admin/products/bulk-validation`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productIds: [5],
                validation_config: {
                    enabled: true,
                    validator: 'mobapay-mlbb-eligibility',
                    country: 'ID',
                    checks: ['double_diamond'],
                    rules: { target: '50+50' }
                }
            })
        });

        assert.strictEqual(res.status, 200, 'Valid DD 50+50 config must return 200');
        assert.ok(savedConfig !== null);
        assert.strictEqual(savedConfig.rules.target, '50+50');
        pool.query.mock.restore();
    });

    // ---- PRE-VALIDATE ENDPOINT: POST /api/products/:productId/validate ----

    // HOTFIX REGRESSION: Verifikasi query JOIN — tidak boleh query p.needs_server_id
    test('POST /api/products/:id/validate — HOTFIX: query harus JOIN ke games untuk needs_server_id', async () => {
        let capturedSql = null;
        mock.method(pool, 'query', async (sql) => {
            // Tangkap SQL yang digunakan oleh endpoint pre-validate
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                capturedSql = sql;
                // Simulasikan produk tanpa validation_config
                return { rows: [{ id: 999, name: 'Test', validation_config: null, game_id: 1, needs_server_id: false }] };
            }
            return { rows: [] };
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/999/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '609923809', zoneId: '8430' })
            });
            // Harus tidak 500 (root bug)
            assert.ok(res.status !== 500, `Must not return 500; got ${res.status}`);
            // Pastikan SQL yang dipakai mengandung JOIN ke games
            assert.ok(capturedSql !== null, 'Query harus dieksekusi');
            assert.ok(
                capturedSql.includes('LEFT JOIN games'),
                `Query harus mengandung LEFT JOIN games, tapi dapat: ${capturedSql}`
            );
            // Pastikan TIDAK query p.needs_server_id (kolom yang tidak ada di products)
            assert.ok(
                !capturedSql.includes('p.needs_server_id'),
                'Query tidak boleh mengakses p.needs_server_id (kolom ada di games, bukan products)'
            );
            // Pastikan pakai COALESCE dari games
            assert.ok(
                capturedSql.includes('COALESCE(g.needs_server_id'),
                'Query harus pakai COALESCE(g.needs_server_id) dari tabel games'
            );
        } finally {
            pool.query.mock.restore();
        }
    });

    // HOTFIX REGRESSION: Simulasi produk 217 (mobapay, no 500)
    test('POST /api/products/217/validate — HOTFIX: mobapay config tidak menghasilkan 500 karena needs_server_id', async () => {
        // Mock produk 217: validation_config mobapay aktif, needs_server_id berasal dari games JOIN
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 217,
                        name: 'Test Product 217',
                        validation_config: {
                            enabled: true,
                            validator: 'mobapay-mlbb-eligibility',
                            country: 'ID',
                            checks: ['double_diamond'],
                            rules: { target: '50+50' }
                        },
                        game_id: 1,
                        needs_server_id: false  // berasal dari COALESCE(g.needs_server_id, false)
                    }]
                };
            }
            return { rows: [] };
        });

        // Mock axios.get — simulasikan Mobapay merespons DD available
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            status: 200,
            data: {
                code: 0,
                data: {
                    user_info: { code: 0, user_name: 'TestUser' },
                    shop_info: {
                        good_list: [
                            { sku: 'com.moonton.diamond_mt_id_50', pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }] }
                        ],
                        shelf_location: [{
                            title: 'Double Diamonds on First Recharge',
                            goods: [
                                { title: '50+50', game_can_buy: true, goods_limit: { reached_limit: false } }
                            ]
                        }]
                    }
                }
            }
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/217/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '609923809', zoneId: '8430' })
            });
            // ROOT BUG: sebelum fix ini → 500. Setelah fix → tidak boleh 500
            assert.ok(
                res.status !== 500,
                `[HOTFIX REGRESSION] Produk 217 tidak boleh return 500. Status: ${res.status}`
            );
            const data = await res.json();
            assert.ok(
                data.success !== undefined,
                'Response harus punya field success'
            );
        } finally {
            axios.get = origGet;
            pool.query.mock.restore();
        }
    });

    test('POST /api/products/:id/validate — mobapay DD unavailable → 400 dengan pesan Promo Double Diamond', async () => {
        // Mock pool.query: kembalikan produk dengan validation_config mobapay DD
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 217,
                        name: 'Test Product DD',
                        validation_config: {
                            enabled: true,
                            validator: 'mobapay-mlbb-eligibility',
                            country: 'ID',
                            checks: ['double_diamond'],
                            rules: { target: '50+50' }
                        },
                        game_id: 1,
                        needs_server_id: true  // dari COALESCE(g.needs_server_id, false)
                    }]
                };
            }
            return { rows: [] };
        });

        // Mock axios.get untuk simulasi respons Mobapay: DD shelf ada tapi item 50+50 reached_limit
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            status: 200,
            data: {
                code: 0,
                data: {
                    user_info: { code: 0, user_name: 'TestUser' },
                    shop_info: {
                        good_list: [
                            { sku: 'com.moonton.diamond_mt_id_50', pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }] }
                        ],
                        shelf_location: [{
                            title: 'Double Diamonds on First Recharge',
                            goods: [
                                { title: '50+50', game_can_buy: true, goods_limit: { reached_limit: true } }
                            ]
                        }]
                    }
                }
            }
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/217/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '123456789', zoneId: '1234' })
            });
            assert.strictEqual(res.status, 400, 'DD unavailable must return 400');
            const data = await res.json();
            assert.strictEqual(data.success, false, 'success must be false');
            assert.ok(
                data.message.includes('Promo Double Diamond'),
                `Message must include "Promo Double Diamond", got: ${data.message}`
            );
        } finally {
            axios.get = origGet;
            pool.query.mock.restore();
        }
    });

    test('POST /api/products/:id/validate — mobapay WDP available → 200 success', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 218,
                        name: 'Test Product WDP',
                        validation_config: {
                            enabled: true,
                            validator: 'mobapay-mlbb-eligibility',
                            country: 'ID',
                            checks: ['wdp_available'],
                            rules: {}
                        },
                        game_id: 1,
                        needs_server_id: true
                    }]
                };
            }
            return { rows: [] };
        });

        // Mock axios.get: WDP SKU ada dan tersedia
        const axios = require('axios');
        const origGet = axios.get;
        axios.get = async () => ({
            status: 200,
            data: {
                code: 0,
                data: {
                    user_info: { code: 0, user_name: 'TestUser' },
                    shop_info: {
                        good_list: [
                            {
                                sku: 'com.moonton.diamond_mt_id_one_time_weekly_diamond',
                                game_can_buy: true,
                                pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }]
                            },
                            { sku: 'com.moonton.diamond_mt_id_50', pay_channel_sub: [{ active: 1, direct_channel: 'GoPay' }] }
                        ],
                        shelf_location: []
                    }
                }
            }
        });

        try {
            const res = await fetch(`${baseUrl}/api/products/218/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '123456789', zoneId: '1234' })
            });
            assert.strictEqual(res.status, 200, 'WDP available must return 200');
            const data = await res.json();
            assert.strictEqual(data.success, true, 'success must be true');
            assert.ok(
                data.message.includes('ID valid'),
                `Message must include "ID valid", got: ${data.message}`
            );
            assert.ok(data.data && data.data.mobapay === true, 'data.mobapay must be true');
        } finally {
            axios.get = origGet;
            pool.query.mock.restore();
        }
    });

    test('POST /api/products/:id/validate — validator PGS existing tidak rusak (tetap panggil validateGameId)', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return {
                    rows: [{
                        id: 100,
                        name: 'Test PGS Product',
                        validation_config: {
                            enabled: true,
                            validator: 'mobile-legends-region',
                            rules: {}
                        },
                        game_id: 1,
                        needs_server_id: true  // dari COALESCE(g.needs_server_id, false)
                    }]
                };
            }
            return { rows: [] };
        });

        // PGS validator: validateGameId akan dipanggil dan dikembalikan gagal
        // karena tidak ada real network — tangkap 400 atau 500 (server error)
        const res = await fetch(`${baseUrl}/api/products/100/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '123456', zoneId: '1234' })
        });
        // Response boleh 400 (ID invalid dari PGS) atau 500 (network error) — yang penting bukan 200 dari Mobapay path
        // Verifikasi: data.mobapay TIDAK ada (bukan Mobapay path)
        const data = await res.json();
        assert.ok(!data.data || data.data.mobapay === undefined, 'PGS path must not return data.mobapay');
        pool.query.mock.restore();
    });

    test('POST /api/products/:id/validate — produk tanpa validation_config → success "tidak memerlukan validasi"', async () => {
        mock.method(pool, 'query', async (sql) => {
            if (sql.includes('FROM products') && sql.includes('validation_config')) {
                return { rows: [{ id: 999, name: 'No Config Product', validation_config: null, game_id: 1, needs_server_id: false }] };
            }
            return { rows: [] };
        });

        const res = await fetch(`${baseUrl}/api/products/999/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '123456', zoneId: null })
        });
        assert.strictEqual(res.status, 200, 'No-config product must return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true, 'success must be true');
        assert.ok(
            data.message.includes('tidak memerlukan validasi'),
            `Message must include "tidak memerlukan validasi", got: ${data.message}`
        );
        pool.query.mock.restore();
    });
});
