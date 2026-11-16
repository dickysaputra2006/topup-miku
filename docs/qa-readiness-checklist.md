# Checklist Kesiapan Produksi & QA Manual Testing (`topup-miku`)

**Tanggal Audit & Perencanaan:** 17 November 2026  
**Branch Kerja:** `chore/pre-prod-readiness` (dari `main` `@ 56dffef`)  
**Cakupan:** Audit environment (`.env.example`), skema database (`setup_db.sql` + `migrations/001`–`012`), seeder lokal (`seed_local_dummy.js`), audit dependensi produksi (`npm audit --omit=dev`), serta peta uji QA end-to-end.

---

## 1. Hasil Audit Environment (`process.env.*` vs `backend/.env.example`)

Seluruh pembacaan `process.env.*` pada kode aplikasi di `backend/` (`config/`, `middleware/`, `routes/`, `services/`, `jobs/`, `utils/`, `scripts/`) diaudit untuk memastikan tidak ada variabel krusial yang terlewat dan **nol secret nyata di repositori**:

| Variabel `process.env` | Dibaca Oleh | Status di `.env.example` Sebelum Audit | Rencana Tindak Lanjut |
|---|---|---|---|
| `NODE_ENV` | `env.js`, `h2hAuth.js`, `securityHeaders.js`, `foxyCallback.routes.js`, `validation.js`, `seed_local_dummy.js` | **Belum tercantum** | **Tambahkan di Commit 1** (`NODE_ENV=development`) |
| `PORT` | `config/env.js` (`3000`) | Ada | Pertahankan + dokumentasikan default |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL` | `config/db.js`, `seed_local_dummy.js` | Ada | Rapikan bagian & catatan `DB_SSL=false` lokal |
| `JWT_SECRET` | `config/env.js`, `middleware/auth.js`, `auth.routes.js` | Ada | Wajib >= 32 karakter acak di production |
| `FOXY_API_KEY`, `FOXY_CALLBACK_URL`, `FOXY_CALLBACK_SECRET`, `FOXY_CALLBACK_SECRET_PREVIOUS`, `ALLOW_INSECURE_CALLBACK` | `env.js`, `foxyClient.js`, `orderService.js`, `pendingTransactions.js`, `productSync.js`, `foxyCallback.routes.js`, `products.routes.js` | Ada | Kelompokkan jelas per bagian Foxy & rotasi secret |
| `PGS_KEY`, `PGS_API_KEY` | `utils/validators/cek-id-game.js`, `routes/admin/games.routes.js` | Ada | Pertahankan dengan placeholder aman |
| `WA_BOT_ADMIN_TOKEN` | `middleware/waBotAuth.js` (wajib >= 32 karakter) | Ada | Pertahankan + catatan minimal 32 karakter |
| `BREVO_API_KEY`, `APP_BASE_URL` | `utils/mailer.js` | Ada | Kelompokkan pada bagian Mailer / Reset Password |
| `CORS_ORIGINS` | `config/env.js` (`DEFAULT_ALLOWED_ORIGINS` bila kosong) | Ada | Tambah contoh multi-origin CSV untuk lokal/prod |
| `H2H_DAILY_MAX_ORDERS`, `H2H_DAILY_MAX_AMOUNT` | `services/orderService.js` | Ada | Pertahankan (opsional kuota harian H2H) |
| `SEED_QA_PASSWORD` (opsional lokal) | `scripts/seed_local_dummy.js` (Commit 1) | Belum ada (opsional lokal) | Dokumentasikan sebagai opsional khusus `npm run seed` lokal |

- **Catatan Rate Limit & Proxy:** `trust proxy = 1` ([app.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/app.js)) dan batas rate limiter (`authLimiter`, `registerLimiter`, `checkoutLimiter`, `h2hLimiter`, `h2hUserLimiter`, `apiLimiter` pada [rateLimiters.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/middleware/rateLimiters.js)) bersifat konstanta terstruktur di kode (bukan env).
- **Normalisasi EOL:** `backend/.env.example` sebelumnya masih `w/crlf` (`git ls-files --eol`) dan akan dinormalisasi menjadi LF murni (`i/lf w/lf`).

---

## 2. Hasil Audit Migrasi (`001`–`012`) & Kompatibilitas `seed_local_dummy.js`

### 2.1 Urutan Migrasi Database Lengkap & Verifikasi DB Lokal

Basis skema dimulai dari `setup_db.sql` lalu dilanjutkan migrasi aditif berurutan `001` s.d. `012`:

| Urutan | File | Cakupan Tabel / Kolom / Guard Utama |
|---|---|---|
| Base | `setup_db.sql` | 8 tabel dasar: `roles`, `users`, `deposits`, `balance_history`, `games`, `product_categories`, `products`, `transactions` (+ seed `roles` awal). *(Catatan: tabel ledger saldo bernama `balance_history`, bukan `balance_mutations`).* |
| 001 | `migrations/001_add_missing_columns.sql` | `users.whitelisted_ips`, `users.h2h_callback_url`, `games.target_id_label`, `products.{validation_config, use_manual_prices, manual_prices}`, `transactions.{provider_sn, check_attempts}`. |
| 002 | `migrations/002_add_missing_tables.sql` | 7 tabel: `password_resets`, `notifications`, `game_margins`, `game_servers`, `promo_codes`, `promo_usages`, `flash_sales`. |
| 003 | `migrations/003_add_safe_indexes.sql` | 21 indeks performa & filter pada `users`, `deposits`, `balance_history`, `games`, `products`, `transactions`, `notifications`, `password_resets`, `flash_sales`, `promo_usages`, `game_servers`. |
| 004 | `migrations/004_add_low_risk_unique_constraints.sql` | 4 unique index: `uq_password_resets_token`, `uq_game_margins_game_id`, `uq_promo_codes_code`, `uq_game_servers_game_server_name`. |
| 005 | `migrations/005_unique_phone_and_register_safety.sql` | Normalisasi E.164 `users.nomor_wa` + partial unique index `uq_users_nomor_wa`. |
| 006 | `migrations/006_add_deposit_method_note.sql` | `deposits.method`, `deposits.note`, `idx_deposits_method`. |
| 007 | `migrations/007_concurrency_and_balance_guards.sql` | Constraint `users_balance_non_negative CHECK (balance >= 0)` + partial unique index `idx_unique_refund_per_invoice` & `idx_unique_deposit_credit`. |
| 008 | `migrations/008_add_payment_methods.sql` | Tabel `payment_methods`, pelebaran `deposits.method VARCHAR(100)`, & seed default `GOPAY`, `DANA`, `SHOPEEPAY`, `SEABANK`. |
| 009 | `migrations/009_transaction_flash_sale_tracking.sql` | `transactions.flash_sale_id`, `transactions.flash_sale_restored`, `idx_transactions_flash_sale_id`. |
| 010 | `migrations/010_h2h_api_key_and_webhook_security.sql` | `users.api_key_hash`, `users.api_key_prefix`, `users.h2h_webhook_secret`, `idx_users_api_key_hash`. |
| 011 | `migrations/011_add_idempotency_keys.sql` | `transactions.ref_id` + `uq_transactions_user_ref_id`, `deposits.idempotency_key` + `uq_deposits_user_idempotency_key`. |
| 012 | `migrations/012_add_admin_audit_logs.sql` | Tabel append-only `admin_audit_logs` + 3 indeks (`idx_admin_audit_logs_admin_created`, `target`, `action_created`). |

- **Status PostgreSQL Lokal Saat Audit (`topup_miku_local@127.0.0.1`):** Seluruh **17 tabel** (`admin_audit_logs`, `balance_history`, `deposits`, `flash_sales`, `game_margins`, `game_servers`, `games`, `notifications`, `password_resets`, `payment_methods`, `product_categories`, `products`, `promo_codes`, `promo_usages`, `roles`, `transactions`, `users`), **64 indeks**, seluruh kolom migrasi `001`–`012`, dan constraint `users_balance_non_negative` **sudah terpasang lengkap**.

### 2.2 Hasil Audit Kompatibilitas `backend/scripts/seed_local_dummy.js`

- **Temuan Saat Audit (`261` baris):**
  1. Katalog dummy (`roles`, `4` games, `game_servers`, `product_categories`, `16` products, promo `MIKUBARU`, flash sale `DUMMY-ML-86`) kompatibel dengan kolom migrasi terbaru (`001`–`009`).
  2. **Belum ada seed akun uji QA (`member`, `reseller H2H`, `admin`)** maupun jaminan ketersediaan baris `payment_methods` jika DB lokal baru mengimpor skema tanpa data awal lengkap.
  3. Penjagaan tambahan `SEC-027` (`DB_HOST` localhost / `127.0.0.1` atau flag `--confirm-local`) belum terpasang di `seed_local_dummy.js`.
- **Rencana Commit 1 pada `seed_local_dummy.js`:**
  - Tambahkan guard `DB_HOST` lokal (`localhost`/`127.0.0.1` atau `--confirm-local`) mendampingi guard `NODE_ENV=production`.
  - Tambahkan seeding idempoten `3` akun QA (`qa_member` role `BRONZE`, `qa_reseller` role `PARTNER` dengan API key 32-byte hash SHA-256 + `h2h_webhook_secret`, dan `qa_admin` role `Admin`) memakai `bcryptjs` **cost `12`** (`BCRYPT_SALT_ROUNDS = 12`) dan nomor WhatsApp format E.164 valid (`+628110000001`..`03`).
  - Tambahkan fallback idempoten `payment_methods` (`GOPAY`, `DANA`, `SHOPEEPAY`, `SEABANK`, `QRIS`) memakai `ON CONFLICT (code) DO NOTHING`.

---

## 3. Hasil Audit Dependensi (`npm audit --omit=dev`)

- Perintah: `cd backend && npm audit --omit=dev`
- Hasil: **`found 0 vulnerabilities`** (nol kerentanan kritis/tinggi/sedang/rendah pada seluruh dependensi runtime produksi: `axios ^1.21.1`, `bcryptjs ^2.4.3`, `cors ^2.8.5`, `dotenv ^16.4.5`, `express ^4.22.3`, `express-rate-limit ^8.7.4`, `jsonwebtoken ^9.0.3`, `pg ^8.23.1`).
- Keputusan: **Tidak menjalankan** `npm audit fix --force`.

---

## 4. Rencana Eksekusi Branch `chore/pre-prod-readiness`

- **COMMIT 1:** Perbarui `backend/.env.example` (LF murni, tambah `NODE_ENV=development` + bagian lengkap & aman tanpa secret) dan `backend/scripts/seed_local_dummy.js` (guard lokal `SEC-027`, 3 akun QA bcrypt cost `12`, H2H API key ter-hash `010`, fallback `payment_methods`). Uji jalankan `npm run seed` pada `topup_miku_local` serta cek `npm run check`, `npm test`, `check-route-overlap.js`.
- **COMMIT 2:** Perbarui `HANDOFF_DEPLOY_UI.md` (menyelaraskan referensi struktur modular & migrasi `001`–`012` pasca-hardening tanpa menghapus konteks produksi VPS) dan lengkapi bagian **Peta Uji QA End-to-End** pada `docs/qa-readiness-checklist.md` (matriks endpoint, rate limiter, CSP/CORS, alur uji lengkap, serta ringkasan hasil `npm test` + 3 skrip PostgreSQL manual).

---

## 5. Query Verifikasi Skema DB (`001`–`012`) untuk Tim QA & Deploy

```sql
-- 1. Pastikan 17 tabel utama ada
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- 2. Pastikan constraint saldo anti-negatif aktif (007)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname IN ('users_balance_non_negative', 'chk_payment_methods_type', 'chk_payment_methods_min_amount');

