# Tahap 1 — Project Discovery (`topup-miku`)

- **Tanggal Audit:** 17 November 2026
- **Commit Diuji:** `794431e` (`main`) pada branch kerja `qa/audit`
- **Stack:** Node.js `v24.20.0`, Express `4.22.3`, PostgreSQL (`pg ^8.23.1`, DB lokal `topup_miku_local`), Static HTML/CSS/Vanilla JS (`frontend/`).

---

## 1. Struktur Folder & Arsitektur Modul

- **`backend/`**:
  - Entrypoint: `server.js` (`startServer`) & `app.js` (`createApp`)
  - Config: `config/{env.js, db.js, constants.js}`
  - Middleware: `middleware/{securityHeaders.js, errorHandler.js, rateLimiters.js, auth.js, h2hAuth.js, waBotAuth.js}`
  - Routes (19 grup, 87 route total): `routes/{public,auth,catalog,user,userApiKey,deposit,order,foxyCallback,h2h,waBot}.routes.js` & `routes/admin/{balance,deposits,flashSales,games,margins,paymentMethods,products,promos,transactions}.routes.js`
  - Services: `services/{orderService,priceService,foxyClient,idempotency,refundService,auditLogService,notificationService}.js`
  - Cron Jobs: `cron_job_script.js` -> `jobs/{cronJob,pendingTransactions,productSync}.js`
  - Utils & Validators: `utils/{crypto,cronUtils,logger,mailer,networkSecurity,schemaValidators,strings,validation,webhookClient}.js` & `utils/validators/{cek-id-game,mobapayEligibility,stalk-mcgg,stalk-ml-promo}.js`
- **`frontend/`**: 13 halaman HTML + CSS modular (`frontend/css/*.css`) + JS modular (`script.js`, `invoice.js`, `cek-transaksi.js`, `compare-prices.js`, `leaderboard.js`, `validate.js`, `reset-password.js`, `js/{shared,product,dashboard,admin}/*.js`).
- **Database (`setup_db.sql` + `migrations/001..012`):** 17 tabel (`roles`, `users`, `deposits`, `balance_history`, `games`, `product_categories`, `products`, `transactions`, `password_resets`, `notifications`, `game_margins`, `game_servers`, `promo_codes`, `promo_usages`, `flash_sales`, `payment_methods`, `admin_audit_logs`).

---

## 2. Daftar 13 Halaman Frontend

| Halaman | Auth | Deskripsi & Endpoint yang Dipanggil |
|---|---|---|
| `index.html` | Publik / opsional JWT | Storefront katalog game, flash sale, pencarian, modal Login/Register/Forgot, notifikasi (`/api/games`, `/api/public/flash-sales`, `/api/auth/*`, `/api/user/{profile,notifications*}`) |
| `product.html` | Publik / JWT saat promo & order | Alur topup 4 langkah: ID & Server, Nominal produk, Promo, Metode bayar/konfirmasi (`/api/games/:id/products`, `/api/games/:id/servers`, `/api/products/:id/validate`, `/api/promos/validate`, `/api/order`) |
| `dashboard.html` | JWT Wajib | Portal member/reseller SPA: Overview, Transaksi, Cek Pesanan, Mutasi Saldo, Deposit, Integrasi H2H, Edit Profil/Password (`/api/user/*`, `/api/payment-methods`, `/api/deposit/request`, `PUT /h2h/profile/callback`) |
| `admin.html` | JWT (`Admin` di backend) | Panel admin SPA: Produk & Game, Deposit, Payment Methods, Saldo Manual, Margin Global, Promo, Flash Sale, Transaksi (`/api/admin/*`, `/api/games/validatable`) |
| `invoice.html` | JWT Wajib | Detail invoice pribadi termasuk `provider_sn` (`/api/user/transaction/:invoiceId`) |
| `cek-transaksi.html` | Publik | Pelacakan status transaksi publik & 10 transaksi terakhir tersamarkan (`/api/public/transaction/:invoiceId`, `/api/public/recent-transactions`) |
| `compare-prices.html` | Publik | Perbandingan harga tiap role + flash sale (`/api/public/compare-prices`) |
| `leaderboard.html` | Publik | Papan peringkat pembeli `all_time`/`monthly`/`weekly` (`/api/public/leaderboard`) |
| `validate.html` | Publik | Cek Nickname / Region / Promo MLBB & MCGG (`/api/games/validatable`, `/api/full-validate`) |
| `reset-password.html` | Publik (via `?token=`) | Form reset password single-use (`/api/auth/reset-password`) |
| `syarat-ketentuan.html` | Publik (statis) | Ketentuan layanan |
| `kebijakan-refund.html` | Publik (statis) | Kebijakan pengembalian dana |
| `kontak.html` | Publik (statis) | Halaman kontak dukungan |

