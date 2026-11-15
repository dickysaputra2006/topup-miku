const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool, axios, serverMod, createServerHarness } = require('../helpers/appFactory');
const fixtures = require('../helpers/fixtures');
const { createTransactionalMockDb } = require('../helpers/mockDb');
const { invalidateFoxyProductCache } = serverMod;

describe('Phase 14: SEC-009: Idempotency Keys & Cryptographic Invoice IDs', () => {
    const harness = createServerHarness({ withAxios: true });
    let baseUrl;
    let origAxiosGet;
    let origAxiosPost;

    function makeUserToken(id, role = 'User') {
        return fixtures.makeUserToken(id, role, `sec9_user_${id}`);
    }

    before(() => {
        ({ baseUrl, origAxiosGet, origAxiosPost } = harness.start());
    });

    after(async () => {
        await harness.stop();
    });

    test('SEC-009 (1): migrasi 011 idempoten menambah hanya transactions.ref_id dan deposits.idempotency_key dengan unique index parsial', () => {
        const migrationsDir = path.resolve(__dirname, '../../../migrations');
        const files = fs.readdirSync(migrationsDir).filter((f) => /^011_.*\.sql$/i.test(f));
        assert.strictEqual(files.length, 1, 'Harus ada tepat satu file migrasi 011_*.sql');

        const sql = fs.readFileSync(path.join(migrationsDir, files[0]), 'utf8');
        assert.match(sql, /ALTER\s+TABLE\s+transactions[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+ref_id\s+VARCHAR\(100\)/i);
        assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+transactions\s*\(\s*user_id\s*,\s*ref_id\s*\)\s+WHERE\s+ref_id\s+IS\s+NOT\s+NULL/i);
        assert.match(sql, /ALTER\s+TABLE\s+deposits[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+idempotency_key\s+VARCHAR\(100\)/i);
        assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+deposits\s*\(\s*user_id\s*,\s*idempotency_key\s*\)\s+WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL/i);

        const addColumnMatches = sql.match(/ADD\s+COLUMN/gi) || [];
        assert.strictEqual(addColumnMatches.length, 2, 'Migrasi 011 tidak boleh menambah kolom selain ref_id dan idempotency_key');
    });

    test('SEC-009 (2): POST /h2h/order — ref_id validasi, HTTP 200 idempotent:true tanpa double debit, 409 payload beda, & kompatibel tanpa ref_id', async () => {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const db = createTransactionalMockDb(
            [{
                id: 9201,
                username: 'h2h_sec9',
                balance: 200000,
                role_id: 2,
                role_name: 'PARTNER',
                api_key: null,
                api_key_hash: apiKeyHash,
                whitelisted_ips: []
            }],
            [
                {
                    id: 11, name: 'ML 86 Diamonds', provider_sku: 'ML-86', price: 12000, status: 'Active',
                    game_id: 1, needs_server_id: false, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                },
                {
                    id: 12, name: 'ML 172 Diamonds', provider_sku: 'ML-172', price: 20000, status: 'Active',
                    game_id: 1, needs_server_id: true, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                }
            ]
        );

        let foxyOrderCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: {
                data: [
                    { product_code: 'ML-86', product_price: 11000 },
                    { product_code: 'ML-172', product_price: 18000 }
                ]
            }
        });
        axios.post = async () => {
            foxyOrderCalls++;
            return { data: { status: true } };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // 1. Format ref_id tidak valid ditolak 400
            for (const badRef of ['', 'bad ref with space', 'x'.repeat(101), '../etc/passwd']) {
                const resBad = await fetch(`${baseUrl}/h2h/order`, {
                    method: 'POST',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: badRef })
                });
                assert.strictEqual(resBad.status, 400, `ref_id tidak valid "${badRef}" harus ditolak 400`);
            }
            assert.strictEqual(foxyOrderCalls, 0);

            // 2. Request pertama dengan ref_id -> 201 Created, invoice kriptografis H2H-...
            const res1 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(res1.status, 201, 'Order H2H pertama harus mengembalikan 201');
            const body1 = await res1.json();
            assert.strictEqual(body1.success, true);
            assert.match(body1.data.invoiceId, /^H2H-[A-F0-9]{16,}$/, 'invoiceId H2H harus berformat kriptografis H2H-<HEX>');
            const expectedFirstBalance = 200000 - body1.data.price;
            assert.strictEqual(body1.data.price, Math.ceil(12000 * 1.1));
            assert.strictEqual(db.users.get(9201).balance, expectedFirstBalance, 'Saldo harus terpotong sekali sebesar harga produk');
            assert.strictEqual(foxyOrderCalls, 1);

            // Simulasikan transaksi sudah berubah jadi Success oleh callback/cron
            db.transactions[0].status = 'Success';

            // 3. Retry dengan ref_id & payload sama -> HTTP 200 + idempotent:true + status sama
            const resRetry = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(resRetry.status, 200, 'Retry dengan ref_id sama harus mengembalikan HTTP 200');
            const bodyRetry = await resRetry.json();
            assert.strictEqual(bodyRetry.idempotent, true, 'Respons retry harus menandai idempotent: true');
            assert.strictEqual(bodyRetry.data.invoiceId, body1.data.invoiceId, 'invoiceId retry harus identik');
            assert.strictEqual(bodyRetry.data.status, 'Success', 'Status terbaru transaksi harus dikembalikan');
            assert.strictEqual(bodyRetry.data.price, body1.data.price);
            assert.strictEqual(db.users.get(9201).balance, expectedFirstBalance, 'Saldo TIDAK boleh terpotong ulang');
            assert.strictEqual(foxyOrderCalls, 1, 'Foxy tidak boleh dipanggil ulang pada retry idempoten');
            assert.strictEqual(db.transactions.length, 1);

            // 4. Retry dengan ref_id sama tapi target atau product berbeda -> HTTP 409 Conflict
            const resDiffTarget = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '999888', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(resDiffTarget.status, 409, 'ref_id sama dengan target berbeda harus ditolak 409');

            const resDiffProduct = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '100200', targetServerId: '1234', ref_id: 'ORD-H2H-001' })
            });
            assert.strictEqual(resDiffProduct.status, 409, 'ref_id sama dengan produk berbeda harus ditolak 409');
            assert.strictEqual(db.users.get(9201).balance, expectedFirstBalance);

            // 5. ref_id BARU dalam <15 detik untuk produk & target sama tetap diterima (201)
            const resDistinctRef = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 11, targetGameId: '100200', ref_id: 'ORD-H2H-002' })
            });
            assert.strictEqual(resDistinctRef.status, 201, 'ref_id berbeda harus diizinkan meski dalam 15 detik');
            const bodyDistinct = await resDistinctRef.json();
            assert.notStrictEqual(bodyDistinct.data.invoiceId, body1.data.invoiceId);
            assert.strictEqual(db.transactions.length, 2);

            // 6. Tanpa ref_id mempertahankan perilaku lama (201 pertama, lalu blokir duplicate pending 15 detik)
            const resLegacy1 = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '555666', targetServerId: '2020' })
            });
            assert.strictEqual(resLegacy1.status, 201, 'Order H2H tanpa ref_id tetap harus berfungsi untuk reseller lama');

            const resLegacyDup = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 12, targetGameId: '555666', targetServerId: '2020' })
            });
            assert.strictEqual(resLegacyDup.status, 400, 'Tanpa ref_id tetap terkena guard duplikat 15 detik');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (3): POST /api/order — header Idempotency-Key (UUID) mengembalikan 200 idempotent:true, tolak 409 jika payload beda, & tolak non-UUID 400', async () => {
        const token = makeUserToken(9202, 'User');
        const db = createTransactionalMockDb(
            [{ id: 9202, username: 'web_sec9', balance: 100000, role_id: 1, role_name: 'User' }],
            [
                {
                    id: 21, name: 'DM 50', provider_sku: 'DM-50', price: 10000, status: 'Active',
                    game_id: 1, needs_server_id: false, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                },
                {
                    id: 22, name: 'DM 100', provider_sku: 'DM-100', price: 20000, status: 'Active',
                    game_id: 1, needs_server_id: false, validation_config: null,
                    use_manual_prices: false, manual_prices: {}, use_custom_margin: false
                }
            ]
        );

        let foxyCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: {
                data: [
                    { product_code: 'DM-50', product_price: 9000 },
                    { product_code: 'DM-100', product_price: 18000 }
                ]
            }
        });
        axios.post = async () => {
            foxyCalls++;
            return { data: { status: true } };
        };
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        const idemKey = '550e8400-e29b-41d4-a716-446655440001';
        try {
            // Invalid UUID headers -> 400
            for (const badHeader of ['not-a-uuid', '']) {
                const resBad = await fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': badHeader
                    },
                    body: JSON.stringify({ productId: 21, targetGameId: '778899' })
                });
                assert.strictEqual(resBad.status, 400, `Idempotency-Key "${badHeader}" harus ditolak 400`);
            }

            // Valid UUID order -> 201, crypto TRX- invoice
            const res1 = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey
                },
                body: JSON.stringify({ productId: 21, targetGameId: '778899' })
            });
            assert.strictEqual(res1.status, 201);
            const body1 = await res1.json();
            assert.match(body1.invoiceId, /^TRX-[A-F0-9]{16,}$/, 'invoiceId web harus berformat TRX-<HEX>');
            assert.strictEqual(db.users.get(9202).balance, 89000);
            assert.strictEqual(foxyCalls, 1);

            // Retry with exact same UUID & payload -> 200 + idempotent:true
            const resRetry = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey.toUpperCase()
                },
                body: JSON.stringify({ productId: 21, targetGameId: '778899' })
            });
            assert.strictEqual(resRetry.status, 200);
            const bodyRetry = await resRetry.json();
            assert.strictEqual(bodyRetry.idempotent, true);
            assert.strictEqual(bodyRetry.invoiceId, body1.invoiceId);
            assert.strictEqual(db.users.get(9202).balance, 89000);
            assert.strictEqual(foxyCalls, 1);

            // Retry with same UUID & different target/product -> 409
            const resConflict = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey
                },
                body: JSON.stringify({ productId: 22, targetGameId: '778899' })
            });
            assert.strictEqual(resConflict.status, 409, 'Idempotency-Key sama dengan produk berbeda harus ditolak 409');

            const resConflictTarget = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idemKey
                },
                body: JSON.stringify({ productId: 21, targetGameId: '111222' })
            });
            assert.strictEqual(resConflictTarget.status, 409, 'Idempotency-Key sama dengan target berbeda harus ditolak 409');

            // Without Idempotency-Key -> legacy behavior
            const resNoKey = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 21, targetGameId: '333444' })
            });
            assert.strictEqual(resNoKey.status, 201);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (4): POST /api/deposit/request — header Idempotency-Key (UUID) 200 idempotent:true & 409 jika payload beda', async () => {
        const token = makeUserToken(9203, 'User');
        let forcedPendingCount = 0;
        const db = createTransactionalMockDb(
            [{ id: 9203, username: 'dep_sec9', balance: 0, role_id: 1, role_name: 'User' }],
            [],
            { pendingDepositCountOverride: () => forcedPendingCount }
        );
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        const depKey = '550e8400-e29b-41d4-a716-446655440002';
        try {
            // Invalid UUID -> 400
            const resBad = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'bukan-uuid'
                },
                body: JSON.stringify({ amount: 50000, method: 'BCA' })
            });
            assert.strictEqual(resBad.status, 400);

            // First deposit request with UUID -> 201
            const res1 = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 50000, method: 'BCA', note: 'topup awal' })
            });
            assert.strictEqual(res1.status, 201);
            const body1 = await res1.json();
            assert.strictEqual(db.deposits.length, 1);

            // Retry even when pending limit reached -> 200 + idempotent:true + exact same deposit
            forcedPendingCount = 2;
            const resRetry = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 50000, method: 'BCA', note: 'topup awal' })
            });
            assert.strictEqual(resRetry.status, 200, 'Retry deposit dengan Idempotency-Key sama harus 200 meski pendingCount = 2');
            const bodyRetry = await resRetry.json();
            assert.strictEqual(bodyRetry.idempotent, true);
            assert.strictEqual(bodyRetry.deposit.id, body1.deposit.id);
            assert.strictEqual(bodyRetry.deposit.amount, body1.deposit.amount);
            assert.strictEqual(bodyRetry.deposit.unique_code, body1.deposit.unique_code);
            assert.strictEqual(bodyRetry.deposit.paymentInstructions, body1.deposit.paymentInstructions);
            assert.strictEqual(db.deposits.length, 1, 'Deposit ganda tidak boleh dibuat');

            // Same UUID with different amount or method -> 409
            const resDiffAmount = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 75000, method: 'BCA', note: 'topup awal' })
            });
            assert.strictEqual(resDiffAmount.status, 409);

            const resDiffMethod = await fetch(`${baseUrl}/api/deposit/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': depKey
                },
                body: JSON.stringify({ amount: 50000, method: 'QRIS', note: 'topup awal' })
            });
            assert.strictEqual(resDiffMethod.status, 409);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
        }
    });
});