-- 3. Pastikan partial unique index keamanan finansial & idempotency aktif (005, 007, 010, 011)
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'uq_users_nomor_wa',
    'idx_unique_refund_per_invoice',
    'idx_unique_deposit_credit',
    'idx_users_api_key_hash',
    'uq_transactions_user_ref_id',
    'uq_deposits_user_idempotency_key',
    'idx_admin_audit_logs_admin_created'
  )
ORDER BY tablename, indexname;
```

---

## 6. Panduan Menyiapkan Data Dummy & Menyalakan Server Lokal untuk QA

1. **Siapkan konfigurasi environment lokal:**
   - Salin `backend/.env.example` menjadi `backend/.env` bila belum ada (jangan mengubah atau menimpa secret yang sudah disiapkan tim).
   - Pastikan `NODE_ENV=development`, `DB_HOST=127.0.0.1`, `DB_NAME` mengandung kata `dev`/`local`/`test`, `JWT_SECRET` minimal 32 karakter acak, `CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000`, dan `FOXY_CALLBACK_SECRET` terisi (atau `ALLOW_INSECURE_CALLBACK=true` khusus simulasi lokal non-production).
2. **Pastikan database sudah termigrasi (`setup_db.sql` + `001` s.d. `012`):**
   ```powershell
   # Contoh eksekusi urutan migrasi pada PostgreSQL lokal kosong:
   psql "postgresql://<USER>:<PASSWORD>@localhost:5432/<DB_NAME>" -f .\setup_db.sql
   Get-ChildItem .\migrations\0*.sql | Sort-Object Name | ForEach-Object {
       psql "postgresql://<USER>:<PASSWORD>@localhost:5432/<DB_NAME>" -f $_.FullName
   }
   ```
3. **Jalankan seeder data dummy & akun QA (`non-production` & host lokal):**
   ```powershell
   cd backend
   npm run seed
   ```
   - Skrip [seed_local_dummy.js](file:///d:/DICKY%20BELAJAR/topup-miku/backend/scripts/seed_local_dummy.js) bersifat idempoten dan akan membuat/memperbarui:
     - **4 game** (`Mobile Legends`, `Free Fire`, `Genshin Impact` beserta 4 server, `Valorant`), **16 produk**, promo aktif **`MIKUBARU`** (10%, maks Rp 5.000, min pembelian Rp 10.000, maks 3x/user), flash sale aktif **`DUMMY-ML-86`** (Rp 17.500), serta fallback `payment_methods` (`GOPAY`, `QRIS`).
     - **3 akun uji QA** (hash `bcrypt` cost `12`, format WhatsApp E.164):
       - `qa_member` (role `BRONZE`, email `qa.member@local.test`, WA `+628110000001`, saldo awal Rp 100.000)
       - `qa_reseller` (role `PARTNER`, email `qa.reseller@local.test`, WA `+628110000002`, saldo awal Rp 500.000 + `api_key_hash` & `h2h_webhook_secret`; API key baru dicetak sekali di stdout, gunakan `--rotate-qa-keys` untuk memutar ulang key)
       - `qa_admin` (role `Admin`, email `qa.admin@local.test`, WA `+628110000003`, saldo Rp 0)
     - Password akun QA memakai `SEED_QA_PASSWORD` (atau default lokal non-prod `MikuQaLocal#2026` yang dicetak di konsol saat seeding).