---

## 3. Matriks Endpoint API Backend (`87` Route)

### Publik & Auth
- `GET /healthz` (Publik, tanpa limiter)
- `GET /api/games`, `GET /api/games/validatable`, `GET /api/games/:gameId/servers`, `GET /api/public/{compare-prices,flash-sales,bot-products/:gameName,bot-games,transaction/:invoiceId,recent-transactions,leaderboard}` (Publik, **tanpa rate limiter** karena dimount sebelum `applyRateLimiters` di `app.js:49-52`)
- `POST /api/auth/register` (Publik, `registerLimiter`: 5/1h)
- `POST /api/auth/{login,forgot-password,reset-password}` (Publik, `authLimiter`: 30/15m)
- `POST /api/products/:productId/validate`, `POST /api/full-validate` (Publik, `apiLimiter`: 300/5m)
- `GET /api/games/:gameId/products` (`softProtect`, tanpa limiter)
- `POST /api/promos/validate` (`protect` JWT, tanpa limiter)

### User, Deposit, & Order Web
- `GET/PUT /api/user/profile`, `PUT /api/user/password`, `GET /api/user/{balance-history,transactions,transaction/:invoiceId,transaction-summary}`, `GET /api/user/notifications*`, `POST /api/user/notifications/mark-as-read` (`apiLimiter` + `protect`)
- `GET/POST/DELETE /api/user/{apikey*,generate-apikey,webhook-secret*,whitelisted-ips}` (`apiLimiter` + `protect`)
- `GET /api/payment-methods`, `POST /api/deposit/request`, `GET /api/user/deposits` (`apiLimiter` + `protect`)
- `POST /api/order` (`checkoutLimiter`: 30/5m + `apiLimiter` + `protect`)

### Provider Callback, H2H API, & WA Bot
- `POST /api/foxy/callback` (`apiLimiter` + `verifyFoxyCallbackAuth` token header/query)
- `POST /h2h/order`, `GET /h2h/products`, `PUT /h2h/profile/callback`, `GET /h2h/profile` (`h2hLimiter` 60/1m + `apiLimiter` + `protectH2HIp` + `protectH2H` + `h2hUserLimiter` 60/1m)
- `GET /api/bot/admin/deposits/{pending,:id}`, `POST /api/bot/admin/deposits/:id/{approve,reject}` (`authLimiter` + `requireWaBotAdminToken`)

