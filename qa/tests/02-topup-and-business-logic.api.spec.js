const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const path = require('path');
const {
    createQaPool,
    resetFoxyMock,
    setFoxyMockMode,
    getFoxyMockRequests,
    apiRequest,
    issueQaToken,
    getSeededUserToken,
    createIsolatedUser,
    cleanupIsolatedUser,
    sendLocalCallback,
} = require('./helpers/qaContext');

let pool;
let adminToken;
const createdUsers = [];
const createdTempProducts = [];
const createdTempFlashSales = [];
const createdTempPromos = [];

test.beforeAll(async () => {
    pool = createQaPool();
    adminToken = await getSeededUserToken(pool, 'qa_admin');
});

test.beforeEach(async () => {
    await resetFoxyMock();
});

test.afterEach(async () => {
    while (createdTempFlashSales.length > 0) {
        const fsId = createdTempFlashSales.pop();
        await pool.query('DELETE FROM flash_sales WHERE id = $1', [fsId]).catch(() => {});
    }
    while (createdTempPromos.length > 0) {
        const promoId = createdTempPromos.pop();
        await pool.query('DELETE FROM promo_usages WHERE promo_code_id = $1', [promoId]).catch(() => {});
        await pool.query('DELETE FROM promo_codes WHERE id = $1', [promoId]).catch(() => {});
    }
    while (createdTempProducts.length > 0) {
        const prodId = createdTempProducts.pop();
        await pool.query('DELETE FROM transactions WHERE product_id = $1', [prodId]).catch(() => {});
        await pool.query('DELETE FROM products WHERE id = $1', [prodId]).catch(() => {});
    }
    while (createdUsers.length > 0) {
        const uid = createdUsers.pop();
        await cleanupIsolatedUser(pool, uid);
    }
});

test.afterAll(async () => {
    if (pool) await pool.end();
});

async function getSeededProduct(sku = 'DUMMY-ML-19') {
    const { rows } = await pool.query('SELECT id, game_id, name, provider_sku, price FROM products WHERE provider_sku = $1 LIMIT 1', [sku]);
    if (rows.length === 0) throw new Error(`Seeded product ${sku} missing`);
    return rows[0];
}

test('PASS: Web top-up E2E sukses via mock Foxy + callback Zero-Trust simpan SN & mutasi saldo', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const prod = await getSeededProduct('DUMMY-ML-19'); // base 5000, BRONZE 12% => 5600/5601

    const idemKey = crypto.randomUUID();
    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': idemKey },
        body: {
            productId: prod.id,
            targetGameId: '12345678',
            targetServerId: '2024',
            price: 1, // attempted client price tamper
        },
    });
    expect(orderRes.status).toBe(201);
    const invoiceId = orderRes.json.invoiceId;
    expect(invoiceId).toMatch(/^TRX-/);

    const txBeforeCb = await pool.query('SELECT status, price, provider_trx_id, provider_sn FROM transactions WHERE invoice_id = $1', [invoiceId]);
    expect(txBeforeCb.rows[0].status).toBe('Pending');
    expect(Number(txBeforeCb.rows[0].price)).toBeGreaterThan(1000); // tampered price=1 ignored

    // Spoof FAILED in body, but mock /v1/status returns SUCCESS -> Zero-Trust must mark Success
    await setFoxyMockMode({ defaultStatus: 'SUCCESS' });
    const cbRes = await sendLocalCallback({
        trxId: txBeforeCb.rows[0].provider_trx_id,
        extraBody: { status: 'FAILED', sn: 'FAKE-SN-SPOOFED' },
    });
    expect(cbRes.status).toBe(200);

    const txAfterCb = await pool.query('SELECT status, provider_sn FROM transactions WHERE invoice_id = $1', [invoiceId]);
    expect(txAfterCb.rows[0].status).toBe('Success');
    expect(txAfterCb.rows[0].provider_sn).toContain('SN-MOCK-');
    expect(txAfterCb.rows[0].provider_sn).not.toBe('FAKE-SN-SPOOFED');

    const userAfter = await pool.query('SELECT balance FROM users WHERE id = $1', [user.id]);
    expect(Number(userAfter.rows[0].balance)).toBe(50000 - Number(txBeforeCb.rows[0].price));
});

