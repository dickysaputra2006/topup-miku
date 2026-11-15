const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
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

    test('SEC-009 (5): race paralel Promise.all dengan ref_id/Idempotency-Key sama menangani 23505 via ROLLBACK + re-read', async () => {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const userToken = makeUserToken(9205, 'User');

        const raceH2hRef = 'RACE-REF-99';
        const raceOrderKey = '550e8400-e29b-41d4-a716-446655440088';
        const raceDepKey = '550e8400-e29b-41d4-a716-446655440099';

        // Barrier per skenario agar 2 request paralel sama-sama lolos pre-check dan tx #2 menunggu tx #1 COMMIT sebelum 23505
        const createRaceBarrier = (constraintName) => {
            let arrivals = 0;
            let winnerPicked = false;
            let releaseArrivalBarrier;
            const arrivalBarrierReady = new Promise((resolve) => { releaseArrivalBarrier = resolve; });
            let resolveWinnerCommitted;
            const winnerCommitted = new Promise((resolve) => { resolveWinnerCommitted = resolve; });
            return {
                waitAndCollide: async () => {
                    arrivals++;
                    if (arrivals === 2) releaseArrivalBarrier();
                    await arrivalBarrierReady;
                    if (!winnerPicked) {
                        winnerPicked = true;
                        return;
                    }
                    await winnerCommitted;
                    const err23505 = new Error(`duplicate key value violates unique constraint "${constraintName}"`);
                    err23505.code = '23505';
                    err23505.constraint = constraintName;
                    throw err23505;
                },
                notifyCommitted: () => resolveWinnerCommitted()
            };
        };

        const h2hBarrier = createRaceBarrier('uq_transactions_user_ref_id');
        const orderBarrier = createRaceBarrier('uq_transactions_user_ref_id');
        const depBarrier = createRaceBarrier('uq_deposits_user_idempotency_key');

        const db = createTransactionalMockDb(
            [
                {
                    id: 9204, username: 'race_h2h', balance: 100000, role_id: 2, role_name: 'PARTNER',
                    api_key: null, api_key_hash: apiKeyHash, whitelisted_ips: []
                },
                {
                    id: 9205, username: 'race_dep', balance: 50000, role_id: 1, role_name: 'User'
                }
            ],
            [{
                id: 31, name: 'Race Item', provider_sku: 'RACE-SKU', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, validation_config: null,
                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
            }],
            {
                beforeTxInsert: async (params) => {
                    if (params[8] === raceH2hRef) return h2hBarrier.waitAndCollide();
                    if (params[8] === raceOrderKey) return orderBarrier.waitAndCollide();
                },
                beforeDepositInsert: async () => depBarrier.waitAndCollide(),
                onCommit: (committed) => {
                    if (committed.transactions.some((t) => t.ref_id === raceH2hRef)) {
                        h2hBarrier.notifyCommitted();
                    }
                    if (committed.transactions.some((t) => t.ref_id === raceOrderKey)) {
                        orderBarrier.notifyCommitted();
                    }
                    if (committed.deposits.some((d) => d.idempotency_key === raceDepKey)) {
                        depBarrier.notifyCommitted();
                    }
                }
            }
        );

        let foxyCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: { data: [{ product_code: 'RACE-SKU', product_price: 9000 }] }
        });
        axios.post = async () => {
            foxyCalls++;
            return { data: { status: true } };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // 1. Race 2 paralel POST /h2h/order dengan ref_id identik
            const [resA, resB] = await Promise.all([
                fetch(`${baseUrl}/h2h/order`, {
                    method: 'POST',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 31, targetGameId: '554433', ref_id: raceH2hRef })
                }),
                fetch(`${baseUrl}/h2h/order`, {
                    method: 'POST',
                    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productId: 31, targetGameId: '554433', ref_id: raceH2hRef })
                })
            ]);

            const statuses = [resA.status, resB.status].sort((a, b) => a - b);
            assert.deepStrictEqual(statuses, [200, 201], 'Salah satu paralel H2H harus 201 dan satunya 200 idempotent');
            const bodyA = await resA.json();
            const bodyB = await resB.json();
            assert.strictEqual(bodyA.data.invoiceId, bodyB.data.invoiceId, 'Kedua response paralel H2H harus mengembalikan invoiceId sama');
            assert.strictEqual([bodyA.idempotent === true, bodyB.idempotent === true].filter(Boolean).length, 1, 'Tepat satu response H2H bertanda idempotent:true');
            assert.strictEqual(db.transactions.filter((t) => t.user_id === 9204).length, 1, 'Harus tercipta tepat 1 transaksi H2H di DB');
            assert.strictEqual(db.balanceHistory.filter((h) => h.user_id === 9204).length, 1, 'Ledger mutasi H2H hanya boleh punya 1 baris Purchase');
            assert.strictEqual(db.users.get(9204).balance, 89000, 'Saldo H2H hanya boleh terpotong 1x (100000 - 11000)');
            assert.strictEqual(foxyCalls, 1, 'Provider Foxy hanya boleh dipanggil 1x untuk H2H race');
            assert.ok(db.getRollbackCount() >= 1, 'Request H2H yang kalah race 23505 wajib melakukan ROLLBACK');

            // 2. Race 2 paralel POST /api/order dengan Idempotency-Key identik
            const [ordResA, ordResB] = await Promise.all([
                fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceOrderKey
                    },
                    body: JSON.stringify({ productId: 31, targetGameId: '667788' })
                }),
                fetch(`${baseUrl}/api/order`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceOrderKey
                    },
                    body: JSON.stringify({ productId: 31, targetGameId: '667788' })
                })
            ]);

            assert.deepStrictEqual([ordResA.status, ordResB.status].sort((a, b) => a - b), [200, 201], 'Salah satu paralel /api/order harus 201 dan satunya 200 idempotent');
            const ordBodyA = await ordResA.json();
            const ordBodyB = await ordResB.json();
            assert.strictEqual(ordBodyA.invoiceId, ordBodyB.invoiceId, 'Kedua response paralel /api/order harus mengembalikan invoiceId sama');
            assert.strictEqual([ordBodyA.idempotent === true, ordBodyB.idempotent === true].filter(Boolean).length, 1, 'Tepat satu response /api/order bertanda idempotent:true');
            assert.strictEqual(db.transactions.filter((t) => t.user_id === 9205).length, 1, 'Harus tercipta tepat 1 transaksi /api/order di DB');
            assert.strictEqual(db.balanceHistory.filter((h) => h.user_id === 9205).length, 1, 'Ledger mutasi /api/order hanya boleh punya 1 baris Purchase');
            assert.ok(db.users.get(9205).balance < 50000 && db.users.get(9205).balance >= 39000, `Saldo /api/order hanya boleh terpotong 1x, aktual=${db.users.get(9205).balance}`);
            assert.strictEqual(foxyCalls, 2, 'Provider Foxy hanya boleh dipanggil 1x lagi untuk /api/order race');
            assert.ok(db.getRollbackCount() >= 2, 'Request /api/order yang kalah race 23505 wajib melakukan ROLLBACK');

            // 3. Race 2 paralel POST /api/deposit/request dengan Idempotency-Key identik
            const [depResA, depResB] = await Promise.all([
                fetch(`${baseUrl}/api/deposit/request`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceDepKey
                    },
                    body: JSON.stringify({ amount: 50000, method: 'QRIS' })
                }),
                fetch(`${baseUrl}/api/deposit/request`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${userToken}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': raceDepKey
                    },
                    body: JSON.stringify({ amount: 50000, method: 'QRIS' })
                })
            ]);

            assert.deepStrictEqual([depResA.status, depResB.status].sort((a, b) => a - b), [200, 201]);
            const depBodyA = await depResA.json();
            const depBodyB = await depResB.json();
            assert.strictEqual(depBodyA.deposit.id, depBodyB.deposit.id);
            assert.strictEqual([depBodyA.idempotent === true, depBodyB.idempotent === true].filter(Boolean).length, 1, 'Tepat satu response deposit bertanda idempotent:true');
            assert.strictEqual(db.deposits.length, 1, 'Deposit paralel harus menghasilkan tepat 1 baris');
            assert.ok(db.getRollbackCount() >= 3, 'Request deposit yang kalah race 23505 wajib melakukan ROLLBACK');
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (6): invoice_id kriptografis (TRX-/H2H-) unik paralel, lolos validator publik, tolak >64 char, & tersamarkan di recent-transactions', async () => {
        const apiKey = crypto.randomBytes(32).toString('hex');
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const webToken = makeUserToken(9206, 'User');
        const db = createTransactionalMockDb(
            [
                {
                    id: 9206, username: 'web_crypto', balance: 500000, role_id: 1, role_name: 'User'
                },
                {
                    id: 9207, username: 'h2h_crypto', balance: 500000, role_id: 2, role_name: 'PARTNER',
                    api_key: null, api_key_hash: apiKeyHash, whitelisted_ips: []
                }
            ],
            [{
                id: 41, name: 'Crypto Product', provider_sku: 'CRYPTO-SKU', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, validation_config: null,
                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
            }]
        );

        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: { data: [{ product_code: 'CRYPTO-SKU', product_price: 9000 }] }
        });
        axios.post = async () => ({ data: { status: true } });
        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            const webReqs = [1, 2, 3].map((i) => fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${webToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 41, targetGameId: `web_target_${i}` })
            }));
            const h2hReqs = [1, 2, 3].map((i) => fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 41, targetGameId: `h2h_target_${i}`, ref_id: `UNIQ-${i}` })
            }));

            const webResponses = await Promise.all(webReqs);
            const h2hResponses = await Promise.all(h2hReqs);
            const webBodies = await Promise.all(webResponses.map((r) => r.json()));
            const h2hBodies = await Promise.all(h2hResponses.map((r) => r.json()));

            const webInvoices = webBodies.map((b) => b.invoiceId);
            const h2hInvoices = h2hBodies.map((b) => b.data.invoiceId);
            const allInvoices = [...webInvoices, ...h2hInvoices];

            assert.strictEqual(new Set(allInvoices).size, 6, 'Semua invoice paralel harus unik');
            for (const inv of webInvoices) {
                assert.match(inv, /^TRX-[A-F0-9]{16,}$/, `Invoice web baru harus kriptografis: ${inv}`);
                assert.ok(inv.length <= 64, 'Panjang invoice harus <= 64 agar lolos input & validator publik');
            }
            for (const inv of h2hInvoices) {
                assert.match(inv, /^H2H-[A-F0-9]{16,}$/, `Invoice H2H baru harus kriptografis: ${inv}`);
                assert.ok(inv.length <= 64);
            }

            // Semua invoice baru harus lolos GET /api/public/transaction/:invoiceId
            for (const inv of [webInvoices[0], h2hInvoices[0]]) {
                const pubRes = await fetch(`${baseUrl}/api/public/transaction/${encodeURIComponent(inv)}`);
                assert.strictEqual(pubRes.status, 200, `Validator publik harus menerima invoice kriptografis ${inv}`);
                const pubData = await pubRes.json();
                assert.strictEqual(pubData.invoice_id, inv);
            }

            // Invoice >64 karakter harus ditolak 400 (bukan diam-diam dipotong)
            const tooLongRes = await fetch(`${baseUrl}/api/public/transaction/${'TRX-' + 'A'.repeat(65)}`);
            assert.strictEqual(tooLongRes.status, 400, 'Invoice > 64 karakter harus ditolak 400');

            // Tambahkan contoh invoice pendek lama untuk memastikan maskInvoiceId juga menyamarkan suffix <= 8
            db.transactions.push({
                id: 999,
                invoice_id: 'TRX-SAFE-001',
                user_id: 9206,
                product_id: 41,
                target_game_id: 'x',
                price: 10000,
                status: 'Pending',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });

            const recentRes = await fetch(`${baseUrl}/api/public/recent-transactions`);
            assert.strictEqual(recentRes.status, 200);
            const recentList = await recentRes.json();
            assert.ok(recentList.length >= 3);
            for (const item of recentList) {
                assert.ok(item.invoice_masked.includes('****'), `Invoice harus tersamarkan: ${item.invoice_masked}`);
                assert.ok(!allInvoices.includes(item.invoice_masked), 'Invoice lengkap tidak boleh bocor');
                assert.notStrictEqual(item.invoice_masked, 'TRX-SAFE-001', 'Invoice pendek TRX-SAFE-001 pun harus disamarkan');
            }
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });

    test('SEC-009 (7): replay setelah order Failed — POST /api/order tolak 409 dengan pesan jelas agar user tidak terjebak; POST /h2h/order kembalikan 200 status Failed & ref_id baru diproses normal', async () => {
        const webToken = makeUserToken(9207, 'User');
        const h2hApiKey = crypto.randomBytes(32).toString('hex');
        const h2hApiKeyHash = crypto.createHash('sha256').update(h2hApiKey).digest('hex');

        const db = createTransactionalMockDb(
            [
                { id: 9207, username: 'web_fail_replay', balance: 100000, role_id: 1, role_name: 'User' },
                {
                    id: 9208, username: 'h2h_fail_replay', balance: 100000, role_id: 2, role_name: 'PARTNER',
                    api_key: null, api_key_hash: h2hApiKeyHash, whitelisted_ips: []
                }
            ],
            [{
                id: 51, name: 'Fail Replay Item', provider_sku: 'FAIL-SKU', price: 10000, status: 'Active',
                game_id: 1, needs_server_id: false, validation_config: null,
                use_manual_prices: false, manual_prices: {}, use_custom_margin: false
            }]
        );

        let foxyShouldReject = true;
        let foxyCalls = 0;
        invalidateFoxyProductCache();
        axios.get = async () => ({
            data: { data: [{ product_code: 'FAIL-SKU', product_price: 9000 }] }
        });
        axios.post = async () => {
            foxyCalls++;
            if (foxyShouldReject) {
                return { data: { status: false, message: 'Provider explicit reject' } };
            }
            return { data: { status: true } };
        };

        mock.method(pool, 'query', db.poolQuery);
        mock.method(pool, 'connect', db.poolConnect);

        try {
            // 1. Web /api/order: percobaan pertama ditolak provider -> status Failed & saldo kembali
            const webKey1 = '550e8400-e29b-41d4-a716-446655440701';
            const webResFail = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': webKey1
                },
                body: JSON.stringify({ productId: 51, targetGameId: '500600' })
            });
            assert.strictEqual(webResFail.status, 400);
            assert.strictEqual(db.users.get(9207).balance, 100000, 'Saldo web wajib kembali utuh pasca refund kompensasi');
            const webTx = db.transactions.find((t) => t.user_id === 9207);
            assert.strictEqual(webTx.status, 'Failed');

            // Aktifkan provider agar sukses untuk key baru
            foxyShouldReject = false;

            // 2. Replay /api/order dengan Idempotency-Key lama yang statusnya Failed -> 409 + pesan jelas
            const webReplay = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': webKey1
                },
                body: JSON.stringify({ productId: 51, targetGameId: '500600' })
            });
            assert.strictEqual(webReplay.status, 409, 'Replay /api/order atas transaksi Failed wajib ditolak 409 agar UI tidak menganggap sukses');
            const webReplayBody = await webReplay.json();
            assert.strictEqual(webReplayBody.idempotent, true);
            assert.strictEqual(webReplayBody.status, 'Failed');
            assert.strictEqual(webReplayBody.invoiceId, webTx.invoice_id);
            assert.match(webReplayBody.message, /gagal.*pesanan baru/i);
            assert.strictEqual(foxyCalls, 1, 'Replay Failed tidak boleh memanggil Foxy');
            assert.strictEqual(db.users.get(9207).balance, 100000);

            // 3. Web /api/order dengan Idempotency-Key BARU -> diproses normal 201
            const webKey2 = '550e8400-e29b-41d4-a716-446655440702';
            const webResNew = await fetch(`${baseUrl}/api/order`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${webToken}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': webKey2
                },
                body: JSON.stringify({ productId: 51, targetGameId: '500600' })
            });
            assert.strictEqual(webResNew.status, 201, 'Key baru setelah order Failed harus memproses order baru');
            assert.strictEqual(db.users.get(9207).balance, 89000);

            // 4. H2H /h2h/order: percobaan pertama ditolak provider -> Failed & refund
            foxyShouldReject = true;
            const h2hResFail = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '700800', ref_id: 'REF-FAIL-1' })
            });
            assert.strictEqual(h2hResFail.status, 400);
            assert.strictEqual(db.users.get(9208).balance, 100000);
            const h2hTx = db.transactions.find((t) => t.user_id === 9208);
            assert.strictEqual(h2hTx.status, 'Failed');

            // 5. H2H replay ref_id sama -> kembalikan hasil lama (HTTP 200 idempotent:true, data.status='Failed')
            foxyShouldReject = false;
            const h2hReplay = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '700800', ref_id: 'REF-FAIL-1' })
            });
            assert.strictEqual(h2hReplay.status, 200);
            const h2hReplayBody = await h2hReplay.json();
            assert.strictEqual(h2hReplayBody.idempotent, true);
            assert.strictEqual(h2hReplayBody.data.invoiceId, h2hTx.invoice_id);
            assert.strictEqual(h2hReplayBody.data.status, 'Failed');
            assert.strictEqual(db.users.get(9208).balance, 100000);

            // 6. H2H ref_id baru -> diproses normal 201
            const h2hNew = await fetch(`${baseUrl}/h2h/order`, {
                method: 'POST',
                headers: { 'X-API-Key': h2hApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: 51, targetGameId: '700800', ref_id: 'REF-OK-2' })
            });
            assert.strictEqual(h2hNew.status, 201);
            assert.strictEqual(db.users.get(9208).balance, 89000);
        } finally {
            pool.query.mock.restore();
            pool.connect.mock.restore();
            axios.get = origAxiosGet;
            axios.post = origAxiosPost;
        }
    });
});
