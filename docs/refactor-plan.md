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

---

## R2 — Ekstraksi `backend/config/` (Tanpa Perubahan Perilaku)

Prinsip khusus (sesuai arahan):
- **TIDAK menggabungkan pool.** `backend/server.js` dan `backend/utils/cronUtils.js` tetap memakai **DUA** instance `pg.Pool` terpisah seperti sebelumnya; `backend/config/db.js` hanya menyediakan konfigurasi bersama (`dbSslEnabled`, `dbConfig`, `getDbConfig`) dan pabrik `createPool()`.
- Seluruh simbol yang saat ini diekspor `backend/server.js` tetap diekspor ulang agar kontrak dengan test dan helper tetap identik.

### Pemetaan Blok yang Dipindah ke `backend/config/`

1. **`backend/config/env.js`**
   - Sumber `backend/server.js`:
     - Baris `1`: `require('dotenv').config()`
     - Baris `24-28`: `PORT`, `JWT_SECRET`, `REQUIRED_ENV`, `RECOMMENDED_RUNTIME_ENV`
     - Baris `32-42`: `DEFAULT_ALLOWED_ORIGINS`, `ALLOWED_ORIGINS`
     - Baris `44-70`: `validateEnvironment({ strict = false } = {})`
     - Baris `572-573`: `FOXY_API_KEY`, `FOXY_CALLBACK_URL`
2. **`backend/config/db.js`**
   - Sumber `backend/server.js`:
     - Baris `6`: `const { Pool } = require('pg')`
     - Baris `641-654`: `dbSslEnabled`, `dbConfig`, pembuatan `new Pool(dbConfig)` -> diekstrak menjadi `dbSslEnabled`, `dbConfig`, `getDbConfig()`, `createPool(overrides)`
     - Listener `pool.on('connect', ... SET TIME ZONE 'Asia/Jakarta')` (baris `656-658`) tetap berada di `backend/server.js` pada instance `pool` milik `server.js`.
   - Sumber `backend/utils/cronUtils.js`:
     - Baris `2` dan `11-24`: `dbSslEnabled`, `dbConfig`, `new Pool(dbConfig)` diganti memanggil `createPool()` dari `../config/db.js` sehingga tetap menjadi instance `Pool` kedua yang terpisah (dan tetap dapat dimock per modul seperti sebelumnya).
3. **`backend/config/constants.js`**
   - Sumber `backend/server.js`:
     - Baris `29-31`: `BOT_PRODUCT_BLACKLIST`, `MAX_BODY_SIZE`, `DUPLICATE_ORDER_WINDOW_SECONDS`
     - Baris `272-274`: `UUID_REGEX`, `REF_ID_REGEX`, `INVOICE_ID_REGEX`
     - Baris `571, 574, 578`: `FOXY_BASE_URL`, `PROVIDER_TIMEOUT_MS`, `FOXY_CACHE_TTL`
     - Baris `1445`: `ALLOWED_PAYMENT_METHOD_TYPES`
     - Baris `4362-4363`: `CALLBACK_VERIFY_COOLDOWN_MS`, `CALLBACK_SUCCESS_RESPONSE`

---

## R3 — Ekstraksi `backend/middleware/` (Tanpa Perubahan Perilaku)

Prinsip khusus (sesuai arahan):
- **TIDAK** membuat `middleware/errorHandler.js` pada tahap ini (bagian SEC-016).
- **TIDAK** memindahkan middleware auth/IP (`protect`, `softProtect`, `protectAdmin`, `protectH2H`, `protectH2HIp`), karena itu cakupan R4.
- Urutan pemasangan `app.use(...)` di `backend/server.js` dipertahankan persis sama agar tumpukan middleware dan `docs/routes.baseline.txt` tetap 100% identik.
- Helper `normalizeString` (baris `125`) dan `hashApiKey` (baris `198`) disuntikkan ke `createRateLimiters({ normalizeString, hashApiKey })` untuk menghindari duplikasi maupun ketergantungan sirkular.

### Pemetaan Blok yang Dipindah ke `backend/middleware/`

1. **`backend/middleware/securityHeaders.js`**
   - Sumber `backend/server.js`:
     - Baris `8`: `cors`
     - Baris `618-626`: `securityHeaders` (header `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-XSS-Protection`, `Content-Security-Policy`)
     - Baris `627-632`: `corsMiddleware` (menggunakan `ALLOWED_ORIGINS` dari `../config/env.js`)
2. **`backend/middleware/rateLimiters.js`**
   - Sumber `backend/server.js`:
     - Baris `2-3`: `express-rate-limit` & `ipKeyGenerator`
     - Baris `660-721`: `authLimiter`, `registerLimiter`, `checkoutLimiter`, `h2hLimiter`, `h2hUserLimiter`, `apiLimiter`
     - Baris `724-739`: `applyRateLimiters(app)` yang memasang semua `app.use(...)` rate limiter dengan urutan yang sama persis.

---

## Daftar Ekspor `backend/server.js`, Pemakainya, & Audit `readFileSync`

### Simbol yang Diekspor `backend/server.js` (baris `5117`) & Pemakainya
Semua simbol berikut wajib tetap diekspor oleh `backend/server.js`:
- `app` -> `scripts/dump-routes.js` (`{ app, pool }`), `backend/tests/helpers/appFactory.js` (`serverMod` / `server.app`)
- `pool` -> `scripts/dump-routes.js`, `backend/tests/helpers/appFactory.js`, `backend/tests/manual/concurrency.js`, `backend/tests/manual/idempotency.js`, `backend/tests/manual/pool.js`
- `startServer` -> `backend/tests/helpers/appFactory.js`, `backend/tests/manual/concurrency.js`, `backend/tests/manual/idempotency.js`, `backend/tests/manual/pool.js`
- `server` -> `backend/tests/helpers/appFactory.js` (diekspos ulang lewat helper bila diperlukan)
- `validateEnvironment` -> `backend/tests/helpers/appFactory.js` (dipanggil oleh unit/integration tests; tetap diekspor ulang dari `config/env.js`)
- `invalidateFoxyProductCache` -> `backend/tests/helpers/appFactory.js`, `backend/tests/integration/h2hSecurity.test.js`, `backend/tests/integration/orderPriceGuardAndLock.test.js`, `backend/tests/manual/idempotency.js`, `backend/tests/manual/pool.js`
- `callbackClock` -> `backend/tests/helpers/appFactory.js`
- `clearCallbackCooldownCache` -> `backend/tests/helpers/appFactory.js`

### Tes yang Membaca `backend/server.js` sebagai Teks (`readFileSync`)
- **0 file tes** di `backend/tests/` maupun `scripts/` membaca `backend/server.js` sebagai teks menggunakan `fs.readFileSync` (hanya `dependencies.test.js` yang membaca `package.json`/`package-lock.json`, dan `idempotencyOrders.test.js` yang membaca `migrations/011_*.sql`).
