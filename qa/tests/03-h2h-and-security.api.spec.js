const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const https = require('https');
const {
    BASE_URL,
    createQaPool,
    resetFoxyMock,
    setFoxyMockMode,
    getFoxyMockRequests,
    apiRequest,
    issueQaToken,
    getSeededUserToken,
    loginUser,
    createIsolatedUser,
    cleanupIsolatedUser,
    sendLocalCallback,
} = require('./helpers/qaContext');

let pool;
let adminToken;
const createdUsers = [];

test.beforeAll(async () => {
    pool = createQaPool();
    adminToken = await getSeededUserToken(pool, 'qa_admin');
});

test.beforeEach(async () => {
    await resetFoxyMock();
});

test.afterEach(async () => {
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
    return rows[0];
}

test('PASS: H2H auth, idempotency ref_id sama vs payload beda 409, dan isolasi ref_id antar user', async () => {
    const r1 = await createIsolatedUser(pool, { prefix: 'QAH2H1', roleName: 'PARTNER', balance: 50000, withApiKey: true });
    const r2 = await createIsolatedUser(pool, { prefix: 'QAH2H2', roleName: 'PARTNER', balance: 50000, withApiKey: true });
    createdUsers.push(r1.id, r2.id);

    const badAuth = await apiRequest('GET', '/h2h/profile', { apiKey: 'invalid_key_123' });
    expect([401, 403]).toContain(badAuth.status);

    const prod1 = await getSeededProduct('DUMMY-ML-19');
    const prod2 = await getSeededProduct('DUMMY-ML-172');
    const sharedRef = `H2H-REF-${Date.now()}`;

    const first = await apiRequest('POST', '/h2h/order', {
        apiKey: r1.apiKeyPlain,
        body: { productId: prod1.id, targetGameId: '555666', targetServerId: '1001', ref_id: sharedRef },
    });
    expect(first.status).toBe(201);

    const replay = await apiRequest('POST', '/h2h/order', {
        apiKey: r1.apiKeyPlain,
        body: { productId: prod1.id, targetGameId: '555666', targetServerId: '1001', ref_id: sharedRef },
    });
    expect(replay.status).toBe(200);
    expect(replay.json.idempotent).toBe(true);

    const conflict = await apiRequest('POST', '/h2h/order', {
        apiKey: r1.apiKeyPlain,
        body: { productId: prod2.id, targetGameId: '555666', targetServerId: '1001', ref_id: sharedRef },
    });
    expect(conflict.status).toBe(409);

    // Same ref_id by different user must succeed independently
    const user2Res = await apiRequest('POST', '/h2h/order', {
        apiKey: r2.apiKeyPlain,
        body: { productId: prod1.id, targetGameId: '555666', targetServerId: '1001', ref_id: sharedRef },
    });
    expect(user2Res.status).toBe(201);
    expect(user2Res.json.data.invoiceId).not.toBe(first.json.data.invoiceId);
});

test('PASS: Konkurensi H2H terkendali — saldo cukup untuk 1 order + 10 request paralel => tepat 1 sukses & saldo tidak negatif', async () => {
    const prod = await getSeededProduct('DUMMY-ML-19');
    // Fetch exact PARTNER price first
    const r = await createIsolatedUser(pool, { prefix: 'QARACE', roleName: 'PARTNER', balance: 0, withApiKey: true });
    createdUsers.push(r.id);

    const prodList = await apiRequest('GET', '/h2h/products', { apiKey: r.apiKeyPlain });
    const targetProd = prodList.json.data.find((p) => p.productId === prod.id);
    const unitPrice = Number(targetProd.price);
    // Set balance strictly enough for 1 order only
    await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [unitPrice, r.id]);

    const responses = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
            apiRequest('POST', '/h2h/order', {
                apiKey: r.apiKeyPlain,
                body: {
                    productId: prod.id,
                    targetGameId: '77788899',
                    targetServerId: '2020',
                    ref_id: `RACE-${Date.now()}-${idx}`,
                },
            })
        )
    );

    const successCount = responses.filter((res) => res.status === 201).length;
    expect(successCount).toBe(1);

    const userAfter = await pool.query('SELECT balance FROM users WHERE id = $1', [r.id]);
    expect(Number(userAfter.rows[0].balance)).toBe(0);

    const txRows = await pool.query('SELECT id FROM transactions WHERE user_id = $1', [r.id]);
    expect(txRows.rows.length).toBe(1);
});

