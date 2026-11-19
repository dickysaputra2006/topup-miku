const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool, axios, cronPool, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const constants = require('../../config/constants');
const pendingTransactions = require('../../jobs/pendingTransactions');
const { syncProductsWithFoxy } = require('../../jobs/productSync');
const { calculateCatalogProducts } = require('../../services/priceService');

describe('QA Batch 1: Pricing Integrity & Provider Safety Guards', () => {
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

    function mockOrderClient({ balance = 100000, basePrice = 5000, marginPercent = 12, sku = 'SKU-B1-1', onRefund } = {}) {
        let balanceDeducted = false;
        let refunded = false;
        const connectMock = mock.method(pool, 'connect', async () => ({
            query: async (sql) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('JOIN games g')) {
                    return {
                        rows: [{
                            id: 51,
                            name: 'Diamonds Test',
                            provider_sku: sku,
                            price: basePrice,
                            status: 'Active',
                            game_id: 1,
                            needs_server_id: false,
                            validation_config: null,
                            use_manual_prices: false,
                            manual_prices: {},
                            use_custom_margin: false,
                        }],
                    };
                }
                if (typeof sql === 'string' && sql.includes('FROM users u JOIN roles r')) {
                    return { rows: [{ balance, role_id: 1, role_name: 'BRONZE' }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM roles WHERE id')) {
                    return { rows: [{ margin_percent: marginPercent }] };
                }
                if (typeof sql === 'string' && sql.includes('FROM flash_sales')) return { rows: [] };
                if (typeof sql === 'string' && sql.includes('SELECT id, invoice_id FROM transactions')) return { rows: [] };
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance -')) {
                    balanceDeducted = true;
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO transactions')) {
                    return { rows: [{ id: 8801 }] };
                }
                if (typeof sql === 'string' && sql.includes('SELECT id, status, provider_trx_id')) {
                    return { rows: [{ id: 8801, status: 'Pending', provider_trx_id: 'WEB-TEST-1', flash_sale_id: null, flash_sale_restored: false }] };
                }
                if (typeof sql === 'string' && sql.includes("UPDATE transactions SET status = 'Failed'")) {
                    return { rowCount: 1 };
                }
                if (typeof sql === 'string' && sql.includes('UPDATE users SET balance = balance +')) {
                    refunded = true;
                    if (onRefund) onRefund();
                    return { rowCount: 1 };
                }
                return { rows: [] };
            },
            release: () => {},
        }));
        return {
            connectMock,
            getState: () => ({ balanceDeducted, refunded }),
        };
    }

    test('BUG-026: jalur order bypass cache 5 menit sehingga lonjakan harga modal Foxy langsung ditolak 400 tanpa potong saldo', async () => {
        const userToken = fixtures.makeUserToken(201, 'BRONZE', 'user201');
        let providerPrice = 5000;
        let productFetches = 0;

        axios.get = async () => {
            productFetches += 1;
            return { data: { data: [{ product_code: 'SKU-B1-CACHE', product_price: providerPrice }] } };
        };
        axios.post = async () => ({ data: { status: true } });

        const orderDb = mockOrderClient({ basePrice: 5000, marginPercent: 12, sku: 'SKU-B1-CACHE' });
        try {
            const res1 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '10001' }),
            });
            assert.strictEqual(res1.status, 201);

            // Naikkan harga modal provider tanpa memanggil sync-products atau invalidate cache
            providerPrice = 99000;
            const res2 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '10002' }),
            });
            assert.strictEqual(res2.status, 400);
            const body2 = await res2.json();
            assert.strictEqual(body2.message, 'Harga sedang diperbarui, coba lagi sebentar');
            assert.strictEqual(productFetches, 2, 'Order kedua wajib mengambil harga Foxy segar (bypass cache)');
        } finally {
            orderDb.connectMock.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('BUG-007: harga modal provider non-numerik (NaN), kosong, atau negatif ditolak fail-closed 400 sebelum potong saldo', async () => {
        const userToken = fixtures.makeUserToken(202, 'BRONZE', 'user202');
        const badCosts = ['NOT_A_NUMBER', '', null, -500];

        for (const badCost of badCosts) {
            axios.get = async () => ({
                data: { data: [{ product_code: 'SKU-B1-NAN', product_price: badCost }] },
            });
            axios.post = async () => {
                throw new Error('axios.post must NOT be called for invalid cost');
            };
            const orderDb = mockOrderClient({ basePrice: 5000, sku: 'SKU-B1-NAN' });
            try {
                const res = await fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 51, targetGameId: '10003' }),
                });
                assert.strictEqual(res.status, 400, `Expected 400 for cost=${String(badCost)}`);
                assert.strictEqual(orderDb.getState().balanceDeducted, false, 'Saldo tidak boleh dipotong untuk cost invalid');
            } finally {
                orderDb.connectMock.mock.restore();
                axios.get = origAxiosGet;
                axios.post = origAxiosPost;
            }
        }
    });

    test('BUG-024: POST /api/admin/flash-sales tolak discount_price < modal (400) dan izinkan >= modal atau allow_below_cost=true', async () => {
        const adminToken = fixtures.makeAdminToken(1, 'admin');
        const qMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string' && sql.includes('SELECT r.name as role_name')) {
                return { rows: [{ role_name: 'Admin' }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT id, price FROM products')) {
                return { rows: [{ id: 2, price: '19000.00' }] };
            }
            if (typeof sql === 'string' && sql.includes('INSERT INTO flash_sales')) {
                return { rows: [{ id: 99, product_id: 2, discount_price: 19500 }] };
            }
            return { rows: [] };
        });

        try {
            const payloadBase = {
                product_id: 2,
                start_at: '2026-11-19T00:00:00Z',
                end_at: '2026-11-25T00:00:00Z',
                max_uses: 50,
            };

            const belowRes = await fetch(`${baseUrl}/api/admin/flash-sales`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payloadBase, discount_price: 17500 }),
            });
            assert.strictEqual(belowRes.status, 400);

            const validRes = await fetch(`${baseUrl}/api/admin/flash-sales`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payloadBase, discount_price: 19500 }),
            });
            assert.strictEqual(validRes.status, 201);

            const subsidyRes = await fetch(`${baseUrl}/api/admin/flash-sales`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payloadBase, discount_price: 17500, allow_below_cost: true }),
            });
            assert.strictEqual(subsidyRes.status, 201);
        } finally {
            qMock.mock.restore();
        }
    });

    test('BUG-004 & BUG-024: katalog publik, H2H, dan /api/public/flash-sales menyaring kuota habis, harga >= normal, & baseline BRONZE', async () => {
        const seenQueries = [];
        const qMock = mock.method(pool, 'query', async (sql) => {
            if (typeof sql === 'string') seenQueries.push(sql);
            if (typeof sql === 'string' && sql.includes('FROM flash_sales fs')) {
                return { rows: [] };
            }
            if (typeof sql === 'string' && sql.includes('FROM games WHERE id = $1')) {
                return { rows: [{ name: 'ML', image_url: '', needs_server_id: true, target_id_label: 'User ID' }] };
            }
            if (typeof sql === 'string' && sql.includes('FROM products p')) {
                return { rows: [{ id: 10, name: 'Test', provider_sku: 'SKU-10', base_price: 10000, use_manual_prices: false, manual_prices: {}, use_custom_margin: false }] };
            }
            if (typeof sql === 'string' && sql.includes('SELECT name, margin_percent FROM roles')) {
                return { rows: [{ name: 'BRONZE', margin_percent: 12 }] };
            }
            return { rows: [] };
        });

        try {
            const fsRes = await fetch(`${baseUrl}/api/public/flash-sales`);
            assert.strictEqual(fsRes.status, 200);
            const fsSql = seenQueries.find((q) => q.includes('FROM flash_sales fs'));
            assert.ok(fsSql.includes("LOWER(r.name) = 'bronze'"), 'Storefront flash sale harus pakai baseline BRONZE');
            assert.ok(fsSql.includes("p.status = 'Active'") && fsSql.includes("g.status = 'Active'"));

            const prodRes = await fetch(`${baseUrl}/api/games/1/products`);
            assert.strictEqual(prodRes.status, 200);
            const catalogFsSql = seenQueries.find((q) => q.includes('SELECT product_id, discount_price FROM flash_sales'));
            assert.ok(catalogFsSql.includes('uses_count < max_uses'), 'Katalog produk wajib memfilter kuota flash sale habis');

            // Unit check: flashPrice >= normalPrice tidak boleh menimpa harga lebih murah
            const computed = calculateCatalogProducts(
                [{ id: 10, name: 'Item', provider_sku: 'SKU', base_price: 10000, use_manual_prices: false, manual_prices: {}, use_custom_margin: false }],
                'partner',
                { partner: 5 }, // normal = 10500
                new Map([[10, 12000]]) // flash price lebih mahal dari harga partner
            );
            assert.strictEqual(computed[0].isFlashSale, false);
            assert.strictEqual(computed[0].price, 10500);
        } finally {
            qMock.mock.restore();
        }
    });

    test('BUG-003 & SEC-018: pendingTransactions selaras dengan constants.FOXY_BASE_URL, productSync tolak array kosong & aman category_type null', async () => {
        assert.strictEqual(pendingTransactions.FOXY_BASE_URL, constants.FOXY_BASE_URL);
        assert.strictEqual(pendingTransactions.PROVIDER_TIMEOUT_MS, constants.PROVIDER_TIMEOUT_MS);

        let deactivatedCalled = false;
        let insertedCategoryName = null;
        const cMock = mock.method(cronPool, 'connect', async () => ({
            query: async (sql, params) => {
                if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return {};
                if (typeof sql === 'string' && sql.includes('UPDATE products SET status = $1')) {
                    deactivatedCalled = true;
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO product_categories')) {
                    insertedCategoryName = params[1];
                    return { rows: [{ id: 77 }] };
                }
                if (typeof sql === 'string' && sql.includes('INSERT INTO games')) {
                    return { rows: [{ id: 88 }] };
                }
                return { rows: [] };
            },
            release: () => {},
        }));

        try {
            // 1. Array kosong harus dibatalkan sebelum menonaktifkan produk lokal
            axios.get = async () => ({ data: { data: [] } });
            await assert.rejects(() => syncProductsWithFoxy(), /empty product list/i);
            assert.strictEqual(deactivatedCalled, false, 'Produk lokal tidak boleh dinonaktifkan saat upstream kosong');

            // 2. category_type null harus memakai fallback "Umum" tanpa crash TypeError
            axios.get = async () => ({
                data: {
                    data: [{
                        category_title: 'Test Game',
                        category_type: null,
                        product_name: 'Item 1',
                        product_code: 'SKU-NULL-CAT',
                        product_price: 10000,
                    }],
                },
            });
            await syncProductsWithFoxy();
            assert.strictEqual(insertedCategoryName, 'Umum');
        } finally {
            cMock.mock.restore();
            axios.get = origAxiosGet;
        }
    });

    test('BUG-006: respons HTTP 200 HTML atau JSON tanpa status===true di Fase (b) ditolak 400 dan memicu refund Fase (c)', async () => {
        const userToken = fixtures.makeUserToken(203, 'BRONZE', 'user203');
        const badResponses = [
            { data: '<html>Just a moment... Cloudflare</html>' },
            { data: { ok: true, message: 'Missing status boolean true' } },
        ];

        for (const badRes of badResponses) {
            axios.get = async () => ({ data: { data: [{ product_code: 'SKU-B1-HTML', product_price: 4000 }] } });
            axios.post = async () => badRes;

            let refundTriggered = false;
            const orderDb = mockOrderClient({
                basePrice: 5000,
                sku: 'SKU-B1-HTML',
                onRefund: () => { refundTriggered = true; },
            });

            try {
                const res = await fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 51, targetGameId: '998877' }),
                });
                assert.strictEqual(res.status, 400, 'Malformed HTTP 200 provider response must NOT return 201');
                assert.strictEqual(refundTriggered, true, 'Fase (c) wajib me-refund saldo saat respons /v1/order tidak valid');
            } finally {
                orderDb.connectMock.mock.restore();
                axios.get = origAxiosGet;
                axios.post = origAxiosPost;
            }
        }
    });
});
