const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const {
    BASE_URL,
    createQaPool,
    resetFoxyMock,
    setFoxyMockMode,
    issueQaToken,
    getSeededUserToken,
    createIsolatedUser,
    cleanupIsolatedUser,
    sendLocalCallback,
} = require('./helpers/qaContext');

let pool;
let adminToken;
const createdUsers = [];
const createdPromos = [];

test.beforeAll(async () => {
    pool = createQaPool();
    adminToken = await getSeededUserToken(pool, 'qa_admin');
});

test.beforeEach(async () => {
    await resetFoxyMock();
});

test.afterEach(async () => {
    while (createdPromos.length > 0) {
        const code = createdPromos.pop();
        await pool.query('DELETE FROM promo_usages WHERE promo_code_id IN (SELECT id FROM promo_codes WHERE code = $1)', [code]).catch(() => {});
        await pool.query('DELETE FROM promo_codes WHERE code = $1', [code]).catch(() => {});
    }
    while (createdUsers.length > 0) {
        const uid = createdUsers.pop();
        await cleanupIsolatedUser(pool, uid);
    }
});

test.afterAll(async () => {
    if (pool) await pool.end();
});

const PUBLIC_PAGES = [
    '/index.html',
    '/cek-transaksi.html',
    '/compare-prices.html',
    '/leaderboard.html',
    '/validate.html',
    '/reset-password.html?token=testtoken',
    '/syarat-ketentuan.html',
    '/kebijakan-refund.html',
    '/kontak.html',
];