test('PASS: Validasi SSRF pada H2H Callback URL menolak http, localhost, IP privat, & metadata cloud', async () => {
    const r = await createIsolatedUser(pool, { prefix: 'QASSRF', roleName: 'PARTNER', balance: 10000, withApiKey: true });
    createdUsers.push(r.id);

    const badUrls = [
        'http://example.com/webhook',
        'https://localhost/webhook',
        'https://127.0.0.1/webhook',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.1/internal',
        'https://192.168.1.1/hook',
    ];
    for (const url of badUrls) {
        const res = await apiRequest('PUT', '/h2h/profile/callback', {
            apiKey: r.apiKeyPlain,
            body: { callback_url: url },
        });
        expect(res.status).toBe(400);
    }
});

test('PASS: Security headers, CORS reject 403, malformed JSON 400, payload >100kb 413, IDOR & RBAC', async () => {
    const health = await apiRequest('GET', '/healthz');
    expect(health.status).toBe(200);
    expect(health.headers.get('x-powered-by')).toBeNull();
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(health.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(health.headers.get('content-security-policy')).not.toContain("'unsafe-inline';");

    const evilCors = await apiRequest('GET', '/api/games', { headers: { Origin: 'https://evil.example' } });
    expect(evilCors.status).toBe(403);

    const badJson = await apiRequest('POST', '/api/auth/login', {
        headers: { 'Content-Type': 'application/json' },
        body: '{"broken":',
    });
    expect(badJson.status).toBe(400);

    const bigBody = await apiRequest('POST', '/api/auth/login', {
        body: { username: 'a'.repeat(120 * 1024), password: 'x' },
    });
    expect(bigBody.status).toBe(413);

    const u1 = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 30000 });
    const u2 = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 30000 });
    createdUsers.push(u1.id, u2.id);
    const t1 = issueQaToken(u1);
    const t2 = issueQaToken(u2);

    // RBAC: non-admin rejected 403 on admin endpoints
    const adminAttempt = await apiRequest('GET', '/api/admin/deposits', { token: t1 });
    expect(adminAttempt.status).toBe(403);

    // IDOR: user 2 cannot view user 1's private invoice
    const prod = await getSeededProduct('DUMMY-ML-19');
    const order1 = await apiRequest('POST', '/api/order', {
        token: t1,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '112233', targetServerId: '1001' },
    });
    expect(order1.status).toBe(201);
    const idorRes = await apiRequest('GET', `/api/user/transaction/${order1.json.invoiceId}`, { token: t2 });
    expect(idorRes.status).toBe(404);

    // Callback auth: missing / wrong token -> 403; SKU mismatch -> ignored
    const noTokenCb = await sendLocalCallback({ trxId: 'ANY', token: '', placement: 'none' });
    expect(noTokenCb.status).toBe(403);

    const txRow = await pool.query('SELECT provider_trx_id FROM transactions WHERE invoice_id = $1', [order1.json.invoiceId]);
    await setFoxyMockMode({ statusBehavior: 'mismatch_sku' });
    const mismatchCb = await sendLocalCallback({ trxId: txRow.rows[0].provider_trx_id });
    expect(mismatchCb.status).toBe(200);
    const txAfterMismatch = await pool.query('SELECT status FROM transactions WHERE invoice_id = $1', [order1.json.invoiceId]);
    expect(txAfterMismatch.rows[0].status).toBe('Pending');
});

test('@bug-BUG-009: PUT /api/user/whitelisted-ips harus menolak elemen non-string ([123]) dengan 400 bukan mengosongkan whitelist menjadi []', async () => {
    const r = await createIsolatedUser(pool, {
        prefix: 'QAIP',
        roleName: 'PARTNER',
        balance: 10000,
        withApiKey: true,
        whitelistedIps: ['203.0.113.10'],
    });
    createdUsers.push(r.id);
    const token = issueQaToken(r);

    const res = await apiRequest('PUT', '/api/user/whitelisted-ips', {
        token,
        body: { ips: [123] },
    });
    expect(res.status).toBe(400);
});

test('@bug-BUG-010: Reseller H2H harus punya endpoint cek status/daftar transaksi (/h2h/transactions atau /h2h/order/:id)', async () => {
    const r = await createIsolatedUser(pool, { prefix: 'QAH2HST', roleName: 'PARTNER', balance: 10000, withApiKey: true });
    createdUsers.push(r.id);

    const res = await apiRequest('GET', '/h2h/transactions', { apiKey: r.apiKeyPlain });
    expect(res.status).toBe(200);
});

