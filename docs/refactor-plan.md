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

---

## R4 — Ekstraksi Helper Murni (`utils/`) & Middleware Auth (`middleware/auth.js`, `middleware/h2hAuth.js`)

Catatan baseline layer:
- `layers.baseline` diturunkan dari `adfc68b`; satu-satunya selisih terhadap `HEAD` adalah nama fungsi (`<anonymous>` -> `securityHeaders`) akibat R3, urutan dan perilaku identik.

### Peta Pemindahan Commit 2 (`backend/utils/` — Helper Murni Tanpa Efek Samping DB/Network/Cache)

| File Tujuan | Fungsi | Baris Asal `server.js` | Pemanggil Utama |
|---|---|---|---|
| `backend/utils/logger.js` | `redactSensitiveText`, `safeErrorDetail`, `logSafeError`, `safeAxiosError` | `44-95` | `server.js` (seluruh catch/provider logs), `auth.js`, `h2hAuth.js` |
| `backend/utils/strings.js` | `normalizeString`, `normalizePhone`, `normalizeProfilePhone`, `escapeHtml`, `publicStatusLabel`, `maskInvoiceId`, `maskLeaderboardName`, `leaderboardRankLabel`, `formatRupiahBot` | `97-100`, `121-164`, `1305-1312`, `3255-3278`, `3362-3384`, `3495-3497` | `rateLimiters.js`, `h2hAuth.js`, endpoint auth/user/public/bot di `server.js` |
| `backend/utils/crypto.js` | `hashResetToken`, `hashApiKey`, `timingSafeStringEqual` (versi aktif `4229-4240`, hapus duplikat `174-180`), `generateInvoiceId`, `generateProviderTrxId` | `166-180`, `245-251`, `4229-4240` | `rateLimiters.js`, `h2hAuth.js`, endpoint auth/user/order/callback di `server.js` |
| `backend/utils/validation.js` | `isValidEmail`, `isValidPassword`, `isValidApiKey`, `parsePositiveQuota`, `isValidPriceAmount`, `isValidInvoiceId`, `parseOptionalRefId`, `parseOptionalIdempotencyKeyHeader`, `isSafeAssetUrl`, `parseOptionalBoolean`, `parseOptionalText`, `sanitizeValidationServiceName` | `102-108`, `182-196`, `253-286`, `1314-1342`, `2643-2655` | `h2hAuth.js`, `normalizePaymentMethodPayload`, endpoint auth/order/deposit/admin/public di `server.js` |

- `backend/middleware/rateLimiters.js` (`createRateLimiters`) memakai default import dari `utils/strings.js` (`normalizeString`) dan `utils/crypto.js` (`hashApiKey`).
- Ekspor `backend/server.js` tidak berubah.

### Peta Pemindahan Commit 3 (`backend/middleware/auth.js`, `backend/middleware/h2hAuth.js`)

| File Tujuan | Fungsi | Baris Asal `server.js` | Pemanggil Utama |
|---|---|---|---|
| `backend/middleware/auth.js` (`createAuthMiddleware({ pool })`) | `protect`, `protectAdmin`, `softProtect` | `790-836` | Route `/api/user/*`, `/api/deposit/*`, `/api/order`, `/api/products`, `/api/admin/*` di `server.js` |
| `backend/middleware/h2hAuth.js` (`createH2HAuthMiddleware({ pool })`) | `protectH2H`, `protectH2HIp` | `838-944` | Route `/h2h/balance`, `/h2h/products`, `/h2h/order`, `/h2h/status/:invoiceId`, `/h2h/profile` di `server.js` |

- Keduanya menerima objek `pool` yang sama dari `backend/server.js` (tidak pernah me-`require('../server')` agar bebas siklus dan kompatibel dengan mock `pool.query` pada seluruh suite tes).

---

## R5 — Ekstraksi Route Publik & Route User (`routes/public.routes.js`, `routes/user.routes.js`)

Prinsip kerja:
- Nol perubahan perilaku; handler, SQL, kode status HTTP, dan pesan error dipindahkan apa adanya (`router.get('/api/...', ...)` menuliskan path penuh tanpa memisah prefix).
- Dilarang `require('../server')`; seluruh dependensi eksternal (`pool`, `protect`) disuntikkan melalui parameter factory.
- Semua file menggunakan LF murni (`\n`), dan setelah tiap commit diverifikasi dengan `npm run check`, `npm test`, `node scripts/check-route-overlap.js`, kesetaraan himpunan 87 route dengan `docs/routes.baseline.txt`, serta `git ls-files --eol`.

### Commit 0 — Penguatan Alat Verifikasi & Bukti R4
- Audit `timingSafeStringEqual` (`92492f4` baris `174-180` vs definisi aktif `4229-4240` di `backend/utils/crypto.js`) serta penambahan unit test [crypto.test.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/tests/unit/crypto.test.js) karena sebelumnya belum ada di `backend/tests/unit/`.
- Verifikasi ulang `middleware/auth.js` dan `middleware/h2hAuth.js` terhadap `92492f4` (`process.env.NODE_ENV` dibaca per-request pada `protectH2HIp`; fungsi yang diekspor memiliki nama eksplisit).
- Uji perataan nested `express.Router()` pada `scripts/dump-routes.js --layers` menggunakan skrip sementara di `%TEMP%`.
- Tambah `scripts/check-route-overlap.js` untuk memvalidasi himpunan route identik (87 route), daftar middleware per route identik setelah diratakan, dan mendeteksi pasangan route bermetode sama yang berubah urutan serta berpotensi mencocokkan URL yang sama.

### Pemetaan Commit 1 — `backend/routes/public.routes.js` (`createPublicRoutes({ pool })`)

Dipasang di `backend/server.js` dengan `app.use(createPublicRoutes({ pool }))` pada posisi route pertama yang dipindah (`GET /healthz`, setelah inisialisasi `pool` dan sebelum `applyRateLimiters(app)`).

| Route | Baris Asal `server.js` | Dependensi |
|---|---|---|
| `GET /healthz` | `424-426` | `-` |
| `GET /api/games` | `2271-2280` | `pool` |
| `GET /api/games/validatable` | `2282-2300` | `fs.promises`, `path`, `sanitizeValidationServiceName` (`utils/validation.js`) |
| `GET /api/games/:gameId/servers` | `2555-2566` | `pool` |
| `GET /api/public/compare-prices` | `2568-2623` | `pool` |
| `GET /api/public/flash-sales` | `2777-2807` | `pool` |
| `GET /api/public/bot-products/:gameName` | `2809-2847` | `pool` |
| `GET /api/public/bot-games` | `2849-2875` | `pool`, `BOT_PRODUCT_BLACKLIST` (`config/constants.js`) |
| `GET /api/public/transaction/:invoiceId` | `2880-2919` | `pool`, `isValidInvoiceId`, `publicStatusLabel`, `logSafeError` |
| `GET /api/public/recent-transactions` | `2922-2950` | `pool`, `maskInvoiceId`, `publicStatusLabel`, `logSafeError` |
| `GET /api/public/leaderboard` | `2955-3009` | `pool`, `maskLeaderboardName`, `leaderboardRankLabel`, `logSafeError` |

Catatan path aset JSON di `GET /api/games/validatable`: karena `public.routes.js` berada di `backend/routes/`, pembacaan `data_cekid.json` disesuaikan dari `path.resolve(__dirname, 'utils', ...)` menjadi `path.resolve(__dirname, '..', 'utils', 'validators', 'data_cekid.json')`.

**Route publik/validasi yang sengaja ditinggal di `server.js` pada R5:**
- `POST /api/products/:productId/validate` (`2331-2407`) — memakai alur validasi game ID (`validateGameId`, R7).
- `POST /api/full-validate` (`2408-2458`) — memakai `validateGameId` & cek validasi ID (R7).
- `GET /api/games/:gameId/products` (`2459-2554`) — memakai `softProtect` dan kalkulasi harga/margin/flash sale (R7 `priceService`).
- `POST /api/promos/validate` (`2625-2775`) — memakai `protect` dan evaluasi eligibilitas promo/order (R7).

### Pemetaan Commit 2 — `backend/routes/user.routes.js` (`createUserRoutes({ pool, protect })`)

Dipasang di `backend/server.js` dengan `app.use(createUserRoutes({ pool, protect }))` pada posisi route pertama yang dipindah (`GET /api/user/profile`).