const VIEWPORTS = [
    { name: 'desktop-1440', width: 1440, height: 900 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'mobile-375', width: 375, height: 812 },
    { name: 'mobile-390', width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
    test(`PASS: Seluruh halaman publik bebas console error, failed request, & horizontal overflow pada ${vp.name}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await context.newPage();
        const consoleErrors = [];
        const pageErrors = [];
        const failedRequests = [];

        page.on('console', (msg) => {
            if (msg.type() === 'error' && !msg.text().includes('404 (Not Found)')) {
                consoleErrors.push(`${page.url()}: ${msg.text()}`);
            }
        });
        page.on('pageerror', (err) => pageErrors.push(`${page.url()}: ${err.message}`));
        page.on('response', (res) => {
            if (res.status() >= 400 && res.url().startsWith(BASE_URL) && !res.url().endsWith('/favicon.ico')) {
                failedRequests.push(`${res.status()} ${res.url()}`);
            }
        });

        for (const pagePath of PUBLIC_PAGES) {
            await page.goto(`${BASE_URL}${pagePath}`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(350);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
            expect(overflow, `Horizontal overflow on ${pagePath} @ ${vp.name}`).toBe(false);
        }

        // Also check product.html for seeded game
        const { rows: games } = await pool.query("SELECT id FROM games WHERE status = 'Active' ORDER BY id ASC LIMIT 1");
        await page.goto(`${BASE_URL}/product.html?gameId=${games[0].id}`, { waitUntil: 'networkidle' });
        const prodOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(prodOverflow, `Horizontal overflow on product.html @ ${vp.name}`).toBe(false);

        await context.close();
        expect(consoleErrors, 'Console errors detected').toEqual([]);
        expect(pageErrors, 'Uncaught page errors detected').toEqual([]);
        expect(failedRequests, 'Unexpected HTTP >= 400 responses').toEqual([]);
    });
}

test('PASS: Alur UI top-up penuh (login -> pilih produk -> isi ID -> bayar -> invoice.html & callback sukses)', async ({ page }) => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const { rows: mlRows } = await pool.query("SELECT id FROM games WHERE name = 'Mobile Legends' AND status = 'Active' LIMIT 1");
    const gameId = mlRows[0].id;

    await page.goto(`${BASE_URL}/product.html?gameId=${gameId}`, { waitUntil: 'networkidle' });

    // Login via modal on product.html
    await page.click('#user-auth-button');
    await page.fill('#login-form input[name="username"]', user.username);
    await page.fill('#login-form input[name="password"]', user.password);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click('#login-form button[type="submit"]'),
    ]);

    // Select DUMMY-ML-19 (first non-flash card)
    const targetCard = page.locator('.product-card-selectable', { hasText: '19 Diamonds' }).first();
    await targetCard.click();

    await page.fill('#target-game-id', '123456789');
    await page.fill('#target-server-id', '2025');
    await page.click('#validate-id-btn');

    // Click Order & confirm modal
    await expect(page.locator('#submit-order-btn')).toBeEnabled();
    await page.click('#submit-order-btn');
    await expect(page.locator('#order-confirmation-modal')).toBeVisible();

    const [orderResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/order') && r.request().method() === 'POST'),
        page.click('#confirm-order-btn'),
    ]);
    expect(orderResponse.status()).toBe(201);
    const orderJson = await orderResponse.json();
    const invoiceId = orderJson.invoiceId;

    await page.waitForURL(new RegExp(`invoice\\.html\\?id=${invoiceId}`));
    await expect(page.locator('#invoice-details-container')).toContainText(invoiceId);

    // Send mock callback -> reload invoice -> status Success & SN shown
    const txRow = await pool.query('SELECT provider_trx_id FROM transactions WHERE invoice_id = $1', [invoiceId]);
    await setFoxyMockMode({ defaultStatus: 'SUCCESS' });
    await sendLocalCallback({ trxId: txRow.rows[0].provider_trx_id });

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#invoice-details-container')).toContainText(/Success|Berhasil/i);
    await expect(page.locator('#invoice-details-container')).toContainText('SN-MOCK-');
});

test('PASS: Dashboard Member & Admin tabs bebas error pada desktop & mobile setelah login', async ({ browser }) => {
    const memberCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mPage = await memberCtx.newPage();
    const mErrors = [];
    mPage.on('pageerror', (e) => mErrors.push(e.message));
    mPage.on('response', (r) => {
        if (r.status() >= 400 && r.url().startsWith(BASE_URL)) mErrors.push(`${r.status()} ${r.url()}`);
    });

    const memberToken = await getSeededUserToken(pool, 'qa_member');
    await mPage.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await mPage.evaluate((t) => localStorage.setItem('authToken', t), memberToken);
    await mPage.goto(`${BASE_URL}/dashboard.html`, { waitUntil: 'networkidle' });
    await expect(mPage.locator('#profile-username')).toContainText('qa_member');

    for (const tab of ['transaksi-tab', 'cek-pesanan', 'mutasi-saldo', 'deposit-tab', 'integrasi']) {
        await mPage.click('#menu-toggle-btn');
        await mPage.click(`.dashboard-nav-link[data-target="${tab}"]`);
        await mPage.waitForTimeout(200);
        const overflow = await mPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(overflow, `Dashboard overflow on tab ${tab} @ 375px`).toBe(false);
    }
    await memberCtx.close();
    expect(mErrors).toEqual([]);

    const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const aPage = await adminCtx.newPage();
    const aErrors = [];
    aPage.on('pageerror', (e) => aErrors.push(e.message));
    aPage.on('response', (r) => {
        if (r.status() >= 400 && r.url().startsWith(BASE_URL)) aErrors.push(`${r.status()} ${r.url()}`);
    });

    await aPage.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await aPage.evaluate((t) => localStorage.setItem('authToken', t), adminToken);
    await aPage.goto(`${BASE_URL}/admin.html`, { waitUntil: 'networkidle' });

    for (const tab of ['deposit', 'payment-methods', 'saldo', 'margin', 'promo', 'flash-sale', 'transaksi']) {
        await aPage.click(`.admin-nav-link[data-target="${tab}"]`);
        await aPage.waitForTimeout(150);
    }
    await adminCtx.close();
    expect(aErrors).toEqual([]);
});

test('@bug-BUG-002: Editor Harga Manual Admin tidak boleh mengirim role "admin" yang ditolak HTTP 400 oleh backend', async ({ page }) => {
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('authToken', t), adminToken);
    await page.goto(`${BASE_URL}/admin.html`, { waitUntil: 'networkidle' });

    const editBtn = page.locator('.manual-price-btn').first();
    await editBtn.click();
    await expect(page.locator('#manual-price-editor')).toBeVisible();
    const isManualChecked = await page.isChecked('#use-manual-prices-toggle');
    if (!isManualChecked) {
        await page.locator('#use-manual-prices-toggle').locator('..').click();
    }
    await page.fill('#manual-price-bronze', '1600');
    await page.fill('#manual-price-admin', '1500');

    const [saveRes] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/manual-prices') && r.request().method() === 'POST'),
        page.click('#save-manual-price-btn'),
    ]);
    // Expected: Admin UI saves cleanly (200), not 400 due to sending "admin"
    expect(saveRes.status()).toBe(200);
});

test('@bug-BUG-016: Form Tambah Promo Admin harus mengirim promo-max-discount (max_discount_amount) ke backend', async ({ page }) => {
    const code = `QAMAX${Date.now()}`.slice(0, 18);
    createdPromos.push(code);

    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('authToken', t), adminToken);
    await page.goto(`${BASE_URL}/admin.html`, { waitUntil: 'networkidle' });

    await page.click('.admin-nav-link[data-target="promo"]');
    await page.fill('#promo-code', code);
    await page.fill('#promo-description', 'QA Promo Max Cap');
    await page.selectOption('#promo-type', 'percentage');
    await page.fill('#promo-value', '50');
    await page.fill('#promo-max-discount', '2500');

    const [promoRes] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/admin/promos') && r.request().method() === 'POST'),
        page.click('#add-promo-form button[type="submit"]'),
    ]);
    expect(promoRes.status()).toBe(201);

    const { rows } = await pool.query('SELECT rules FROM promo_codes WHERE code = $1', [code]);
    expect(rows[0].rules.max_discount_amount).toBe(2500);
});

test('@bug-BUG-017: URL query fsPrice pada product.html tidak boleh menimpa harga resmi server menjadi Rp 1', async ({ page }) => {
    const { rows } = await pool.query(
        "SELECT id, game_id FROM products WHERE provider_sku = 'DUMMY-ML-19' LIMIT 1"
    );
    await page.goto(`${BASE_URL}/product.html?gameId=${rows[0].game_id}&fsProductId=${rows[0].id}&fsPrice=1`, {
        waitUntil: 'networkidle',
    });

    const selectedPriceText = await page.locator('#total-price').textContent();
    expect(selectedPriceText.replace(/[^\d]/g, '')).not.toBe('1');
});

test('@bug-BUG-018: Mengubah teks #promo-code-input setelah Terapkan harus mereset diskon promo pada #total-price', async ({ page }) => {
    const user = await createIsolatedUser(pool, { roleName: 'BRONZE', balance: 50000 });
    createdUsers.push(user.id);
    const token = issueQaToken(user);
    const { rows: games } = await pool.query("SELECT id FROM games WHERE name = 'Mobile Legends' AND status = 'Active' LIMIT 1");

    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('authToken', t), token);
    await page.goto(`${BASE_URL}/product.html?gameId=${games[0].id}`, { waitUntil: 'networkidle' });

    await page.locator('.product-card-selectable', { hasText: '172 Diamonds' }).first().click();
    const baseTotal = await page.locator('#total-price').textContent();

    await page.fill('#target-game-id', '123456');
    await page.fill('#promo-code-input', 'MIKUBARU');
    await page.click('#apply-promo-btn');
    await expect(page.locator('#promo-result')).toContainText(/Diskon|Potongan|Rp/i);

    // Clear promo input without clicking Terapkan again -> total should revert to baseTotal
    await page.fill('#promo-code-input', '');
    await expect(page.locator('#total-price')).toHaveText(baseTotal);
});

test('@bug-BUG-019: File /favicon.ico yang direferensikan seluruh HTML seharusnya ada (tidak memicu HTTP 404)', async ({ page }) => {
    const res = await page.request.get(`${BASE_URL}/favicon.ico`);
    expect(res.status()).toBe(200);
});

test('@bug-BUG-020: Form deposit member seharusnya mengizinkan nominal non-kelipatan 1000 (mis. Rp 15.500) sesuai aturan backend', async ({ page }) => {
    const memberToken = await getSeededUserToken(pool, 'qa_member');
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('authToken', t), memberToken);
    await page.goto(`${BASE_URL}/dashboard.html`, { waitUntil: 'networkidle' });
    await page.click('.dashboard-nav-link[data-target="deposit-tab"]');

    await page.fill('#amount', '15500');
    const isValid = await page.evaluate(() => document.getElementById('amount').checkValidity());
    expect(isValid).toBe(true);
});

test('@bug-BUG-021: Member non-admin yang membuka admin.html harus langsung dialihkan keluar tanpa memuat panel & memicu error 403', async ({ page }) => {
    const memberToken = await getSeededUserToken(pool, 'qa_member');
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('authToken', t), memberToken);
    await page.goto(`${BASE_URL}/admin.html`, { waitUntil: 'networkidle' });

    expect(page.url()).not.toContain('admin.html');
});

test('@bug-BUG-022: Input alasan penolakan deposit di admin.html (maxlength=300) melebihi batas backend 200 karakter', async ({ page }) => {
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('authToken', t), adminToken);
    await page.goto(`${BASE_URL}/admin.html`, { waitUntil: 'networkidle' });

    const maxAttr = await page.locator('#reject-reason-input').getAttribute('maxlength');
    expect(Number(maxAttr)).toBeLessThanOrEqual(200);
});

test('@bug-BUG-023: Mengklik metode bayar tunggal "Saldo Akun" yang sudah terpilih tidak boleh membatalkan pilihan menjadi kosong', async ({ page }) => {
    const { rows: games } = await pool.query("SELECT id FROM games WHERE status = 'Active' ORDER BY id ASC LIMIT 1");
    await page.goto(`${BASE_URL}/product.html?gameId=${games[0].id}`, { waitUntil: 'networkidle' });

    const balanceBtn = page.locator('.payment-method-card[data-method="balance"]');
    await expect(balanceBtn).toHaveClass(/selected/);
    await balanceBtn.click();
    await expect(balanceBtn).toHaveClass(/selected/);
});

test('@bug-BUG-025: Ikon toggle password pada reset-password.html harus tetap berada di dalam kotak input', async ({ page }) => {
    await page.goto(`${BASE_URL}/reset-password.html?token=abcd1234`, { waitUntil: 'networkidle' });
    const bounds = await page.evaluate(() => {
        const input = document.querySelector('input[name="newPassword"]').getBoundingClientRect();
        const icon = document.querySelector('.toggle-password').getBoundingClientRect();
        return { inputRight: input.right, iconRight: icon.right, inputLeft: input.left, iconLeft: icon.left };
    });
    expect(bounds.iconRight).toBeLessThanOrEqual(bounds.inputRight);
    expect(bounds.iconLeft).toBeGreaterThanOrEqual(bounds.inputLeft);
});