4. **Nyalakan server lokal:**
   ```powershell
   cd backend
   npm start
   ```
   Akses UI di `http://localhost:3000` dan healthcheck di `http://localhost:3000/healthz`.

---

## 7. Matriks Endpoint, Rate Limiter, Header Keamanan, & Validasi (`87` Route)

### 7.1 Rate Limiter & Batas Payload Aktif (`backend/middleware/rateLimiters.js` & `app.js`)

| Limiter / Guard | Target Path | Batas & Key | Perilaku Saat Terlampaui / Salah |
|---|---|---|---|
| `express.json` + `errorHandler` | Semua route JSON | Maks body **`100kb`** (`MAX_BODY_SIZE`) | JSON rusak → `400` JSON bersih; body > 100kb → `413` JSON; error 500 → generik tanpa stack trace/SQL |
| `registerLimiter` | `/api/auth/register` | **5 req / 1 jam** per IP (`trust proxy = 1`) | HTTP `429` |
| `authLimiter` | `/api/auth/{login,forgot-password,reset-password}`, `/api/bot` | **30 req / 15 menit** per IP | HTTP `429` |
| `checkoutLimiter` + `apiLimiter` | `/api/order` | **30 req / 5 menit** (+ 300 req / 5m) per IP | HTTP `429` |
| `apiLimiter` | `/api/user`, `/api/deposit`, `/api/payment-methods`, `/api/foxy/callback`, `/api/full-validate`, `/api/products`, `/h2h` | **300 req / 5 menit** per IP | HTTP `429` |
| `h2hLimiter` + `h2hUserLimiter` | `/h2h/*` (`/h2h/order`, `/h2h/products`, `/h2h/profile`, `/h2h/profile/callback`) | **60 req / 1 menit** per `hashApiKey` (pra-auth) dan per `user.id` (pasca-auth), plus `H2H_DAILY_MAX_*` opsional | HTTP `429` (`success: false`) |

