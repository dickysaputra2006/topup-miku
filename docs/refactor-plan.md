# Rencana Refactor Struktur Tes Backend (Langkah R1)

Dokumen ini adalah rencana kerja R1 untuk memecah `backend/tests/auth.test.js` (304 baris) dan `backend/tests/security.test.js` (9.074 baris) menjadi modul-modul kecil (`<= 800` baris per file tes) di bawah `backend/tests/unit/`, `backend/tests/integration/`, dan `backend/tests/helpers/`.

> Prinsip utama: **tanpa perubahan perilaku produksi maupun kontrak tes**. Tidak ada file produksi (`backend/server.js`, `backend/utils/*`, `frontend/*`, `migrations/*`) yang diubah pada langkah R1.

---

## 1. Inventaris Ekspor & Import `backend/server.js`

Berdasarkan pemeriksaan kode saat ini, `backend/server.js` hanya memanggil `app.listen(...)` di dalam `startServer()` yang dijaga `if (require.main === module)`, dan mengekspor:

- `app`
- `pool`
- `startServer`
- `server`
- `validateEnvironment`
- `invalidateFoxyProductCache`
- `callbackClock`
- `clearCallbackCooldownCache`

Pemanggil `server.js` di seluruh repositori saat R1 dimulai:

| File | Simbol yang Di-import |
| --- | --- |
| `scripts/dump-routes.js` | `{ app, pool }` |
| `backend/tests/auth.test.js` | `{ pool, startServer }` |
| `backend/tests/security.test.js` | `{ pool, startServer, validateEnvironment, callbackClock, clearCallbackCooldownCache, invalidateFoxyProductCache }` |
| `backend/tests/manual/concurrency.js` | `{ pool, startServer }` |
| `backend/tests/manual/idempotency.js` | `{ pool, startServer, invalidateFoxyProductCache }` |
| `backend/tests/manual/pool.js` | `{ pool, startServer, invalidateFoxyProductCache }` |

---

## 2. Inventaris Mekanisme Mock di Suite Tes

1. **Environment default sebelum `require('../../server.js')`**:
   `PORT = '0'`, `JWT_SECRET = 'test-secret'`, `FOXY_API_KEY = 'test-foxy-key'`, `FOXY_CALLBACK_SECRET = ''`.
2. **PostgreSQL Pool (`pool.query` & `pool.connect`)**:
   Dimock per-suite/per-tes melalui monkey-patch `pool.query` dan `pool.connect`, dan dikembalikan pada `after()` / `afterEach()`.
3. **Cron Pool (`cronUtils.pool`)**:
   Untuk suite cron (`Phase 11`, `Phase 13`, `Phase 15`), `cronUtils.pool.query` dan `cronUtils.pool.connect` di-patch serta dikembalikan pada teardown.
4. **HTTP Client Foxy / Eksternal (`axios.get`, `axios.post`)**:
   Di-monkey-patch di beberapa suite (termasuk `Phase 5B`, `Phase 11`, `SEC-001`, `Phase 13`, `Phase 14`, `Phase 15`) dan dipulihkan pada teardown.
5. **Webhook & DNS (`utils/webhookClient`, `utils/networkSecurity`)**:
   `Phase 13` menggunakan `webhookDns` / `buildSignedWebhookHeaders` / `buildAxiosWebhookConfig` untuk menguji SSRF protection dan signing HMAC-SHA256.
6. **Jam Callback Foxy (`callbackClock`, `clearCallbackCooldownCache`, `validateEnvironment`)**:
   `SEC-001` menyuntikkan `callbackClock.now` dan membersihkan cache cooldown antar tes.
7. **Token Auth & Bot**:
   Token JWT HS256 ditandatangani dengan `'test-secret'`, dan `WA_BOT_ADMIN_TOKEN` dipakai di suite bot admin WA (`Phase 7A`, `Phase 7B`).

---

## 3. Aturan Helper & Pemecahan Suite

- **Aturan `>= 2` file untuk `backend/tests/helpers/`**: hanya helper yang dipakai oleh minimal 2 file tes yang dipindah ke `backend/tests/helpers/`. Helper spesifik 1 suite (`mockAdminAuth`, `mockLeaderboardQuery`, `mockDepositQuery`, `makeFakeClient`, `parseSemver`, dll.) tetap berada di dalam file tesnya masing-masing.
- **Preservasi nama tes 100%**: seluruh 187 `<Suite> :: <Test>` pada `docs/refactor-baseline-tests.txt` dipertahankan persis sama (termasuk saat 1 `describe` besar dipecah ke 2 file agar masing-masing `<= 800` baris, nama string `describe(...)` dipertahankan sama di kedua file).
- **Penyesuaian path relatif**:
  - `../server.js` -> `../../server.js`
  - `../utils/...` -> `../../utils/...`
  - `backendDir = path.join(__dirname, '..')` -> `path.join(__dirname, '../..')`
  - `path.resolve(__dirname, '../../migrations')` -> `path.resolve(__dirname, '../../../migrations')`
- **Tes manual**: `backend/tests/manual/*.js` tidak diubah dan tidak dimasukkan ke `npm test`.

---

## 4. Peta File Target

### A. `backend/tests/helpers/` (dipakai `>= 2` file tes)

| File Target | Isi & Peran |
| --- | --- |
| `backend/tests/helpers/appFactory.js` | Menetapkan env default tes sebelum memuat `../../server.js`, mengekspor `{ pool, startServer, serverMod, axios, cronUtils, cronPool, createServerHarness }` untuk setup `before(() => startServer(0))`, snapshot/restore mock, dan `server.close` di `after()`. |
| `backend/tests/helpers/fixtures.js` | Helper JWT bersama (`TEST_JWT_SECRET`, `makeUserToken`, `makeAdminToken`). |
| `backend/tests/helpers/mockDb.js` | Mengekspor `createTransactionalMockDb` (untuk kedua file tes `SEC-009`) dan `createPhase13MockDb` (untuk kedua file tes `SEC-013`). |

