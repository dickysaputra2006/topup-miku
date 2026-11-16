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