### 7.2 Security Headers & Kebijakan CORS (`backend/middleware/securityHeaders.js`)

- **CSP:** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` (bebas `'unsafe-eval'`, `script-src` bebas `'unsafe-inline'`).
- **Header Lain:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, `Strict-Transport-Security: max-age=31536000; includeSubDomains` (otomatis pada `NODE_ENV=production` atau header HTTPS), serta tanpa header `X-Powered-By`.
- **CORS:** Allowlist eksplisit `ALLOWED_ORIGINS` (`CORS_ORIGINS` env, tanpa wildcard `'*'`). Request browser dari origin asing dibalas JSON **HTTP `403`** (`{ message: 'Origin tidak diizinkan oleh CORS.' }`).

---

## 8. Peta Uji QA End-to-End (Manual Testing Checklist)

### Alur A — Storefront, Validasi ID Game, & Autentikasi (`SEC-014`, `SEC-011`)
- [ ] **Storefront (`/`):** `GET /api/games` & `GET /api/public/flash-sales` menampilkan 4 game seed & 1 item flash sale aktif dengan hitung mundur; layout mobile 360px & desktop 1280px bebas horizontal scroll.
- [ ] **Halaman Produk (`product.html`):** Server dropdown (`Genshin Impact`) memuat dari `GET /api/games/:gameId/servers`; parameter `:gameId` non-angka ditolak `400`.
- [ ] **Validasi ID (`validate.html` / `/api/products/:productId/validate` & `/api/full-validate`):** Menguji ID valid/tidak lengkap/karakter ilegal (`gameCode: "../bad"` ditolak `400`).
- [ ] **Register & Login:** Register normalisasi WA ke `+62...`, menolak duplikat email/username/WA (`409`), menyimpan hash bcrypt cost `12`; login dengan password salah vs user tidak ada mengembalikan `401` pesan generik identik `'Username atau password salah.'`.
- [ ] **Forgot & Reset Password:** `POST /api/auth/forgot-password` mengembalikan `200` pesan identik untuk email terdaftar vs tidak terdaftar (`expires_at <= 30` menit di DB); `POST /api/auth/reset-password` berhasil satu kali dengan token valid, lalu replay token yang sama atau token kedaluwarsa ditolak `400`.

### Alur B — Topup Member (Saldo + Flash Sale + Promo + Idempotency)
- [ ] Login sebagai `qa_member`, pilih `Mobile Legends` → `DUMMY-ML-86` (tampil harga flash sale `Rp 17.500` dan harga coret).
- [ ] Masukkan kode promo `MIKUBARU` (`POST /api/promos/validate`): verifikasi diskon terhitung di server dan tidak bisa menurunkan harga akhir di bawah modal provider (`SEC-003`).
- [ ] Uji `POST /api/order` dengan header `Idempotency-Key` UUID v4: request pertama memproses order (`provider_trx_id` tersimpan di Fase a, koneksi DB dilepas saat HTTP Foxy di Fase b), request ulang dengan `Idempotency-Key` & payload sama membalas `200` (`idempotent: true`) tanpa double debit, payload beda membalas `409`, non-UUID membalas `400`. *(Catatan: bila `FOXY_API_KEY` lokal dummy/kosong dan provider menolak order di Fase b, Fase c otomatis me-refund saldo ke `qa_member` dengan aman).*
- [ ] Cek halaman `invoice.html` & `cek-transaksi.html` (`GET /api/public/transaction/:invoiceId`, `GET /api/public/recent-transactions` menampilkan invoice tersamarkan tanpa PII).

### Alur C — Deposit Member, Persetujuan Admin, & `admin_audit_logs`
- [ ] Login `qa_member` ke `dashboard.html` → ajukan deposit (`POST /api/deposit/request`) via `GOPAY` (memiliki kode unik 3 digit) dan `QRIS` (`unique_code = 0`), serta pastikan > 2 deposit `Pending` ditolak `429`.
- [ ] Login `qa_admin` ke `admin.html` → approve deposit `Pending` (`POST /api/admin/deposits/approve`): saldo user bertambah, tercatat di `balance_history` (`DEPOSIT-<id>`), double approve ditolak `409`. Uji juga reject (`POST /api/admin/deposits/reject`) dengan alasan opsional → status `Rejected`, saldo tidak berubah.
- [ ] Uji validasi & anti-SSRF panel admin:
  - `POST /api/admin/games` dengan `imageUrl: "http://169.254.169.254/latest/meta-data"` atau `"http://127.0.0.1/x.png"` ditolak `400`.
  - Margin negatif (`-5`), diskon flash sale `<= 0`, tanggal berakhir `<` tanggal mulai, dan tipe `depositId: 1.5` ditolak `400`.
- [ ] **Verifikasi `admin_audit_logs` di PostgreSQL:** jalankan `SELECT id, admin_id, action, target_type, target_id, before_data, after_data, ip_address, created_at FROM admin_audit_logs ORDER BY id DESC LIMIT 10;` dan pastikan aksi approve/reject/margin/game/payment method/resolve tercatat tanpa field sensitif.

### Alur D — Reseller H2H API (`X-API-Key`, IP Allowlist, Callback Anti-SSRF, Webhook HMAC)
- [ ] Login `qa_reseller` ke `dashboard.html` → tab API H2H: cek `GET /api/user/apikey` hanya menampilkan `prefix` (bukan key utuh), uji regenerate & revoke key.
- [ ] Atur `whitelisted_ips` (`PUT /api/user/whitelisted-ips`) dengan CIDR (mis. `127.0.0.1/32` atau subnet uji) dan `h2h_callback_url` (`PUT /h2h/profile/callback`): URL `http://`, `localhost`, atau IP privat wajib ditolak `400`; URL `https://` publik valid diterima `200`.
- [ ] Panggil `GET /h2h/products`, `GET /h2h/profile`, dan `POST /h2h/order` dengan header `X-API-Key` + `ref_id`: uji idempotency `ref_id` sama (`200 idempotent:true`), konflik payload (`409`), dan `ref_id` baru.