### Admin (`/api/admin/*` — `protectAdmin`, tanpa rate limiter)
- Deposits (`GET /deposits`, `GET /deposits/pending`, `POST /deposits/approve`, `POST /deposits/reject`) — dengan `admin_audit_logs`
- Payment Methods (`GET/POST/PUT/DELETE /api/admin/payment-methods*`) — dengan `admin_audit_logs`
- Balance (`POST /api/admin/balance/{add,reduce}`) — dengan `admin_audit_logs`
- Games & Roles (`GET/PUT /api/admin/roles`, `GET/POST /api/admin/games`, `PUT /api/admin/games/:id/{status,needs-server}`, `GET /api/admin/validation-services/pgs-preview`, plus **`POST /api/test` TANPA AUTH**)
- Products (`GET/POST /api/admin/products`, `PUT /api/admin/products/:id/{status,validation}`, `PUT /api/admin/products/bulk-validation`, `POST /api/admin/sync-products`) — **tanpa `admin_audit_logs`**
- Promos & Flash Sales (`GET/POST /api/admin/promos`, `PUT /api/admin/promos/:id/toggle`, `GET/POST/DELETE /api/admin/flash-sales*`) — **tanpa `admin_audit_logs`**
- Margins & Manual Prices (`GET/POST /api/admin/games/:gameId/margins`, `GET/POST /api/admin/products/:productId/manual-prices`) — dengan `admin_audit_logs`
- Transactions (`GET /api/admin/transactions`, `PUT /api/admin/transactions/:invoiceId/resolve`) — dengan `admin_audit_logs`

---

## 4. Alur Top-Up Biasa & H2H (3 Fase)

```text
Client (Web POST /api/order | H2H POST /h2h/order)
  ├─► [Pre-check] Cek Idempotency-Key / ref_id + cek produk & game Active
  ├─► [Validasi ID] Jika validation_config.enabled -> Mobapay / PGSCODE (fail-closed)
  ├─► [Cek Harga Modal] GET ${FOXY_BASE_URL}/v1/products (cache 5m) -> ambil product_price
  ├─► [FASE (a) DB Transaction SINGKAT]
  │     ├─ BEGIN + SELECT users ... FOR UPDATE
  │     ├─ Hitung harga (manual > custom/global margin > flash_sales FOR UPDATE)
  │     ├─ Guard 1: currentProviderCost > finalPrice -> tolok order
  │     ├─ (Web) Lock promo_codes FOR UPDATE -> hitung diskon -> Guard 2
  │     ├─ (H2H) Cek kuota harian jika H2H_DAILY_MAX_* aktif
  │     ├─ Cek anti-duplikat 15 detik (jika tanpa idempotency key)
  │     ├─ UPDATE users SET balance = balance - finalPrice WHERE balance >= finalPrice
  │     ├─ INSERT transactions (status='Pending', provider_trx_id) + balance_history (Purchase)
  │     └─ COMMIT & release connection BEFORE HTTP provider!
  ├─► [FASE (b) Provider Call] POST ${FOXY_BASE_URL}/v1/order (timeout 15s, callback_url)
  └─► [FASE (c) Finalize / Compensate]
        ├─ BEGIN + SELECT transactions ... FOR UPDATE
        ├─ Jika Foxy menolak non-timeout & status masih Pending/Processing:
        │     └─ rollbackTransactionResources() -> Failed + Refund balance + restore promo/flash sale
        └─ COMMIT -> HTTP 201 (Pending/Success) atau 400 (Gagal, saldo dikembalikan)

Provider Callback (POST /api/foxy/callback)
  ├─► Verifikasi token X-Callback-Token / ?token= (timingSafeEqual, fail-closed)
  ├─► Cooldown 5s per trx_id + Zero-Trust GET ${FOXY_BASE_URL}/v1/status/:trx_id
  ├─► Cocokkan trx_id & provider_sku terhadap DB
  ├─► SUCCESS -> status='Success', simpan provider_sn, notif user
  ├─► FAILED / REFUNDED -> rollbackTransactionResources() idempoten, notif user
  ├─► PARTIAL_REFUND -> status='Partial Refund' (tahan untuk review admin)
  └─► After COMMIT -> dispatchSafeH2HWebhook() (SSRF pinned DNS HTTPS + HMAC-SHA256)
```

---

## 5. State Machine Transaksi & Deposit

- **`transactions.status`** (`Pending` [awal] -> `Success` | `Failed` | `Partial Refund`; `Processing` didukung query/rollback namun tidak pernah di-set kode; `Partial Refund` -> `Success` | `Failed` via `/resolve`).
- **`deposits.status`** (`Pending` [awal] -> `Approved` | `Rejected`; belum ada state `Expired` / `Cancelled`).
