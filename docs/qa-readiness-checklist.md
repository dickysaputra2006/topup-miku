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