test('@bug-BUG-011: JWT lama harus dicabut setelah PUT /api/user/password DAN login email huruf campuran harus berhasil', async () => {
    const u = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 10000 });
    createdUsers.push(u.id);

    // Mixed-case email login test
    const mixedEmailRes = await apiRequest('POST', '/api/auth/login', {
        body: { username: u.email.toUpperCase(), password: u.password },
    });
    expect(mixedEmailRes.status).toBe(200);

    // Password change should invalidate old JWT
    const oldToken = issueQaToken(u);
    const chgRes = await apiRequest('PUT', '/api/user/password', {
        token: oldToken,
        body: { currentPassword: u.password, newPassword: 'NewQaPassword#2026' },
    });
    expect(chgRes.status).toBe(200);

    const staleUse = await apiRequest('GET', '/api/user/profile', { token: oldToken });
    expect(staleUse.status).toBe(401);
});

test('@bug-BUG-012: Cooldown callback 5 detik tidak boleh memblokir retry jika verifikasi /v1/status sebelumnya gagal error 500', async () => {
    const u = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(u.id);
    const token = issueQaToken(u);
    const prod = await getSeededProduct('DUMMY-ML-19');

    const orderRes = await apiRequest('POST', '/api/order', {
        token,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { productId: prod.id, targetGameId: '445566', targetServerId: '1001' },
    });
    expect(orderRes.status).toBe(201);
    const txRow = await pool.query('SELECT provider_trx_id FROM transactions WHERE invoice_id = $1', [orderRes.json.invoiceId]);
    const trxId = txRow.rows[0].provider_trx_id;

    // 1. Mock /v1/status returns 500
    await setFoxyMockMode({ statusBehavior: 'http500' });
    await sendLocalCallback({ trxId });

    // 2. Provider recovers immediately -> retry callback 200ms later
    await setFoxyMockMode({ statusBehavior: 'ok', defaultStatus: 'SUCCESS' });
    await sendLocalCallback({ trxId });

    const txAfter = await pool.query('SELECT status FROM transactions WHERE invoice_id = $1', [orderRes.json.invoiceId]);
    expect(txAfter.rows[0].status).toBe('Success');
});

test('@bug-BUG-014: Aksi mutasi admin pada produk & promo harus tercatat di tabel admin_audit_logs', async () => {
    const promoCode = `QAAUDIT${Date.now()}`.slice(0, 20);
    const createPromo = await apiRequest('POST', '/api/admin/promos', {
        token: adminToken,
        body: {
            code: promoCode,
            type: 'fixed',
            value: 500,
            min_price: 1000,
            max_uses_per_user: 1,
        },
    });
    expect(createPromo.status).toBe(201);

    const auditRows = await pool.query(
        "SELECT id FROM admin_audit_logs WHERE action ILIKE '%promo%' ORDER BY id DESC LIMIT 1"
    );
    await pool.query('DELETE FROM promo_codes WHERE code = $1', [promoCode]);
    expect(auditRows.rows.length).toBeGreaterThan(0);
});

test('@bug-BUG-015: GET /api/public/compare-prices tidak boleh membocorkan produk dari game Inactive atau kolom modal base_price', async () => {
    const inactiveGame = await pool.query(
        "INSERT INTO games (name, category, image_url, status) VALUES ('QAINACTIVE_GAME', 'Mobile Game', 'https://example.com/g.png', 'Inactive') RETURNING id"
    );
    const gId = inactiveGame.rows[0].id;
    const cat = await pool.query("INSERT INTO product_categories (game_id, name) VALUES ($1, 'Default') RETURNING id", [gId]);
    const prod = await pool.query(
        "INSERT INTO products (game_id, category_id, name, provider_sku, price, status) VALUES ($1, $2, 'QAINACTIVE_PROD', $3, 10000, 'Active') RETURNING id",
        [gId, cat.rows[0].id, `QASKU-${Date.now()}`]
    );

    try {
        const res = await apiRequest('GET', '/api/public/compare-prices');
        expect(res.status).toBe(200);
        const leaked = res.json.products.find((p) => p.product_id === prod.rows[0].id);
        expect(leaked).toBeUndefined();
        if (res.json.products.length > 0) {
            expect(res.json.products[0].base_price).toBeUndefined();
        }
    } finally {
        await pool.query('DELETE FROM products WHERE id = $1', [prod.rows[0].id]);
        await pool.query('DELETE FROM product_categories WHERE id = $1', [cat.rows[0].id]);
        await pool.query('DELETE FROM games WHERE id = $1', [gId]);
    }
});