### Alur E — Webhook Callback Foxy (`POST /api/foxy/callback`) & Keamanan Error
- [ ] Callback tanpa token / token salah ditolak `403` (di `NODE_ENV=production` selalu fail-closed).
- [ ] Callback dengan token valid (`X-Callback-Token` atau `?token=`) mengabaikan `sn`/`message`/`status` mentah di body dan melakukan re-verifikasi ke `/v1/status/:trx_id`: status `SUCCESS` menyimpan `provider_sn` + kirim webhook H2H ber-header `X-Timestamp` & `X-Signature` HMAC-SHA256; `FAILED` me-refund saldo + kuota promo/flash sale secara idempoten; `PARTIAL_REFUND` menahan status agar di-resolve admin (`PUT /api/admin/transactions/:invoiceId/resolve`).
- [ ] Kirim JSON rusak (`{"broken":`) dengan `Content-Type: application/json` dan `Origin: https://evil.example`: pastikan HTTP `400` dan HTTP `403` JSON bersih tanpa stack trace maupun path server.

---

## 9. Ringkasan Hasil Verifikasi Pra-Rilis

- **Lint / Check:** `cd backend && npm run check` → `OK` (`limit_warnings=0`)
- **Route Audit:** `node scripts/check-route-overlap.js` → `route set=87/87, overlap_conflicts=0, effective_chains=87/87`
- **Audit Dependensi Produksi:** `cd backend && npm audit --omit=dev` → **`found 0 vulnerabilities`**
- **Tes Otomatis (`npm test`):** **`205 / 205` lulus** (`30` suite, `0` gagal, `0` skipped)
- **Tes PostgreSQL Nyata (`tests/manual/{concurrency,idempotency,pool}.js`):** Divalidasi ulang pada `topup_miku_local@127.0.0.1` pasca-migrasi `012` dan pasca-`npm run seed` (**semua skenario `[PASS]`, exit code `0`**).
- **Kesiapan Merge ke `main` untuk QA:** Siap 100%.