test('PASS: Web top-up gagal di provider Fase (b) otomatis refund penuh & pulihkan kuota promo/flash sale', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 60000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const prod = await getSeededProduct('DUMMY-ML-172'); // base 38000, BRONZE 12% => 42560

    // Temporary flash sale valid >= base_price (42400) & < 42560
    const fsInsert = await pool.query(
        `INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, uses_count, is_active)
         VALUES ($1, 42400, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 10, 0, true)
         RETURNING id, uses_count`,
        [prod.id]
    );
    const tempFsId = fsInsert.rows[0].id;
    createdTempFlashSales.push(tempFsId);
    const promoBefore = await pool.query("SELECT id, uses_count FROM promo_codes WHERE code = 'MIKUBARU'");

    await setFoxyMockMode({ orderBehavior: 'reject' });
    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: {
            productId: prod.id,
            targetGameId: '98765432',
            targetServerId: '2025',
            promoCode: 'MIKUBARU', // 42400 - 4240 = 38160 >= 38000 modal!
        },
    });
    expect(orderRes.status).toBe(400);
    expect(orderRes.json.message).toContain('Gagal mengirim pesanan ke provider');

    const userAfter = await pool.query('SELECT balance FROM users WHERE id = $1', [user.id]);
    expect(Number(userAfter.rows[0].balance)).toBe(60000);

    const fsAfter = await pool.query('SELECT uses_count FROM flash_sales WHERE id = $1', [tempFsId]);
    expect(Number(fsAfter.rows[0].uses_count)).toBe(0);

    const promoAfter = await pool.query('SELECT uses_count FROM promo_codes WHERE id = $1', [promoBefore.rows[0].id]);
    expect(Number(promoAfter.rows[0].uses_count)).toBe(Number(promoBefore.rows[0].uses_count));
});

test('@bug-BUG-026: Cache 5 menit getFoxyProducts menyebabkan order tetap lolos (rugi) ketika harga modal Foxy mendadak naik', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const prod = await getSeededProduct('DUMMY-ML-19');

    // Pastikan cache Foxy terisi harga normal 5000 terlebih dulu, lalu naikkan harga mock menjadi 99000
    await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '123456', targetServerId: '1001' },
    });

    await setFoxyMockMode({ priceOverrides: { 'DUMMY-ML-19': 99000 } });
    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '123457', targetServerId: '1001' },
    });
    // Expected: realtime price check blocks loss-making order (400), NOT 201 using stale cache
    expect(orderRes.status).toBe(400);
});

test('PASS: Deposit manual flow + admin approve menambah saldo tepat satu kali & tolak double approve', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 10000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);

    const depRes = await apiRequest('POST', '/api/deposit/request', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { amount: 25000, method: 'QRIS', note: 'QA deposit test' },
    });
    expect(depRes.status).toBe(201);
    const depositId = depRes.json.deposit.id;
    expect(Number(depRes.json.deposit.amount)).toBe(25000);

    const approve1 = await apiRequest('POST', '/api/admin/deposits/approve', {
        token: adminToken,
        body: { depositId },
    });
    expect(approve1.status).toBe(200);

    const approve2 = await apiRequest('POST', '/api/admin/deposits/approve', {
        token: adminToken,
        body: { depositId },
    });
    expect(approve2.status).toBe(409);

    const userAfter = await pool.query('SELECT balance FROM users WHERE id = $1', [user.id]);
    expect(Number(userAfter.rows[0].balance)).toBe(35000);
});

test('@bug-BUG-001: Endpoint debug POST /api/test harus dinonaktifkan atau wajib auth admin (saat ini terbuka publik 200 OK)', async () => {
    const res = await apiRequest('POST', '/api/test', { body: { probe: true } });
    expect([401, 403, 404]).toContain(res.status);
});

test('@bug-BUG-003: Modul cron pendingTransactions & productSync seharusnya mengikuti FOXY_BASE_URL env, bukan hardcoded production URL', async () => {
    const pendingJobs = require(path.resolve(__dirname, '../../backend/jobs/pendingTransactions.js'));
    expect(pendingJobs.FOXY_BASE_URL).toBe('http://127.0.0.1:4010');
});