| Route | Baris Asal `server.js` | Dependensi |
|---|---|---|
| `GET /api/user/profile` | `643-653` | `protect`, `pool` |
| `PUT /api/user/profile` | `654-691` | `protect`, `pool`, `normalizeString`, `normalizeProfilePhone`, `isValidEmail`, `logSafeError` |
| `PUT /api/user/password` | `692-709` | `protect`, `pool`, `bcrypt` |
| `GET /api/user/balance-history` | `710-720` | `protect`, `pool` |
| `GET /api/user/transactions` | `834-855` | `protect`, `pool` |
| `GET /api/user/transaction/:invoiceId` | `856-893` | `protect`, `pool`, `isValidInvoiceId` |
| `GET /api/user/transaction-summary` | `894-912` | `protect`, `pool` |
| `GET /api/user/notifications` | `914-924` | `protect`, `pool` |
| `GET /api/user/notifications/unread-count` | `927-937` | `protect`, `pool` |
| `POST /api/user/notifications/mark-as-read` | `940-947` | `protect`, `pool` |

**Route `/api/user/*` yang sengaja ditinggal di `server.js` pada R5:**
- `POST /api/user/generate-apikey`, `POST /api/user/apikey/regenerate`, `GET /api/user/apikey`, `DELETE /api/user/apikey`, `POST /api/user/apikey/revoke`, `GET /api/user/webhook-secret`, `POST /api/user/webhook-secret/rotate`, `GET /api/user/whitelisted-ips`, `PUT /api/user/whitelisted-ips` (`721-1084`) — bagian grup manajemen H2H/auth pada R6.
- `GET /api/user/deposits` (`1267-1284`) — bagian grup deposit pada R6.

### Pembersihan Commit 3
- Audit import di `backend/server.js` yang tidak lagi digunakan setelah Commit 1 & 2 (`publicStatusLabel`, `maskInvoiceId`, `maskLeaderboardName`, `leaderboardRankLabel`, `sanitizeValidationServiceName`, `BOT_PRODUCT_BLACKLIST`, dll. — dicek satu per satu agar hanya yang benar-benar tak dipakai yang dihapus).
- Perbarui `backend/package.json` `check` agar mencakup direktori `routes`.
- Catat hasil akhir panjang `server.js` dan hasil verifikasi pada bagian akhir dokumen ini.