### B. `backend/tests/unit/`

| File Target | Asal Suite | Estimasi Baris |
| --- | --- | --- |
| `backend/tests/unit/normalizePhone.test.js` | `auth.test.js` :: `normalizePhone Unit Tests (Phase 2B)` | ~60 |
| `backend/tests/unit/mobapayEligibility.test.js` | `security.test.js` :: `Phase 5C-2A: Mobapay MLBB Eligibility Engine` (bagian unit murni: engine + helper eligibilitas) | ~100 |

### C. `backend/tests/integration/`

| File Target | Asal Suite | Estimasi Baris |
| --- | --- | --- |
| `backend/tests/integration/auth.test.js` | `auth.test.js` :: `Auth Login Tests` + `Auth Register Tests (Phase 2B)` | ~250 |
| `backend/tests/integration/securityErrorExposure.test.js` | `security.test.js` :: `Security: Error Exposure Tests` | ~475 |
| `backend/tests/integration/publicEndpoints.test.js` | `security.test.js` :: `Public Transaction Endpoints` + `Phase 6A: Public Leaderboard` | ~350 |
| `backend/tests/integration/deposit.test.js` | `security.test.js` :: `Phase 4A: Deposit Endpoints` + `Phase 4C: Deposit Method & Note` | ~530 |
| `backend/tests/integration/adminDeposit.test.js` | `security.test.js` :: `Phase 4B: Admin Deposit Approval` | ~330 |
| `backend/tests/integration/validation.test.js` | `security.test.js` :: `Phase 5B: Game ID Validation in Order Flow` + `Phase 5B-2: Bulk Validation & Name Sanitizer` | ~565 |
| `backend/tests/integration/mobapayValidation.test.js` | `security.test.js` :: `Phase 5C-2A: Mobapay MLBB Eligibility Engine` (bagian endpoint HTTP) | ~460 |
| `backend/tests/integration/waBotDeposits.test.js` | `security.test.js` :: `Phase 7A: WA Bot Admin Deposit Read-Only API` + `Phase 7B: WA Bot Admin Deposit Approve/Reject API` | ~575 |
| `backend/tests/integration/hardeningGuards.test.js` | `security.test.js` :: `Phase 8: Audit 2 Concurrency & Hardening Guards` | ~350 |
| `backend/tests/integration/paymentMethods.test.js` | `security.test.js` :: `Phase 9: Dynamic Payment Methods (Paket 2)` | ~295 |
| `backend/tests/integration/dependencies.test.js` | `security.test.js` :: `Phase 10: SEC-006 Dependency Vulnerability Hardening` | ~160 |
| `backend/tests/integration/orderCompensation.test.js` | `security.test.js` :: `Phase 11: SEC-002 & SEC-003 Compensation, Promo Cost Guard & Cache Hardening` (`(a)`–`(c3)`) | ~620 |
| `backend/tests/integration/orderPriceGuardAndLock.test.js` | `security.test.js` :: `Phase 11: SEC-002 & SEC-003 Compensation, Promo Cost Guard & Cache Hardening` (`(d)`–`(review-3)`) | ~470 |
| `backend/tests/integration/foxyCallback.test.js` | `security.test.js` :: `SEC-001: Foxy Callback Security Hardening` | ~560 |
| `backend/tests/integration/h2hSecurity.test.js` | `security.test.js` :: `Phase 13: SEC-004, SEC-007 & SEC-008: H2H Security Hardening` (`SEC-004`, `SEC-008`) | ~505 |
| `backend/tests/integration/h2hWebhook.test.js` | `security.test.js` :: `Phase 13: SEC-004, SEC-007 & SEC-008: H2H Security Hardening` (`SEC-007`) | ~590 |
| `backend/tests/integration/idempotencyOrders.test.js` | `security.test.js` :: `Phase 14: SEC-009: Idempotency Keys & Cryptographic Invoice IDs` (`(1)`–`(4)`) | ~385 |
| `backend/tests/integration/idempotencyConcurrencyAndRetry.test.js` | `security.test.js` :: `Phase 14: SEC-009: Idempotency Keys & Cryptographic Invoice IDs` (`(5)`–`(7)`) | ~440 |
| `backend/tests/integration/connectionPoolOrders.test.js` | `security.test.js` :: `Phase 15: SEC-013: Connection Pool & 3-Phase Order Flow` (`(1)`–`(3)`) | ~355 |
| `backend/tests/integration/connectionPoolCronAndTimeouts.test.js` | `security.test.js` :: `Phase 15: SEC-013: Connection Pool & 3-Phase Order Flow` (`(4)`–`(5)`) | ~425 |

---

## 5. Rencana Verifikasi Akhir R1

1. Setiap file di bawah `backend/tests/helpers/`, `backend/tests/unit/`, dan `backend/tests/integration/` lolos `node --check <file>` dan `<= 800` baris.
2. `npm run test:unit`, `npm run test:integration`, `npm test`, dan `npm run check` semuanya lolos bersih (`187` pass, `0` fail, `0` skip, tanpa menggantung).
3. Daftar tes terurut (`<Suite> :: <Test>`) sama persis dengan `docs/refactor-baseline-tests.txt` (`diff` kosong).
4. `node scripts/dump-routes.js` menghasilkan output yang identik dengan `docs/routes.baseline.txt` (`diff` kosong).