test('@bug-BUG-004: Flash sale dengan kuota habis (uses_count >= max_uses) tidak boleh lagi ditampilkan pada katalog publik/H2H', async () => {
    const prod = await getSeededProduct('DUMMY-FF-50');
    const fsRes = await pool.query(
        `INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, uses_count, is_active)
         VALUES ($1, 6600, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 1, 1, true)
         RETURNING id`,
        [prod.id]
    );
    createdTempFlashSales.push(fsRes.rows[0].id);

    const catalogRes = await apiRequest('GET', `/api/games/${prod.game_id}/products`);
    expect(catalogRes.status).toBe(200);
    const ff50 = catalogRes.json.products.find((p) => p.id === prod.id);
    // Expected: exhausted flash sale must NOT advertise discount_price (6600)
    expect(ff50.isFlashSale).toBe(false);
    expect(Number(ff50.price)).toBeGreaterThan(6600);
});

test('@bug-BUG-005: POST /api/admin/balance/add seharusnya menolak input float (0.5) & notasi ilmiah ("1e5") dengan 400 tanpa mutasi 0-rupiah', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 10000 });
    createdUsers.push(user.id);

    const resSci = await apiRequest('POST', '/api/admin/balance/add', {
        token: adminToken,
        body: { userId: user.id, amount: '1e5' },
    });
    expect(resSci.status).toBe(400);

    const resFloat = await apiRequest('POST', '/api/admin/balance/add', {
        token: adminToken,
        body: { userId: user.id, amount: 0.5 },
    });
    expect(resFloat.status).toBe(400);
});

test('@bug-BUG-006: Respons non-JSON HTML 200 dari provider saat /v1/order tidak boleh dianggap order berhasil diterima (201 Pending)', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const prod = await getSeededProduct('DUMMY-ML-19');

    await setFoxyMockMode({ orderBehavior: 'invalid_json' });
    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '123456', targetServerId: '1001' },
    });
    // Expected: malformed HTML page from upstream should NOT return 201 Accepted/Pending
    expect(orderRes.status).not.toBe(201);
});

test('@bug-BUG-007: Harga modal Foxy non-numerik (NaN) harus ditolak Price Guard (fail-closed), bukan lolos order', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const prod = await getSeededProduct('DUMMY-ML-19');

    await setFoxyMockMode({ priceOverrides: { 'DUMMY-ML-19': 'NOT_A_NUMBER' } });
    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '123456', targetServerId: '1001' },
    });
    expect(orderRes.status).toBe(400);
});

test('@bug-BUG-008: User yang pernah meminta reset password harus tetap bisa mengubah email di PUT /api/user/profile tanpa error 500 FK', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 10000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);

    await apiRequest('POST', '/api/auth/forgot-password', {
        body: { email: user.email },
    });

    const newEmail = `updated_${user.username.toLowerCase()}@qa.local.test`;
    const profRes = await apiRequest('PUT', '/api/user/profile', {
        token,
        body: {
            fullName: 'Updated Name',
            email: newEmail,
            nomorWa: '+6289912345678',
        },
    });
    expect(profRes.status).toBe(200);
});

test('@bug-BUG-013: Request deposit paralel oleh user yang sama tidak boleh menembus batas maksimal 2 deposit Pending', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 10000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);

    const results = await Promise.all(
        Array.from({ length: 6 }, () =>
            apiRequest('POST', '/api/deposit/request', {
                token,
                headers: { 'Idempotency-Key': crypto.randomUUID() },
                body: { amount: 15000, method: 'QRIS' },
            })
        )
    );
    const createdCount = results.filter((r) => r.status === 201).length;
    expect(createdCount).toBeLessThanOrEqual(2);
});

test('@bug-BUG-024: Flash Sale DUMMY-ML-86 (Rp 17.500 < modal Rp 19.000) gagal checkout 400 & admin bisa membuat flash sale di bawah modal', async () => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const prod = await getSeededProduct('DUMMY-ML-86');

    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '123456', targetServerId: '2001' },
    });
    // Expected: advertised active flash sale on storefront should be purchasable (201)
    expect(orderRes.status).toBe(201);
});