### Hasil Akhir R5
- Panjang `backend/server.js`: `4520` baris (akhir R4) -> `4183` baris (Commit 1: `routes/public.routes.js` = `368` baris) -> `3993` baris (Commit 2: `routes/user.routes.js` = `222` baris) -> `3984` baris (Commit 3: pembersihan import tak terpakai).
- Import tak terpakai yang dihapus di Commit 3: `BOT_PRODUCT_BLACKLIST`, `normalizeProfilePhone`, `publicStatusLabel`, `maskInvoiceId`, `maskLeaderboardName`, `leaderboardRankLabel`, `isValidInvoiceId`, `sanitizeValidationServiceName`, `net`, `sendH2HWebhook`.
- Skrip `backend/package.json` `check` diperbarui agar memeriksa `routes` dan `../scripts/check-route-overlap.js`.
- Hasil verifikasi akhir: `npm run check` lulus, `npm test` = `192` lulus (`187` patokan R0 + `5` unit test `timingSafeStringEqual` di `tests/unit/crypto.test.js`, `0` gagal, `0` dilewati), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=260, overlap_conflicts=0`.

---

## R6a — Pemeriksa Rantai Efektif + Ekstraksi `auth.routes.js`, `userApiKey.routes.js`, & `waBot.routes.js`

Catatan pembaruan patokan tes:
- [refactor-baseline-tests.txt](file:///d:/DICKY%20BELAJAR/topup-miku/docs/refactor-baseline-tests.txt) diperbarui secara resmi dari `187` menjadi **`192`** tes dengan menambahkan 5 unit test `crypto Unit Tests: timingSafeStringEqual` hasil R5 Commit 0.

### Commit 0 — Pemeriksa Rantai Middleware Efektif
- `scripts/dump-routes.js` & `scripts/check-route-overlap.js` diperluas agar untuk setiap route (`METHOD path`) menghitung daftar berurutan layer `USE`/`ERR` global yang mount path-nya cocok dan terpasang sebelum route tersebut, digabung dengan middleware inline route.
- Baseline rantai efektif (`docs/effective-chain.baseline.txt`) diturunkan dari commit `adfc68b` memakai metode `git archive adfc68b` + `mklink /J` di `%TEMP%\miku-base` tanpa `npm install` maupun menyalin `.env`.
- Selisih nama murni `<anonymous> -> <nama fungsi>` (misalnya `<anonymous> -> securityHeaders` akibat R3) dicatat sebagai selisih yang diketahui; perubahan urutan, penambahan/penghilangan limiter, atau selisih nama lainnya menggagalkan pemeriksaan dengan exit code non-nol.

### Pemetaan Commit 1 — `backend/routes/auth.routes.js` (`createAuthRoutes({ pool })`)

Dipasang di `backend/server.js` dengan `app.use(createAuthRoutes({ pool }))` **tepat setelah `applyRateLimiters(app)`** pada posisi `POST /api/auth/register` agar `authLimiter` dan `registerLimiter` tetap berada pada rantai efektif setiap route auth.

| Route | Baris Asal `server.js` | Dependensi |
|---|---|---|
| `POST /api/auth/register` | `430-496` | `pool`, `bcrypt`, `logSafeError`, `normalizeString`, `normalizePhone`, `isValidEmail`, `isValidPassword` |
| `POST /api/auth/login` | `498-515` | `pool`, `bcrypt`, `jwt`, `JWT_SECRET`, `logSafeError`, `normalizeString` |
| `POST /api/auth/forgot-password` | `517-557` | `pool`, `crypto`, `sendPasswordResetEmail`, `logSafeError`, `normalizeString`, `hashResetToken`, `isValidEmail` |
| `POST /api/auth/reset-password` | `559-615` | `pool`, `bcrypt`, `logSafeError`, `hashResetToken`, `isValidPassword` |

### Pemetaan Commit 2 — `backend/routes/userApiKey.routes.js` (`createUserApiKeyRoutes({ pool, protect })`)

Dipasang di `backend/server.js` dengan `app.use(createUserApiKeyRoutes({ pool, protect }))` tepat setelah `app.use(createUserRoutes({ pool, protect }))`. Fungsi internal `handleGenerateOrRegenerateApiKey` (`636-669`) dan `handleRevokeApiKey` (`671-687`) ikut dipindah utuh dengan nama yang sama agar nama handler di `dump-routes` tetap identik.

| Route | Baris Asal `server.js` | Dependensi |
|---|---|---|
| `POST /api/user/generate-apikey` | `689` | `protect`, `handleGenerateOrRegenerateApiKey` |
| `POST /api/user/apikey/regenerate` | `690` | `protect`, `handleGenerateOrRegenerateApiKey` |
| `GET /api/user/apikey` | `692-711` | `protect`, `pool`, `logSafeError` |
| `DELETE /api/user/apikey` | `713` | `protect`, `handleRevokeApiKey` |
| `POST /api/user/apikey/revoke` | `714` | `protect`, `handleRevokeApiKey` |
| `GET /api/user/webhook-secret` | `716-731` | `protect`, `pool`, `logSafeError` |
| `POST /api/user/webhook-secret/rotate` | `733-748` | `protect`, `pool`, `crypto`, `logSafeError` |
| `GET /api/user/whitelisted-ips` | `750-762` | `protect`, `pool` |
| `PUT /api/user/whitelisted-ips` | `765-785` | `protect`, `pool`, `normalizeString`, `isValidIpOrCidr` |

**Route `/api/user/*` yang sengaja ditinggal di `server.js` pada R6a:**
- `GET /api/user/deposits` (`1067-1084`) — bagian grup deposit (R6b) bersama `/api/payment-methods`, `/api/deposit/request`, dan `/api/admin/deposits*`.

### Pemetaan Commit 3 — `backend/middleware/waBotAuth.js` & `backend/routes/waBot.routes.js`

- `backend/middleware/waBotAuth.js`: mengekspor `requireWaBotAdminToken` (`2486-2521`), tetap membaca `process.env.WA_BOT_ADMIN_TOKEN` pada saat request dan memakai `crypto.timingSafeEqual`.
- `backend/routes/waBot.routes.js` (`createWaBotRoutes({ pool, createNotification, requireWaBotAdminToken })`): dipasang pada posisi `GET /api/bot/admin/deposits/pending` (setelah `requireWaBotAdminToken` dipindah). Logika approve/reject dipindah utuh apa adanya tanpa digabung dengan admin approve.

| Route | Baris Asal `server.js` | Dependensi |
|---|---|---|
| `GET /api/bot/admin/deposits/pending` | `2526-2576` | `requireWaBotAdminToken`, `pool`, `formatRupiahBot`, `logSafeError` |
| `GET /api/bot/admin/deposits/:id` | `2580-2630` | `requireWaBotAdminToken`, `pool`, `formatRupiahBot`, `logSafeError` |
| `POST /api/bot/admin/deposits/:id/approve` | `2637-2741` | `requireWaBotAdminToken`, `pool`, `createNotification`, `formatRupiahBot`, `logSafeError` |
| `POST /api/bot/admin/deposits/:id/reject` | `2746-2822` | `requireWaBotAdminToken`, `pool`, `createNotification`, `formatRupiahBot`, `logSafeError` |

**Route lainnya yang sengaja ditinggal pada R6a:**
- Grup deposit (`/api/payment-methods`, `/api/deposit/request`, `/api/user/deposits`), seluruh grup `/api/admin/*`, route validasi/promo/produk (`R7`), serta alur order/callback/H2H (`R9`) tetap di `server.js` sesuai urutan tahap refactor.

### Pembersihan Commit 4
- Audit dan hapus import yang tidak lagi dipakai di `backend/server.js` (`hashResetToken`, `normalizePhone`, dll. — dicek satu per satu), verifikasi `backend/package.json` `check`, dan catat hasil akhir R6a di `docs/refactor-plan.md`.

### Hasil Akhir R6a
- Panjang `backend/server.js`: `3984` baris (akhir R5) -> `3800` baris (Commit 1: `routes/auth.routes.js` = `211` baris) -> `3651` baris (Commit 2: `routes/userApiKey.routes.js` = `175` baris) -> `3307` baris (Commit 3: `middleware/waBotAuth.js` = `51` baris, `routes/waBot.routes.js` = `330` baris) -> `3295` baris (Commit 4: penghapusan `12` import tak terpakai).
- Import tak terpakai yang dihapus di Commit 4: `JWT_SECRET`, `normalizePhone`, `formatRupiahBot`, `hashResetToken`, `hashApiKey`, `isValidEmail`, `isValidPassword`, `bcrypt`, `jwt`, `crypto`, `sendPasswordResetEmail`, `isValidIpOrCidr`.
- Skrip `check` pada `backend/package.json` sudah mencakup direktori `middleware`, `routes`, serta `../scripts/dump-routes.js` dan `../scripts/check-route-overlap.js`.
- Hasil verifikasi akhir: `npm run check` lulus, `npm test` = `192` lulus (`0` gagal, `0` dilewati; diff terhadap `docs/refactor-baseline-tests.txt` = `0`), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=260, overlap_conflicts=0, effective_chains=87/87, known_anonymous_renames=[USE(/): <anonymous> -> securityHeaders (87 routes)]`.

---

## R6b — Ekstraksi Route Deposit User & Admin Keuangan (`deposit`, `admin/deposits`, `admin/balance`, `admin/transactions`)

Prinsip kerja:
- Nol perubahan perilaku: SQL, urutan query, row lock (`SELECT ... FOR UPDATE`), kondisi status, catatan ledger `balance_history`, pesan error, kode status HTTP, dan urutan pemasangan middleware dipertahankan persis apa adanya.
- Logika approve/reject admin pada `admin/deposits.routes.js` dipindahkan utuh tanpa disatukan dengan `waBot.routes.js`.
- Baseline tes tetap **`192`** sesuai `docs/refactor-baseline-tests.txt`; semua file memakai LF murni (`i/lf w/lf`).

### Inventaris Route Sisa di `backend/server.js` Saat Memulai R6b (`3295` baris)

#### A. Grup yang Dipindah di R6b

1. **Commit 1 — `backend/routes/deposit.routes.js` (`createDepositRoutes({ pool, protect })`)**
   Dipasang di posisi route pertama yang dipindah (`GET /api/payment-methods`, tepat setelah `createUserApiKeyRoutes`). Tidak ada konfigurasi upload/multer bukti deposit di backend.

   | Route / Helper | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `GET /api/payment-methods` | `542-555` | `protect`, `pool` |
   | `POST /api/deposit/request` | `557-721` | `protect`, `pool`, `parseOptionalIdempotencyKeyHeader` (`utils/validation.js`), serta 4 helper khusus deposit |
   | `GET /api/user/deposits` | `724-738` | `protect`, `pool` |
   | Helper khusus deposit: `findDepositByIdempotencyKey`, `matchesDepositIdempotencyPayload`, `buildDepositPaymentInstructions`, `buildDepositResponsePayload` | `186-256` | `escapeHtml` (`utils/strings.js`) — hanya dipakai oleh `POST /api/deposit/request`, ikut dipindah |

   Catatan helper yang tetap di `server.js`: `parseOptionalIdempotencyKeyHeader` tetap di `utils/validation.js` dan masih di-import di `server.js` karena juga dipakai `POST /api/order`.

2. **Commit 2 — `backend/routes/admin/deposits.routes.js` (`createAdminDepositsRoutes({ pool, protectAdmin, createNotification })`)**
   Dipasang di posisi `GET /api/admin/deposits`.

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `GET /api/admin/deposits` | `742-773` | `protectAdmin`, `pool` |
   | `GET /api/admin/deposits/pending` | `776-791` | `protectAdmin`, `pool` |
   | `POST /api/admin/deposits/approve` | `794-859` | `protectAdmin`, `pool`, `createNotification` |
   | `POST /api/admin/deposits/reject` | `862-907` | `protectAdmin`, `pool`, `createNotification` |

   Catatan helper tetap di `server.js`: `createNotification` (`428-438`) masih dipakai oleh `/api/foxy/callback` (`2760, 2767, 2776`), `waBot.routes.js`, dan `admin/transactions.routes.js`, sehingga dioper lewat factory.

3. **Commit 3 — `backend/routes/admin/balance.routes.js` (`createAdminBalanceRoutes({ pool, protectAdmin })`)**
   Dipasang di posisi `POST /api/admin/balance/add` (antara `DELETE /api/admin/payment-methods/:id` dan `GET /api/admin/roles`).

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `POST /api/admin/balance/add` | `1027-1048` | `protectAdmin`, `pool` |
   | `POST /api/admin/balance/reduce` | `1049-1072` | `protectAdmin`, `pool` |

4. **Commit 4 — `backend/routes/admin/transactions.routes.js` (`createAdminTransactionsRoutes({ pool, protectAdmin, createNotification, rollbackTransactionResources })`)**
   Dipasang di posisi `GET /api/admin/transactions` (antara `POST /api/admin/sync-products` dan `PUT /api/admin/products/:id/status`).

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `GET /api/admin/transactions` | `1211-1226` | `protectAdmin`, `pool` |
   | `PUT /api/admin/transactions/:invoiceId/resolve` | `1229-1329` | `protectAdmin`, `pool`, `createNotification`, `rollbackTransactionResources`, `normalizeString` (`utils/strings.js`), `logSafeError` (`utils/logger.js`) |

   Catatan helper tetap di `server.js`: `rollbackTransactionResources` masih dipakai oleh `finalizeOrderAfterProviderCall` (`2183`) dan `/api/foxy/callback` (`2764`) hingga R8.

#### B. Route yang Sengaja Ditinggal di `backend/server.js` Setelah R6b

- **R6c (Admin katalog, konfigurasi, & metode pembayaran)**:
  - `GET/POST/PUT/DELETE /api/admin/payment-methods*` (`910-1025`, termasuk helper `normalizePaymentMethodPayload` `446-540`)
  - `GET/PUT /api/admin/roles` (`1073-1105`)
  - `GET/POST /api/admin/games`, `PUT /api/admin/games/:id/status`, `PUT /api/admin/games/:id/needs-server` (`1106-1160`, `1355-1409`)
  - `GET/POST /api/admin/products`, `PUT /api/admin/products/:id/status`, `PUT /api/admin/products/:id/validation`, `PUT /api/admin/products/bulk-validation` + helper `sanitizeValidationConfig` (`1116-1174`, `1330-1354`, `1410-1541`)
  - `POST/GET/PUT /api/admin/promos*` (`1542-1580`)
  - `GET/POST/DELETE /api/admin/flash-sales*` (`1581-1631`)
  - `GET/POST /api/admin/games/:gameId/margins` (`1632-1677`)
  - `GET/POST /api/admin/products/:productId/manual-prices` (`1678-1721`)
  - `POST /api/test` (`1722-1727`), `GET /api/admin/validation-services/pgs-preview` (`1729-1756`)
- **R7 (Validasi ID game, promo, produk publik berharga dinamis, & sinkronisasi Foxy)**:
  - `POST /api/admin/sync-products` (`1175-1210` — menyentuh `syncProductsWithFoxy` / Foxy cache)
  - `POST /api/products/:productId/validate` (`1757-1833`)
  - `POST /api/full-validate` (`1834-1884`)
  - `GET /api/games/:gameId/products` (`1885-1980` — memakai `softProtect` dan kalkulasi harga/margin/flash sale)
  - `POST /api/promos/validate` (`1981-2132` — validasi promo & cek eligibilitas)
- **R9 (Alur order, transaksi H2H, & callback Foxy — menyentuh uang dan provider eksternal)**:
  - `POST /api/order` (`2212-2559`), `POST /api/foxy/callback` (`2636-2831`), `POST /h2h/order` (`2832-3149`), `GET /h2h/products` (`3150-3244`), `PUT /h2h/profile/callback` (`3245-3264`), `GET /h2h/profile` (`3265-3279`) beserta helper order/callback (`64-185`, `258-395`, `2136-2211`, `2560-2635`).

### Pembersihan Commit 5
- Hapus import tak terpakai di `backend/server.js` setelah Commit 1–4 (`escapeHtml` yang hanya dipakai di `buildDepositPaymentInstructions`).
- Perbarui skrip `check` di `backend/package.json` agar juga memeriksa `routes/admin` (`routes/admin/*.js`).
- Perbarui bagian ini dengan hash commit aktual dan jumlah baris akhir setiap file.

### Hasil Akhir R6b
- Panjang `backend/server.js`: `3295` baris (akhir R6a) -> `3028` baris (Commit 1 `721057d`: `routes/deposit.routes.js` = `290` baris) -> `2863` baris (Commit 2 `77a946a`: `routes/admin/deposits.routes.js` = `189` baris) -> `2819` baris (Commit 3 `8610dfd`: `routes/admin/balance.routes.js` = `66` baris) -> `2708` baris (Commit 4 `aeae1bc`: `routes/admin/transactions.routes.js` = `152` baris) -> `2705` baris (Commit 5: pembersihan import tak terpakai).
- Import tak terpakai yang dihapus di Commit 5: `escapeHtml`.
- Skrip `check` pada `backend/package.json` diperbarui agar juga memeriksa direktori `routes/admin`.
- Hasil verifikasi akhir: `npm run check` lulus, `npm test` = `192` lulus (`0` gagal, `0` dilewati; diff terhadap `docs/refactor-baseline-tests.txt` = `0`), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=260, overlap_conflicts=0, effective_chains=87/87, known_anonymous_renames=[USE(/): <anonymous> -> securityHeaders (87 routes)]`.
- Catatan cakupan tes & DB: `tests/manual/*` (`concurrency.js`, `idempotency.js`, `pool.js`) sengaja tidak dijalankan karena R6b tidak mengubah alur order/refund; tidak ada migrasi database pada tahap ini.

---

## R6c — Ekstraksi Route Admin Katalog, Konfigurasi, Promo, Flash Sale, & Margin (`paymentMethods`, `games`, `products`, `promos`, `flashSales`, `margins`)

Prinsip kerja:
- Nol perubahan perilaku: SQL, validasi input, aturan harga/margin/promo/flash-sale, invalidasi cache Foxy, pesan error, kode status HTTP, dan urutan pemasangan middleware dipertahankan persis apa adanya.
- Ekspor [server.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/server.js) (`{ app, pool, startServer, server, validateEnvironment, invalidateFoxyProductCache, callbackClock, clearCallbackCooldownCache }`) dan helper/cache Foxy (`getFoxyProducts`, `invalidateFoxyProductCache`) tetap utuh di `server.js`.
- Baseline tes tetap **`192`** sesuai [refactor-baseline-tests.txt](file:///d:/DICKY%20BELAJAR/topup-miku/docs/refactor-baseline-tests.txt); semua file memakai LF murni (`i/lf w/lf`).

### Inventaris Route Sisa di `backend/server.js` Saat Memulai R6c (`2705` baris)

#### A. Grup yang Dipindah di R6c

1. **Commit 1 — `backend/routes/admin/paymentMethods.routes.js` (`createAdminPaymentMethodsRoutes({ pool, protectAdmin })`)**
   Dipasang di posisi `477` (tepat setelah `createAdminDepositsRoutes`).

   | Route / Helper | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | Helper `normalizePaymentMethodPayload` | `375-469` | `ALLOWED_PAYMENT_METHOD_TYPES` (`config/constants.js`), `isSafeAssetUrl`, `parseOptionalBoolean`, `parseOptionalText` (`utils/validation.js`) — hanya dipakai grup ini, ikut dipindah |
   | `GET /api/admin/payment-methods` | `477-490` | `protectAdmin`, `pool` |
   | `POST /api/admin/payment-methods` | `492-524` | `protectAdmin`, `pool`, `normalizePaymentMethodPayload` |
   | `PUT /api/admin/payment-methods/:id` | `526-575` | `protectAdmin`, `pool`, `normalizePaymentMethodPayload` |
   | `DELETE /api/admin/payment-methods/:id` | `577-592` | `protectAdmin`, `pool` |

2. **Commit 2 — `backend/routes/admin/games.routes.js` (`createAdminGamesRoutes({ pool, protectAdmin })`)**
   Dipasang di posisi `595` (tepat setelah `createAdminBalanceRoutes`). Memakai `require('axios')` langsung agar referensi objek singleton tetap sama dengan mock tes (`pgs-preview`).

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `GET /api/admin/roles` | `595-603` | `protectAdmin`, `pool` |
   | `PUT /api/admin/roles` | `604-627` | `protectAdmin`, `pool` |
   | `GET /api/admin/games` | `628-637` | `protectAdmin`, `pool` |
   | `POST /api/admin/games` | `670-682` | `protectAdmin`, `pool` |
   | `PUT /api/admin/games/:id/status` | `765-789` | `protectAdmin`, `pool` |
   | `PUT /api/admin/games/:id/needs-server` | `790-814` | `protectAdmin`, `pool` |
   | `POST /api/test` | `1132-1135` | *(tanpa auth/deps eksternal)* |
   | `GET /api/admin/validation-services/pgs-preview` | `1139-1163` | `protectAdmin`, `axios`, `process.env.PGS_KEY`, `process.env.PGS_API_KEY` |

3. **Commit 3 — `backend/routes/admin/products.routes.js` (`createAdminProductsRoutes({ pool, protectAdmin })`)**
   Dipasang di posisi blok produk admin (tepat sebelum `POST /api/admin/sync-products`). **Tidak** memindahkan `POST /api/admin/sync-products` (R7). Urutan relatif `/:id/validation` sebelum `/bulk-validation` dipertahankan identik.

   | Route / Helper | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | Helper `sanitizeValidationConfig` | `820-902` | *(fungsi murni, hanya dipakai di `/validation` & `/bulk-validation`, ikut dipindah)* |
   | `GET /api/admin/products` | `638-669` | `protectAdmin`, `pool` |
   | `POST /api/admin/products` | `683-696` | `protectAdmin`, `pool` |
   | `PUT /api/admin/products/:id/status` | `740-764` | `protectAdmin`, `pool` |
   | `PUT /api/admin/products/:id/validation` | `904-922` | `protectAdmin`, `pool`, `sanitizeValidationConfig` |
   | `PUT /api/admin/products/bulk-validation` | `923-951` | `protectAdmin`, `pool`, `sanitizeValidationConfig` |

4. **Commit 4 — `backend/routes/admin/promos.routes.js` (`createAdminPromosRoutes({ pool, protectAdmin })`)**
   Dipasang setelah blok admin sebelumnya. **Tidak** memindahkan `POST /api/promos/validate` (R7).

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `POST /api/admin/promos` | `952-964` | `protectAdmin`, `pool` |
   | `GET /api/admin/promos` | `967-974` | `protectAdmin`, `pool` |
   | `PUT /api/admin/promos/:id/toggle` | `977-988` | `protectAdmin`, `pool` |

5. **Commit 5 — `backend/routes/admin/flashSales.routes.js` (`createAdminFlashSalesRoutes({ pool, protectAdmin })`)**

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `GET /api/admin/flash-sales` | `991-1008` | `protectAdmin`, `pool` |
   | `POST /api/admin/flash-sales` | `1010-1029` | `protectAdmin`, `pool` |
   | `DELETE /api/admin/flash-sales/:id` | `1031-1039` | `protectAdmin`, `pool` |

6. **Commit 6 — `backend/routes/admin/margins.routes.js` (`createAdminMarginsRoutes({ pool, protectAdmin })`)**

   | Route | Baris Asal `server.js` | Dependensi |
   |---|---|---|
   | `GET /api/admin/games/:gameId/margins` | `1042-1056` | `protectAdmin`, `pool` |
   | `POST /api/admin/games/:gameId/margins` | `1059-1085` | `protectAdmin`, `pool` |
   | `GET /api/admin/products/:productId/manual-prices` | `1088-1107` | `protectAdmin`, `pool` |
   | `POST /api/admin/products/:productId/manual-prices` | `1110-1128` | `protectAdmin`, `pool` |

#### B. Route & Helper yang Sengaja Ditinggal di `backend/server.js` Setelah R6c

- **R7 (`5` route validasi, promo publik, produk berharga dinamis, & sinkronisasi Foxy)**:
  - `POST /api/admin/sync-products` (`697-732`) — memanggil `syncProductsWithFoxy` dan `invalidateFoxyProductCache`.
  - `POST /api/products/:productId/validate` (`1167-1241`) — validasi ID game via PGS / `checkMobapayMlbbEligibility`.
  - `POST /api/full-validate` (`1244-1293`) — kombinasi validasi ID game & pengambilan daftar produk Foxy/DB.
  - `GET /api/games/:gameId/products` (`1295-1389`) — memakai `softProtect`, margin role/game/manual, flash sale, dan harga modal real-time Foxy (`getFoxyProducts`).
  - `POST /api/promos/validate` (`1391-1539`) — memakai `protect`, evaluasi aturan promo, flash sale, dan eligibility.
- **R9 (`6` route alur order, transaksi H2H, & callback Foxy — menyentuh uang dan provider eksternal)**:
  - `POST /api/order` (`1622-1963`), `POST /api/foxy/callback` (`2046-2240`), `POST /h2h/order` (`2242-2558`), `GET /h2h/products` (`2560-2651`), `PUT /h2h/profile/callback` (`2655-2673`), `GET /h2h/profile` (`2675-2688`).
- **Helper & ekspor yang tetap di `server.js`**:
  - Seluruh helper order/idempotency/cache/notifikasi/callback (`65-329`, `357-365`, `1546-1620`, `1970-2045`) serta `module.exports` baris `2705` (`{ app, pool, startServer, server, validateEnvironment, invalidateFoxyProductCache, callbackClock, clearCallbackCooldownCache }`).

### Pembersihan Commit 7
- Audit dan hapus import di `backend/server.js` yang tidak lagi digunakan setelah Commit 1–6 (`ALLOWED_PAYMENT_METHOD_TYPES`, `isSafeAssetUrl`, `parseOptionalBoolean`, `parseOptionalText`).
- Perbarui bagian ini dengan hash commit aktual dan jumlah baris akhir tiap file.

### Hasil Akhir R6c
- Panjang `backend/server.js`: `2705` baris (akhir R6b) -> `2493` baris (Commit 1 `cfb3de5`: `routes/admin/paymentMethods.routes.js` = `237` baris) -> `2356` baris (Commit 2 `badd478`: `routes/admin/games.routes.js` = `163` baris) -> `2150` baris (Commit 3 `3591107`: `routes/admin/products.routes.js` = `231` baris) -> `2115` baris (Commit 4 `c34b423`: `routes/admin/promos.routes.js` = `56` baris) -> `2066` baris (Commit 5 `dc405a2`: `routes/admin/flashSales.routes.js` = `71` baris) -> `1979` baris (Commit 6 `4b3a81f`: `routes/admin/margins.routes.js` = `107` baris) -> `1975` baris (Commit 7: pembersihan 4 import tak terpakai).
- Import tak terpakai yang dihapus di Commit 7: `ALLOWED_PAYMENT_METHOD_TYPES`, `isSafeAssetUrl`, `parseOptionalBoolean`, `parseOptionalText`. Semua ekspor `module.exports` pada `backend/server.js` (`app`, `pool`, `startServer`, `server`, `validateEnvironment`, `invalidateFoxyProductCache`, `callbackClock`, `clearCallbackCooldownCache`) tetap utuh.
- Hasil verifikasi akhir: `npm run check` lulus, `npm test` = `192` lulus (`0` gagal, `0` dilewati; diff terhadap `docs/refactor-baseline-tests.txt` = `0`), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=279, overlap_conflicts=0, effective_chains=87/87, known_anonymous_renames=[USE(/): <anonymous> -> securityHeaders (87 routes)]`.
- Catatan cakupan tes & DB: `tests/manual/*` (`concurrency.js`, `idempotency.js`, `pool.js`) tidak dijalankan karena R6c tidak menyentuh alur order maupun refund (baru wajib pada R8–R10); tidak ada migrasi database pada tahap ini.

---

## R7 — Ekstraksi Services (`foxyClient`, `priceService`, `idempotency`) & Route Katalog/Validasi/Promo/Sync (`products.routes.js`, `catalog.routes.js`)

Prinsip kerja & kompatibilitas mock:
- Nol perubahan perilaku: SQL, rumus pembulatan `Math.ceil`/`Math.floor`, aturan manual/custom-margin/flash-sale/promo, guard modal, TTL cache Foxy, pesan error, kode status HTTP, dan urutan pemasangan route/middleware dipertahankan identik.
- Pemanggilan DB tetap melewati metode `pool.query(...)` / `pool.connect()` pada instance `pool` milik `server.js`, dan HTTP ke Foxy tetap melewati `axios.get(...)` / `axios.post(...)` pada singleton `require('axios')` (tanpa destructuring) agar mock pada unit/integration test tetap bekerja.
- Cache produk Foxy hanya hidup di satu modul (`backend/services/foxyClient.js`); `backend/server.js` tetap mempertahankan seluruh `module.exports` (`app`, `pool`, `startServer`, `server`, `validateEnvironment`, `invalidateFoxyProductCache`, `callbackClock`, `clearCallbackCooldownCache`).
- Arah dependensi satu arah tanpa siklus dan tanpa `require()` di dalam fungsi: `routes -> middleware, services, config, utils`; `services/priceService -> services/foxyClient, config, utils`; `services/foxyClient -> config, utils`; `services/idempotency -> config, utils`.
- Baseline tes tetap **`192`** sesuai [refactor-baseline-tests.txt](file:///d:/DICKY%20BELAJAR/topup-miku/docs/refactor-baseline-tests.txt); seluruh file menggunakan LF murni (`i/lf w/lf`).

### Cek Batas Ukuran Route (400 baris) Sebelum Memindah 5 Route R7
- `backend/routes/public.routes.js` saat ini: **`368` baris**. Penambahan 4 route R7 publik (`437-809` — bahkan setelah logika harga/promo dipindah ke `priceService.js`) akan menambah `~180+` baris dan mendorong file menjadi `~550` baris (**melewati batas keras 400 baris**). Karena itu, 4 route tersebut dipisahkan ke **`backend/routes/catalog.routes.js`** (`~180-220` baris) dan dipasang di urutan mounting yang persis sama.
- `backend/routes/admin/products.routes.js` saat ini: **`231` baris**. Penambahan `POST /api/admin/sync-products` (`386-421`, ~38 baris) membuat total menjadi `~270` baris (masih di bawah target `300` dan batas keras `400`).

### Inventaris Sisa `backend/server.js` (`1.975` baris) & Pemetaan Commit R7

1. **Commit 1 — `backend/services/foxyClient.js`**
   - Memindahkan utuh fungsi & state dari `server.js`:
     - `validateOrderGameIdIfNeeded(product, targetGameId, targetServerId)` (`233-290`) — memakai `validateGameId` (`utils/validators/cek-id-game.js`) dan `checkMobapayMlbbEligibility` (`utils/validators/stalk-ml-promo.js`).
     - State cache tunggal `foxyProductCache` & `foxyCacheTimestamp` (`293-294`), `invalidateFoxyProductCache()` (`296-299`), dan `getFoxyProducts()` (`301-331`) — memakai `axios.get` (`require('axios')`), `FOXY_API_KEY` (`config/env.js`), `FOXY_BASE_URL`, `PROVIDER_TIMEOUT_MS`, `FOXY_CACHE_TTL` (`config/constants.js`), dan `safeAxiosError` (`utils/logger.js`).
   - `server.js` mengimpor `{ validateOrderGameIdIfNeeded, invalidateFoxyProductCache, getFoxyProducts }` dari `./services/foxyClient` dan tetap me-re-export `invalidateFoxyProductCache` di `module.exports`.

2. **Commit 2 — `backend/services/priceService.js`**
   - Memindahkan seluruh kalkulasi harga, margin role, custom game margin, harga manual, flash sale, diskon promo, serta guard modal dari 2 blok route R7 di `server.js`:
     - Dari `GET /api/games/:gameId/products` (`565-659`): `calculateCatalogProducts(...)` dan `getGameProductsCatalog({ pool, gameId, user })` (`567-654`: query user role, game aktif, products + `game_margins`, `flash_sales` aktif tanpa limit kuota seperti aslinya, role `roles`, serta kalkulasi prioritas flash sale -> harga manual -> custom margin -> global margin).
     - Dari `POST /api/promos/validate` (`661-809`): `calculateEffectiveProductPriceForPromo(...)`, `calculatePromoDiscount(effectivePrice, promo, rules)`, `fetchProviderCostWithFallback(providerSku, fallbackCost)` (memanggil `getFoxyProducts()` dari `./foxyClient`), dan `validatePromoCodeForProduct({ pool, userId, promoCode, productId, targetGameId })` (`669-808`, termasuk `pool.connect()` + `try/finally release()`).
   - Catatan R9: logika harga + `FOR UPDATE` di dalam transaksi Fase (a) `POST /api/order` (`942-1102`) dan `POST /h2h/order` (`1565-1652`), serta `GET /h2h/products` (`1830-1910`) sengaja tetap dibiarkan di `server.js` pada R7 agar R7 tidak menyentuh alur eksekusi order (akan disatukan saat R9).

3. **Commit 3 — `backend/services/idempotency.js`**
   - Memindahkan helper idempotency & pembuatan transaksi bersama dari `server.js` (`113-222`):
     - `findTransactionByRefId(queryable, userId, refId)` (`113-125`)
     - `matchesOrderIdempotencyPayload(existingTx, productId, targetGameId, targetServerId)` (`127-135`)
     - `buildIdempotentOrderResponseBody(channel, existingTx)` (`137-158`)
     - `resolveExistingIdempotentOrder(queryable, opts)` (`160-187`)
     - `insertTransactionRecord(client, opts)` (`189-206`)
     - `findRecentPendingDuplicate(client, userId, productId, targetGameId)` (`208-222`) — memakai `DUPLICATE_ORDER_WINDOW_SECONDS` (`config/constants.js`)
     - Re-export `{ generateInvoiceId, generateProviderTrxId }` dari `../utils/crypto` agar `services/idempotency.js` menjadi titik masuk bersama untuk idempotency & ID transaksi (tanpa memutus `utils/crypto.js`).
   - `server.js` mengimpor simbol tersebut dari `./services/idempotency` untuk `POST /api/order` dan `POST /h2h/order`.

4. **Commit 4 — Ekstraksi 5 Route R7**
   - `POST /api/admin/sync-products` (`386-421`) -> dipindahkan ke [products.routes.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/routes/admin/products.routes.js) tepat **setelah** `PUT /api/admin/products/bulk-validation` (posisi mount & urutan route produk admin identik); mengimpor `FOXY_API_KEY` (`../../config/env`), `syncProductsWithFoxy` (`../../utils/cronUtils`), dan `invalidateFoxyProductCache` (`../../services/foxyClient`).
   - `POST /api/products/:productId/validate` (`437-511`), `POST /api/full-validate` (`514-563`), `GET /api/games/:gameId/products` (`565-659`), dan `POST /api/promos/validate` (`661-809`) -> dipindahkan ke **`backend/routes/catalog.routes.js`** (`createCatalogRoutes({ pool, protect, softProtect })`) dan dipasang pada posisi asal di `server.js` (tepat setelah `createAdminMarginsRoutes` dan sebelum `createWaBotRoutes`).

5. **Commit 5 — Pembersihan, Skrip `check`, & Hasil R7**
   - Audit & hapus import di `server.js` yang tidak lagi digunakan (`DUPLICATE_ORDER_WINDOW_SECONDS`, `FOXY_CACHE_TTL`, `fs`, `syncProductsWithFoxy`, `validateGameId`, `checkAllMobapayPromosML`, `checkMobapayMlbbEligibility`, `cekPromoMcggMobapay`, `getGameProductsCatalog`, `validatePromoCodeForProduct`).
   - Perbarui `backend/package.json` skrip `check` agar turut memeriksa folder `services`.
   - Catat hasil commit hash & ukuran akhir di bagian bawah seksi R7.

### Sisa Route & Fungsi di `backend/server.js` Pasca R7 (untuk R8 & R9)
- **6 Route Order/Callback/H2H (R9)**: `POST /api/order`, `POST /api/foxy/callback`, `POST /h2h/order`, `GET /h2h/products`, `PUT /h2h/profile/callback`, `GET /h2h/profile`.
- **Helper yang masih tinggal untuk R8/R9**: `getSafeOrderErrorMessage`, `createNotification`, `isProviderTimeoutOrAmbiguous`, `finalizeOrderAfterProviderCall`, `callbackVerificationCooldown` / `callbackClock` / `clearCallbackCooldownCache`, `extractCallbackToken`, `verifyFoxyCallbackAuth`, `checkAndMarkCallbackCooldown`, `doesFoxyStatusMatchDb`, serta `startServer` & `module.exports`.

### Hasil Akhir R7
- Panjang `backend/server.js`: `1975` baris (akhir R6c) -> `1871` baris (Commit 1 `7782e18`: `services/foxyClient.js` = `125` baris) -> `1664` baris (Commit 2 `5f7924e`: `services/priceService.js` = `290` baris) -> `1556` baris (Commit 3 `734c7e9`: `services/idempotency.js` = `127` baris) -> `1356` baris (Commit 4 `4b2aa90`: `routes/admin/products.routes.js` = `271` baris, `routes/catalog.routes.js` = `194` baris; `routes/public.routes.js` tetap `368` baris) -> `1346` baris (Commit 5: pembersihan 10 import tak terpakai & pembaruan `package.json`).
- Import tak terpakai yang dihapus di Commit 5: `DUPLICATE_ORDER_WINDOW_SECONDS`, `FOXY_CACHE_TTL`, `fs`, `syncProductsWithFoxy`, `validateGameId`, `checkAllMobapayPromosML`, `checkMobapayMlbbEligibility`, `cekPromoMcggMobapay`, `getGameProductsCatalog`, `validatePromoCodeForProduct`. Semua simbol `module.exports` pada `backend/server.js` tetap utuh.
- Skrip `check` pada `backend/package.json` diperbarui agar turut memeriksa direktori `services`.
- Hasil verifikasi akhir: `npm run check` lulus, `npm test` = `192` lulus (`0` gagal, `0` dilewati; diff terhadap `docs/refactor-baseline-tests.txt` = `0`), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=279, overlap_conflicts=0, effective_chains=87/87, known_anonymous_renames=[USE(/): <anonymous> -> securityHeaders (87 routes)]`.
- Catatan cakupan tes & DB: `tests/manual/*` (`concurrency.js`, `idempotency.js`, `pool.js`) tidak dijalankan karena R7 tidak menyentuh eksekusi order maupun refund rollback (baru wajib pada R8–R10); tidak ada migrasi database pada tahap ini.

---

## R8 — Ekstraksi Jalur Tunggal Refund (`services/refundService.js`) & Pekerjaan Latar Belakang (`jobs/pendingTransactions.js`, `jobs/productSync.js`, `jobs/cronJob.js`)

### Analisis Risiko Sebelum Perubahan (Wajib untuk Jalur Saldo/Refund & Cron)
1. **Risiko divergensi jalur refund (`rollbackTransactionResources`)**:
   - Bila ada modul yang memakai salinan terpisah, perubahan di masa depan berisiko menyebabkan double-refund atau gagal memulihkan kuota `promo_usages`/`flash_sales`.
   - **Mitigasi**: `rollbackTransactionResources` hanya hidup di `backend/services/refundService.js` (dipindahkan utuh karakter demi karakter: validasi `ALLOWED_ROLLBACK_STATUSES`, cek anti-double-refund di `balance_history`, `UPDATE transactions SET status = 'Failed' ... WHERE ... status IN ('Pending', 'Processing', 'Partial Refund')`, pengembalian `users.balance` + insert `balance_history`, pemulihan `promo_usages` + `promo_codes.uses_count`, serta pemulihan `flash_sales.uses_count` + `flash_sale_restored = TRUE`). Seluruh pemanggil (`server.js`, `routes/admin/transactions.routes.js`, `jobs/pendingTransactions.js`, dan re-export `utils/cronUtils.js`) mengarah ke satu fungsi tersebut.
2. **Risiko putusnya mock `cronPool` pada tes integrasi**:
   - Suite tes (`appFactory.js`, `connectionPoolCronAndTimeouts.test.js`, `h2hSecurity.test.js`, `h2hWebhook.test.js`, `orderCompensation.test.js`, `orderPriceGuardAndLock.test.js`) mengimpor `cronUtils.pool` dan mem-mock `cronPool.query` serta `cronPool.connect`.
   - **Mitigasi**: Satu instance `pool` cron dibuat di `backend/jobs/pendingTransactions.js`, dipakai bersama oleh `backend/jobs/productSync.js`, dan di-re-export oleh `backend/utils/cronUtils.js` sehingga `cronUtils.pool === pendingTransactions.pool === productSync.pool`.
3. **Risiko efek samping saat `jobs/cronJob.js` di-`require`**:
   - Pada `backend/cron_job_script.js` lama, `setTimeout` global, signal handler, dan `main()` dieksekusi langsung saat file dimuat.
   - **Mitigasi**: Di `backend/jobs/cronJob.js`, eksekusi CLI dibungkus dalam `runCronCli()` (otomatis jalan jika `require.main === module`), sedangkan `backend/cron_job_script.js` menjadi wrapper tipis yang memanggil `runCronCli()`.

### Inventaris Asal & Pemetaan Commit R8

1. **Commit 1 — `backend/services/refundService.js`**
   - Memindahkan `rollbackTransactionResources(client, tx, options = {})` dari `backend/utils/cronUtils.js` (`93-204`) utuh apa adanya ke `backend/services/refundService.js`.
   - Memperbarui pemanggil agar mengimpor dari `services/refundService.js`:
     - [server.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/server.js) (`finalizeOrderAfterProviderCall` baris `234`, `/api/foxy/callback` baris `815`, serta pengoperan ke `createAdminTransactionsRoutes`).
     - [transactions.routes.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/routes/admin/transactions.routes.js) (mengimpor `rollbackTransactionResources` dari `../../services/refundService` sebagai default bila tidak dioper via `deps`, tetap mendukung override `deps.rollbackTransactionResources`).
     - [cronUtils.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/utils/cronUtils.js) (mengimpor dari `../services/refundService` untuk dipakai `checkPendingTransactions` dan tetap me-re-export `rollbackTransactionResources` di `module.exports`).

2. **Commit 2 — `backend/jobs/pendingTransactions.js` & `backend/jobs/productSync.js`**
   - `backend/jobs/pendingTransactions.js`: memindahkan utuh dari `backend/utils/cronUtils.js` (`1-92`, `206-387`):
     - Pembuatan `pool = createPool()` (`config/db.js`), konstanta & header Foxy (`FOXY_BASE_URL`, `FOXY_API_KEY`, `PROVIDER_TIMEOUT_MS`, `foxyApiHeaders`), helper `safeAxiosError` & `safeErrorDetail`, serta `PENDING_IN_FLIGHT_GRACE_MS`, `isWithinInFlightGracePeriod`, dan `checkPendingTransactions`.
     - Mengimpor `rollbackTransactionResources` dari `../services/refundService` dan `dispatchSafeH2HWebhook` dari `../utils/webhookClient.js`.
   - `backend/jobs/productSync.js`: memindahkan utuh `syncProductsWithFoxy` dari `backend/utils/cronUtils.js` (`389-529`), memakai `pool`, `FOXY_BASE_URL`, `PROVIDER_TIMEOUT_MS`, `foxyApiHeaders`, `safeAxiosError`, dan `safeErrorDetail` yang diekspor `./pendingTransactions`.
   - Memperbarui [products.routes.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/routes/admin/products.routes.js) agar mengimpor `syncProductsWithFoxy` dari `../../jobs/productSync`, serta memperbarui `backend/utils/cronUtils.js` agar mengimpor dan me-re-export `checkPendingTransactions`, `syncProductsWithFoxy`, dan `pool` dari `../jobs/*`.

3. **Commit 3 — `backend/jobs/cronJob.js` & `backend/cron_job_script.js`**
   - Memindahkan `runAllCronJobs` dari `backend/utils/cronUtils.js` (`531-565`) dan seluruh logika runner CLI (`LOCK_FILE`, `LOCK_STALE_MS`, `GLOBAL_TIMEOUT_MS`, `acquireLock`, `releaseLock`, signal handlers, global timeout, mode `--pending-only` / `--sync-only`, dan `main()`) dari `backend/cron_job_script.js` (`1-170`) ke `backend/jobs/cronJob.js`, terhubung langsung ke `./pendingTransactions`, `./productSync`, dan `../services/refundService`.
   - Menjadikan `backend/cron_job_script.js` delegasi tipis ke `./jobs/cronJob` (`runCronCli()`), dan menjadikan `backend/utils/cronUtils.js` re-export murni (`{ checkPendingTransactions, syncProductsWithFoxy, runAllCronJobs, rollbackTransactionResources, pool }`).

4. **Commit 4 — Pembersihan, Skrip `check`, & Dokumentasi Hasil R8**
   - Audit import di `backend/server.js` dan file terkait, pastikan `module.exports` di `server.js` dan `utils/cronUtils.js` tetap utuh.
   - Perbarui skrip `check` pada `backend/package.json` agar mencakup direktori `'jobs'`.
   - Catat hash commit aktual, jumlah baris tiap file, dan hasil eksekusi 3 skrip `tests/manual/*` di akhir seksi R8.

### Arah Dependensi Satu Arah (Tanpa Siklus)
- `jobs/cronJob.js -> jobs/pendingTransactions.js, jobs/productSync.js, services/refundService.js`
- `jobs/productSync.js -> jobs/pendingTransactions.js`
- `jobs/pendingTransactions.js -> services/refundService.js, config/db.js, utils/webhookClient.js`
- `services/refundService.js -> (murni memakai client pg yang dioper)`
- `utils/cronUtils.js (facade kompatibilitas tes) -> jobs/cronJob.js, jobs/pendingTransactions.js, jobs/productSync.js, services/refundService.js` (tidak ada modul di `jobs/` atau `services/` yang mengimpor `utils/cronUtils.js`).

### Hasil Akhir R8
- Panjang `backend/server.js`: `1346` baris (akhir R7) -> `1346` baris (Commit 1 `bfeb528`: pengalihan import `rollbackTransactionResources` ke `services/refundService.js`) -> `1346` baris (Commit 2 `84f4f95` & Commit 3 `33bc000`) -> `1344` baris (Commit 4: pembersihan komentar deprecated `checkPendingTransactions`).
- Ukuran modul R8 baru/diubah:
  - `backend/services/refundService.js`: `116` baris
  - `backend/jobs/pendingTransactions.js`: `285` baris
  - `backend/jobs/productSync.js`: `156` baris
  - `backend/jobs/cronJob.js`: `232` baris
  - `backend/cron_job_script.js`: `170` -> `3` baris (wrapper tipis `runCronCli()`)
  - `backend/utils/cronUtils.js`: `567` -> `15` baris (facade kompatibilitas re-export untuk suite tes)
  - `backend/routes/admin/transactions.routes.js`: `155` baris; `backend/routes/admin/products.routes.js`: `271` baris
- Skrip `check` pada `backend/package.json` diperbarui agar turut memeriksa direktori `jobs`.
- Hasil verifikasi otomatis akhir: `npm run check` lulus, `npm test` = `192` lulus (`0` gagal, `0` dilewati; diff terhadap `docs/refactor-baseline-tests.txt` = `0`), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=279, overlap_conflicts=0, effective_chains=87/87, known_anonymous_renames=[USE(/): <anonymous> -> securityHeaders (87 routes)]`.
- Hasil verifikasi 3 skrip PostgreSQL manual (`tests/manual/*` terhadap `topup_miku_local@127.0.0.1`):
  - `node tests/manual/concurrency.js`: **`[PASS]`** semua 3 skenario (`Skenario A`: `status=Success, refundRows=0, balance=75000`; `Skenario B`: `status=Failed, refundRows=1, balance=100000, flashSaleRestored=true`; `Skenario C`: `Balapan acak 15x: Pelanggaran=0`; exit code `0`).
  - `node tests/manual/idempotency.js`: **`[PASS]`** semua 5 skenario (`A` 20x H2H paralel, `B` 20x Web paralel, `C` 20x Deposit paralel, `D` 409 conflict, `E` Failed/refund replay vs `ref_id` baru; exit code `0`).
  - `node tests/manual/pool.js`: **`[PASS]`** (`http201=30/30, peakInFlightFoxy=30, dbProbeDuringFoxy=true, orphanNullProvider=0, withProviderTrxId=30`; exit code `0`).
- Tidak ada migrasi database pada tahap ini.

---

## R9 — Ekstraksi Alur Transaksi Order, H2H, & Callback Foxy (`services/orderService.js`, `services/notificationService.js`, `routes/order.routes.js`, `routes/h2h.routes.js`, `routes/foxyCallback.routes.js`)

### Analisis Risiko Sebelum Perubahan (Wajib untuk Jalur Order, Saldo, H2H, & Callback Provider)
1. **Risiko perubahan urutan penguncian (`FOR UPDATE`) atau bocornya koneksi pool pada arsitektur 3-fase (`SEC-013`)**:
   - Web Order (`POST /api/order`) dan H2H Order (`POST /h2h/order`) wajib menjalankan: (Pre-check DB singkat + lepas koneksi) -> (Validasi ID game + cek harga modal real-time Foxy tanpa menahan koneksi DB) -> **Fase (a)** (transaksi DB atomik: lock user `FOR UPDATE`, hitung harga + lock `flash_sales FOR UPDATE`, cek modal `SEC-003`, lock `promo_codes FOR UPDATE` / cek kuota harian H2H, potong `users.balance WHERE balance >= $1`, insert `transactions` `'Pending'` beserta `provider_trx_id`, insert `balance_history`, update `flash_sales`/`promo_codes`/`promo_usages`, `COMMIT`, lepas koneksi) -> **Fase (b)** (`axios.post` ke `/v1/order` Foxy tanpa menahan koneksi DB) -> **Fase (c)** (`finalizeOrderAfterProviderCall`: lock `transactions FOR UPDATE` tanpa filter status, simpan `COALESCE(provider_trx_id, $1)`, dan panggil `rollbackTransactionResources` hanya jika gagal non-timeout dan status masih `Pending`/`Processing`).
   - **Mitigasi**: Seluruh alur uang 3-fase dipindahkan utuh ke satu file (`backend/services/orderService.js`, `< 600` baris) sesuai Aturan Emas #6 tanpa mengubah satu karakter pun SQL, urutan query, maupun kondisi `FOR UPDATE`.
2. **Risiko verifikasi callback Foxy (`SEC-001`) & duplikasi state `callbackClock` / `callbackVerificationCooldown`**:
   - Suite tes (`foxyCallback.test.js`, `connectionPoolOrders.test.js`, `connectionPoolCronAndTimeouts.test.js`) mengimpor `callbackClock` dan `clearCallbackCooldownCache` dari `server.js` dan mem-mock `callbackClock.now`.
   - **Mitigasi**: `callbackVerificationCooldown`, `callbackClock`, dan `clearCallbackCooldownCache` hanya hidup di satu tempat (`backend/routes/foxyCallback.routes.js`) dan di-re-export langsung oleh `backend/server.js`.
3. **Risiko urutan rate limiter & middleware pada route `/api/order`, `/api/foxy/callback`, dan `/h2h/*`**:
   - Global limiter (`checkoutLimiter`, `apiLimiter`, `h2hLimiter`) dipasang oleh `applyRateLimiters(app)` di atas route, sedangkan route H2H memasang inline `[protectH2HIp, protectH2H, h2hUserLimiter]`.
   - **Mitigasi**: Ketiga router dipasang di `backend/server.js` pada posisi asal masing-masing dengan daftar middleware inline identik, diverifikasi dengan `node scripts/check-route-overlap.js` (`effective_chains=87/87`).

### Inventaris Sisa `backend/server.js` (`1.344` baris) & Pemetaan Commit R9

1. **Commit 1 — `backend/services/notificationService.js` & `backend/services/orderService.js`**
   - `backend/services/notificationService.js` (`~25` baris): memindahkan `createNotification(userId, message, link = null)` (`server.js:142-150`) ke factory `createNotificationService({ pool })` agar dapat dipakai oleh `server.js` dan route tanpa siklus dependensi.
   - `backend/services/orderService.js` (`~490` baris, `< 600` batas keras): memindahkan dari `server.js`:
     - `getSafeOrderErrorMessage(error, fallback)` (`70-114`)
     - `isProviderTimeoutOrAmbiguous(providerError)` (`187-200`)
     - `finalizeOrderAfterProviderCall({ pool, ... })` (`206-260`)
     - Helper bersama Fase Pre-check/Fase (a)/Fase (b) di dalam file yang sama (`fetchRealtimeFoxyCostForOrder`, `lockAndCalculateOrderSellingPrice`, `submitOrderToFoxyProvider`) serta `executeWebOrder` (`274-598`) dan `executeH2HOrder` (`896-1193`).
   - `server.js` memanggil `createNotificationService` dan `orderService` pada handler `POST /api/order` dan `POST /h2h/order`.

2. **Commit 2 — `backend/routes/order.routes.js`**
   - Memindahkan `POST /api/order` ke `backend/routes/order.routes.js` (`createOrderRoutes({ pool, protect })`, `~65` baris) dan memasangnya di `server.js` tepat setelah `createWaBotRoutes`.

3. **Commit 3 — `backend/routes/h2h.routes.js`**
   - Memindahkan 4 route H2H ke `backend/routes/h2h.routes.js` (`createH2HRoutes({ pool, protectH2HIp, protectH2H, h2hUserLimiter })`, `~195` baris, `< 400` batas keras):
     - `POST /h2h/order` (`883-1199`)
     - `GET /h2h/products` (`1201-1292`)
     - `PUT /h2h/profile/callback` (`1294-1312`)
     - `GET /h2h/profile` (`1314-1327`)

4. **Commit 4 — `backend/routes/foxyCallback.routes.js`**
   - Memindahkan `callbackVerificationCooldown`, `callbackClock`, `clearCallbackCooldownCache`, `extractCallbackToken`, `verifyFoxyCallbackAuth`, `checkAndMarkCallbackCooldown`, `doesFoxyStatusMatchDb`, serta `POST /api/foxy/callback` (`606-881`) ke `backend/routes/foxyCallback.routes.js` (`~295` baris, `< 400` batas keras).
   - `server.js` memasang `createFoxyCallbackRoutes({ pool, createNotification })` dan me-re-export `callbackClock` serta `clearCallbackCooldownCache` di `module.exports`.

5. **Commit 5 — Pembersihan `server.js` & Dokumentasi Hasil R9**
   - Menghapus seluruh import di `backend/server.js` yang tidak lagi dipakai setelah Commit 1–4; mempertahankan seluruh simbol `module.exports` di `server.js`.
   - Menjalankan verifikasi penuh otomatis + ketiga skrip manual PostgreSQL (`concurrency.js`, `idempotency.js`, `pool.js`) dan mencatat hasil akhir R9.

### Hasil Akhir R9
- Panjang `backend/server.js`: `1344` baris (akhir R8) -> `606` baris (Commit 1 `ae2fe3c`: `services/notificationService.js` = `23` baris, `services/orderService.js`) -> `583` baris (Commit 2 `e1dd4c2`: `routes/order.routes.js` = `51` baris) -> `439` baris (Commit 3 `ac27fde`: `routes/h2h.routes.js` = `186` baris) -> `165` baris (Commit 4 `bbd8346`: `routes/foxyCallback.routes.js` = `313` baris) -> **`126` baris** (Commit 5: pembersihan import tak terpakai di `server.js` & perapian `services/orderService.js` menjadi `595` baris, di bawah batas keras `600` baris).
- Ukuran seluruh file R9 (semua di bawah batas keras `600` untuk service dan `400` untuk route, serta `server.js <= 150` baris):
  - `backend/server.js`: `126` baris
  - `backend/services/notificationService.js`: `23` baris
  - `backend/services/orderService.js`: `595` baris
  - `backend/routes/order.routes.js`: `51` baris
  - `backend/routes/h2h.routes.js`: `186` baris
  - `backend/routes/foxyCallback.routes.js`: `313` baris
- Hasil verifikasi otomatis akhir: `npm run check` lulus, `npm test` = `192` lulus (`0` gagal, `0` dilewati; diff terhadap `docs/refactor-baseline-tests.txt` = `0`), dan `node scripts/check-route-overlap.js` = `OK: route set=87/87, middlewares=87/87, reordered_same_method=279, overlap_conflicts=0, effective_chains=87/87, known_anonymous_renames=[USE(/): <anonymous> -> securityHeaders (87 routes)]`.
- Hasil verifikasi 3 skrip PostgreSQL manual (`tests/manual/*` terhadap `topup_miku_local@127.0.0.1`):
  - `node tests/manual/concurrency.js`: **`[PASS]`** semua 3 skenario (`Skenario A`: `status=Success, refundRows=0, balance=75000`; `Skenario B`: `status=Failed, refundRows=1, balance=100000, flashSaleRestored=true`; `Skenario C`: `Balapan acak 15x: Pelanggaran=0`; exit code `0`).
  - `node tests/manual/idempotency.js`: **`[PASS]`** semua 5 skenario (`A` 20x H2H paralel, `B` 20x Web paralel, `C` 20x Deposit paralel, `D` 409 conflict, `E` Failed/refund replay vs `ref_id` baru; exit code `0`).
  - `node tests/manual/pool.js`: **`[PASS]`** (`http201=30/30, peakInFlightFoxy=30, dbProbeDuringFoxy=true, orphanNullProvider=0, withProviderTrxId=30`; exit code `0`).
- Tidak ada migrasi database pada tahap ini.
