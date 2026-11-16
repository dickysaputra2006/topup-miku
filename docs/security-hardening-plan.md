# Rencana Penguatan Keamanan Backend (`sec/hardening` — SEC-016a s.d. SEC-016d)

**Tanggal:** 17 November 2026  
**Branch Target:** `sec/hardening` (dari `main` @ `438a85a`)  
**Acuan Standar:**
- `.agent/skills/miku-store-pro-standar.md` (Bagian 5: Security & Bagian 9: Checklist Security)
- `.agent/skills/miku-store-code-structure.md` (Batas keras baris file: `route <= 400`, `service <= 600`, `middleware/util <= 300`, `app.js/server.js <= 150`, `test <= 800`)
- `AUDIT_SECURITY.md` (Audit baseline 15 November 2026: `SEC-001` s.d. `SEC-029`)
- `AGENTS.md` (Tanpa perubahan destruktif DB, tanpa menyentuh `.env`, tanpa mengubah kontrak API/rute eksisting)

---

## 1. Perbandingan `AUDIT_SECURITY.md` & Checklist Security (`miku-store-pro-standar.md` §5 & §9) terhadap Kondisi Kode Saat Ini

### 1.1 Evaluasi 10 Poin Checklist Security (§9)

| # | Poin Checklist §9 `miku-store-pro-standar.md` | Status Sebelum `sec/hardening` | Cakupan pada Branch `sec/hardening` |
|---|---|---|---|
| 1 | Harga & total dihitung server; saldo diubah secara atomik + ledger | Terimplementasi (`priceService.js`, `orderService.js`, `refundService.js`, `migrations/007`); kolom `balance_before`/`balance_after` ledger belum dimigrasi (`SEC-022`) | Dipertahankan tanpa perubahan SQL/saldo/row-lock (`SEC-022` dicatat untuk migrasi ledger terpisah) |
| 2 | Idempotency pada order, deposit, callback | Terimplementasi (`idempotency.js`, `deposit.routes.js`, `foxyCallback.routes.js`, `migrations/011`, `SEC-009`/`SEC-001`) | Dipertahankan 100% tanpa perubahan kontrak |
| 3 | Otorisasi server-side di setiap endpoint; tidak ada IDOR | Terimplementasi (`auth.js`, `h2hAuth.js`, `waBotAuth.js`, query berbasis `req.user.id`) | Dipertahankan 100% |
| 4 | Validasi input (skema), query berparameter, output ter-escape | Parameterized query SQL konsisten; validasi khusus sudah ada di order/deposit/paymentMethods; validasi skema Zod menyeluruh admin (`SEC-011`) bertahap | Diperkuat pada validasi URL aset & guard input error parser JSON (**SEC-016a/c**) |
| 5 | CSRF, header keamanan, CORS ketat, rate limit | **Parsial (`SEC-016`, `SEC-023`)**: CSP masih memakai `'unsafe-inline' 'unsafe-eval' https:`, belum ada HSTS/frame-ancestors, penolakan CORS belum mengembalikan JSON 403 via global error handler, global error handler belum terpasang di `app.js` | **Target Utama Batch Ini (`SEC-016a`, `SEC-016c`)**: Global error handler, strict CSP, HSTS, `nosniff`, `Referrer-Policy`, `frame-ancestors 'none'`, CORS allowlist + JSON 403. (Migrasi cookie `HttpOnly` + CSRF token dicatat di roadmap auth) |
| 6 | Webhook diverifikasi (HMAC) dan nominal dicocokkan | Terimplementasi pada callback Foxy (`SEC-001` via `/v1/status` cross-check) & outbound H2H HMAC (`webhookClient.js`, `SEC-007`) | Dipertahankan; Midtrans belum diimplementasikan di repositori ini |
| 7 | API key provider/reseller tidak bocor ke klien/log; key reseller di-hash | API key H2H sudah SHA-256 hash (`SEC-004`, `migrations/010`). **Parsial (`SEC-020`)**: `logger.js` belum meredaksi rekursif field sensitif dalam objek/header; beberapa rute admin/H2H masih memakai `console.error` mentah | **Target Commit 3 (`SEC-016c`)**: Deep redaction di `logger.js` + `logSafeError` di error handler & rute tersentuh |
| 8 | Admin: 2FA + audit log | **Belum (`SEC-005`, `SEC-010`)**: Belum ada `admin_audit_logs`; 2FA TOTP admin memerlukan tabel + alur login UI tersendiri | **Target Commit 2 (`SEC-016b`)**: Migrasi `012_add_admin_audit_logs.sql`, `auditLogService.js`, & audit log 6 rute admin sensitif. (`SEC-005` 2FA TOTP masuk fase auth berikutnya) |
| 9 | Tidak ada secret di repo; `.env.example` tersedia | Terimplementasi (`.env` di `.gitignore`, `backend/.env.example` bersih) | Dipertahankan; pastikan tes keamanan tidak menanam secret produksi |
| 10 | Upload dan URL gambar divalidasi (SSRF/MIME) | **Parsial (`SEC-012`)**: `isSafeAssetUrl` masih mengizinkan `http:` tanpa cek host privat/SSRF; `POST /api/admin/games` (`imageUrl`) belum memvalidasi URL gambar | **Target Commit 3 (`SEC-016c`)**: Anti-SSRF URL validator (`https:` di production, blokir `localhost`/IP privat/link-local/metadata cloud) konsisten di `paymentMethods`, `games`, & `h2h` |

### 1.2 Pemetaan Status Seluruh Temuan `AUDIT_SECURITY.md` (`SEC-001` s.d. `SEC-029`)

| Kelompok ID | Status Saat Ini | Penjelasan & Rencana Tindak Lanjut |
|---|---|---|
| `SEC-001`, `SEC-002`, `SEC-003`, `SEC-004`, `SEC-006`, `SEC-007`, `SEC-008`, `SEC-009`, `SEC-013` | **Selesai sebelum branch `sec/hardening`** | Sudah diimplementasikan dan teruji di modul terfaktorisasi (`foxyCallback.routes.js`, `refundService.js`, `orderService.js`, `priceService.js`, `foxyClient.js`, `userApiKey.routes.js`, `h2hAuth.js`, `webhookClient.js`, `networkSecurity.js`, `idempotency.js`, `rateLimiters.js`, `migrations/010`–`011`, `dependencies.test.js`). Catatan `SEC-001`: fallback query `?token=` tetap dijaga sementara demi kompatibilitas tes integrasi eksisting. |
| `SEC-016` (bagian global error handler & CORS JSON) + `SEC-023` (bagian penolakan CORS) | **Dikerjakan di Commit 1 (`SEC-016a`)** | Menambah `backend/middleware/errorHandler.js` dan memasangnya di akhir stack middleware `backend/app.js` untuk menangkap JSON `SyntaxError` (`400`), error CORS (`403`), dan error 500 tanpa membocorkan stack trace/SQL/path file. |
| `SEC-010` (bagian Audit Log Admin) | **Dikerjakan di Commit 2 (`SEC-016b`)** | Menambah `migrations/012_add_admin_audit_logs.sql`, `backend/services/auditLogService.js`, dan pencatatan audit pada mutasi admin (`balance`, `deposits`, `transactions`, `margins`, `games`, `paymentMethods`). |
| `SEC-016` (CSP/HSTS/Security Headers), `SEC-023` (CORS ketat), `SEC-020` (Redaksi Log), `SEC-012` (Anti-SSRF URL Gambar/Callback) | **Dikerjakan di Commit 3 (`SEC-016c`)** | Memperketat `backend/middleware/securityHeaders.js`, menambah deep object/header redaction di `backend/utils/logger.js` (+ sanitasi `console.error` di rute tersentuh), dan memperketat validator anti-SSRF pada `validation.js`, `paymentMethods.routes.js`, `games.routes.js`, dan verifikasi `h2h.routes.js`. |
| `SEC-005`, `SEC-011`, `SEC-014`, `SEC-015`, `SEC-017`, `SEC-018`, `SEC-019`, `SEC-021`, `SEC-022`, `SEC-024`, `SEC-025`, `SEC-026`, `SEC-027`, `SEC-028`, `SEC-029` | **Di luar cakupan Commit 1–4 (Roadmap Lanjutan)** | Memerlukan perubahan skema/kontrak UI/env/rate-limit terpisah (`ADMIN TOTP 2FA`, `bcrypt cost >= 12` + `HttpOnly` cookie CSRF, CA SSL PostgreSQL, rate limiter endpoint admin/publik & Turnstile, paginasi server, ledger `balance_before/after`, perbaikan cron advisory lock & bulk disable guard, penghapusan `/api/test`, validasi param ID seragam). Sengaja tidak diubah agar perubahan tetap fokus dan zero-regression pada seluruh kontrak API eksisting. |

---

## 2. Rencana Implementasi Per Commit (`sec/hardening`)

### Commit 1 (`SEC-016a`) — Global Error Handler & Sanitasi Kebocoran Error

- **File baru:** `backend/middleware/errorHandler.js` (target <= 100 baris, batas keras <= 300 baris)
  - Menangani error parser body JSON (`err.type === 'entity.parse.failed'` atau `err instanceof SyntaxError && err.status === 400 && 'body' in err`) dengan respons HTTP `400` JSON generik (`{ message: 'Format JSON pada request body tidak valid.' }`) tanpa stack trace atau detail parser internal.
  - Menangani payload terlalu besar (`err.type === 'entity.too.large'`) dengan HTTP `413` JSON generik.
  - Menangani penolakan CORS (`err.isCorsError === true` atau status `403` dari middleware CORS) dengan HTTP `403` JSON terstruktur.
  - Untuk error tak terduga (`5xx` / tanpa status eksplisit < 500): mencatat log terstruktur lewat `logSafeError` (tanpa rahasia) dan mengembalikan JSON generik HTTP `500` (`{ message: 'Terjadi kesalahan internal pada server.' }`) tanpa `err.stack`, tanpa path filesystem server, dan tanpa query SQL.
  - Menjaga perilaku jika `res.headersSent` sudah `true` dengan delegasi ke `next(err)`.
- **File diubah:** `backend/app.js` (tetap <= 150 baris)
  - Impor `{ errorHandler }` dari `./middleware/errorHandler` dan pasang **paling akhir** tepat sebelum `return app;` (setelah seluruh route terpasang).
- **Dampak `scripts/dump-routes.js` & `scripts/check-route-overlap.js`:**
  - Hasil inspeksi `scripts/dump-routes.js` (`collectEffectiveChains`): middleware 4-argumen yang dipasang paling akhir setelah seluruh router tidak mengubah daftar 87 route (`docs/routes.baseline.txt`) maupun rantai middleware efektif ke-87 route tersebut (`docs/effective-chain.baseline.txt`) karena ke-87 route sudah di-emit sebelum layer `ERR` di ujung stack. Tetap diverifikasi langsung via `node scripts/check-route-overlap.js`.
- **Kompatibilitas tes:** Kompatibel penuh dengan `securityErrorExposure.test.js` dan `dependencies.test.js` (`resBadJson.status === 400`).

### Commit 2 (`SEC-016b`) — Audit Log Aksi Admin (`SEC-010`)

- **File baru:**
  1. `migrations/012_add_admin_audit_logs.sql` (idempoten, non-destruktif):
     - `CREATE TABLE IF NOT EXISTS admin_audit_logs`:
       - `id BIGSERIAL PRIMARY KEY`
       - `admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL`
       - `action VARCHAR(100) NOT NULL`
       - `target_type VARCHAR(60) NOT NULL`
       - `target_id VARCHAR(120)`
       - `before_data JSONB`
       - `after_data JSONB`
       - `ip_address VARCHAR(64)`
       - `user_agent VARCHAR(512)`
       - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
     - Indeks: `idx_admin_audit_logs_admin_created (admin_id, created_at DESC)`, `idx_admin_audit_logs_target (target_type, target_id, created_at DESC)`, `idx_admin_audit_logs_created_at (created_at DESC)`.
  2. `backend/services/auditLogService.js` (target <= 150 baris, batas keras <= 600 baris):
     - Helper `extractRequestAuditMeta(req)` untuk mengambil `adminId`, `ipAddress` (tanpa memalsukan header; `req.ip`), dan `userAgent` terpotong aman (`<= 512` karakter).
     - Helper `sanitizeAuditPayload(data)` memakai `redactSensitiveData` (atau sanitasi kunci sensitif) sebelum konversi JSON ke `before_data` / `after_data`.
     - Fungsi `recordAdminAuditLog(queryable, entry)`:
       - Menulis `INSERT INTO admin_audit_logs (...)` memakai query berparameter.
       - **Fail-safe & transaksi-aman:** Dipanggil dengan `pool` setelah mutasi utama berhasil/commit (atau dibungkus `try/catch` yang mencatat kegagalan via `logSafeError`), sehingga kegagalan non-kritis pada penulisan log (atau database uji dengan mock terbatas) **tidak pernah membatalkan atau merusak atomisitas transaksi uang utama**.
- **File diubah:**
  1. `migrations/README.md` — dokumentasi skema & perintah `psql` manual untuk migrasi `012`.
  2. `backend/app.js` — injeksikan `recordAdminAuditLog` ke 6 modul route admin terkait.
  3. 6 modul route admin (masing-masing tetap <= 400 baris, menerima opsional `recordAdminAuditLog` dengan fallback default agar tes unit/factory terisolasi tetap kompatibel):
     - `backend/routes/admin/balance.routes.js` (`admin.balance.add`, `admin.balance.reduce` — mencatat nominal, tipe, alasan/referensi)
     - `backend/routes/admin/deposits.routes.js` (`admin.deposit.approve`, `admin.deposit.reject` — mencatat `before_data` status `'Pending'` & nominal, `after_data` status `'Approved'`/`'Rejected'` & alasan bila ada)
     - `backend/routes/admin/transactions.routes.js` (`admin.transaction.resolve` — mencatat `before_data` status awal & `after_data` aksi `success`/`refund` + catatan)
     - `backend/routes/admin/margins.routes.js` (`admin.game_margins.update`, `admin.product_manual_prices.update` — mencatat `before_data` & `after_data` perubahan margin/harga manual)
     - `backend/routes/admin/games.routes.js` (`admin.roles.update`, `admin.game.create`, `admin.game.status`, `admin.game.needs_server`)
     - `backend/routes/admin/paymentMethods.routes.js` (`admin.payment_method.create`, `admin.payment_method.update`, `admin.payment_method.delete` — termasuk `before_data` & `after_data`)
- **Catatan Keamanan Jalur Uang:** Tidak ada satu pun query saldo, `SELECT ... FOR UPDATE`, guard `balance >= $1`, atau `rollbackTransactionResources` yang diubah urutan atau kondisi transaksinya.

### Commit 3 (`SEC-016c`) — Security Headers, CORS Ketat, Redaksi Log & Anti-SSRF

- **File diubah:**
  1. `backend/middleware/securityHeaders.js` (<= 80 baris):
     - `Content-Security-Policy` ketat yang kompatibel dengan seluruh 13 halaman HTML & CSS/JS frontend:
       - `default-src 'self'`
       - `script-src 'self'` (tanpa `'unsafe-inline'`, tanpa `'unsafe-eval'`, tanpa domain `https:` terbuka)
       - `style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com` (diperlukan FontAwesome CDN, Google Fonts `base.css`, dan dua markup inline style dinamis di `frontend/js/dashboard/deposit.js`)
       - `font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com`
       - `img-src 'self' data: https:` (menjaga SVG `data:image/svg+xml` di `portal.css`/`product.css` serta gambar game/QRIS tervalidasi)
       - `connect-src 'self'`
       - `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`
     - Header keamanan lain: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, serta `Strict-Transport-Security: max-age=31536000; includeSubDomains` saat `NODE_ENV === 'production'` atau koneksi HTTPS (`req.secure` / `x-forwarded-proto: https`). Hapus header usang `X-XSS-Protection`.
     - `corsMiddleware`: tetap memeriksa allowlist eksplisit `ALLOWED_ORIGINS` (tanpa fallback wildcard `'*'`). Penolakan origin menghasilkan `Error` dengan `statusCode = 403` dan `isCorsError = true` agar `errorHandler` selalu membalas JSON HTTP `403`. Header yang diizinkan dideklarasikan eksplisit (`Content-Type, Authorization, X-API-Key, Idempotency-Key, X-Callback-Token`).
  2. `backend/utils/logger.js` (<= 160 baris):
     - Tambah `redactSensitiveData(value)` secara rekursif (anti-circular dengan `WeakSet`) untuk menyensor kunci sensitif: `password`, `newPassword`, `currentPassword`, `token`, `resetToken`, `jwt`, `api_key`, `apiKey`, `api_key_hash`, `secret`, `webhookSecret`, `h2h_webhook_secret`, `authorization`, `x-api-key`, `x-callback-token`, `x-signature`, `cookie`, `set-cookie`, dan pola nilai Bearer/JWT di string.
     - Pastikan `safeErrorDetail`, `logSafeError`, dan `safeAxiosError` meredaksi header/body/detail error memakai `redactSensitiveData` dan `redactSensitiveText`.
     - Perbarui `backend/middleware/errorHandler.js` serta rute tersentuh (`routes/admin/{balance,deposits,transactions,margins,games,paymentMethods}.routes.js` dan `routes/h2h.routes.js`) agar memakai `logSafeError` menggantikan `console.error(..., error)` mentah.
  3. `backend/utils/validation.js` (<= 170 baris) + penerapan di rute:
     - Perketat `isSafeAssetUrl(rawUrl)`:
       - Terima path relatif aman lokal yang diawali satu `/` (mis. `/images/qris.png` atau `/qris.png`), sambil menolak `//`, `\`, segmen traversal `..`, karakter kontrol, dan skema terselubung.
       - Untuk URL eksternal: wajib parsing `new URL(...)`, tolak kredensial (`username`/`password`), blokir `localhost`, domain `.local`/`.internal`, `metadata.google.internal`, dan seluruh IP privat/loopback/link-local/CGNAT via `isRestrictedHostname` & `isRestrictedIpForOutbound` dari `utils/networkSecurity.js`.
       - Wajibkan skema `https:` pada `NODE_ENV === 'production'`; pada non-production tolak tetap skema non-`http(s):` (`javascript:`, `data:`, `file:`, dll.) dan seluruh target SSRF terbatas di atas.
     - Terapkan `isSafeAssetUrl` secara konsisten pada:
       - `backend/routes/admin/paymentMethods.routes.js` (`qris_image_url`, memakai validator terbaru)
       - `backend/routes/admin/games.routes.js` (`POST /api/admin/games` untuk `imageUrl`, memakai `normalizeString` & tolak `400` jika tidak lolos `isSafeAssetUrl`)
       - `backend/routes/h2h.routes.js` (pertahankan `validateWebhookUrl` pada `PUT /h2h/profile/callback` yang sudah mewajibkan `https:` dan memblokir DNS/IP SSRF + ganti `console.error` ke `logSafeError`).

### Commit 4 (`SEC-016d`) — Tes Integrasi Keamanan & Pembaruan Dokumentasi

- **File baru:** `backend/tests/integration/securityHardening.test.js` (target <= 450 baris, batas keras <= 800 baris, dapat dijalankan standalone via `node --test tests/integration/securityHardening.test.js`):
  1. Malformed JSON (`{"broken":`) menghasilkan HTTP `400` JSON bersih tanpa stack trace / file path.
  2. Unexpected synchronous error di route / `errorHandler` menghasilkan HTTP `500` JSON generik tanpa membocorkan stack trace, file path (`backend/`), atau detail internal.
  3. Penolakan origin CORS tak dikenal (`https://evil.example`) menghasilkan HTTP `403` JSON (`Access-Control-Allow-Origin` tidak bernilai `'*'`) dan origin terdaftar diizinkan.
  4. Security headers (`Content-Security-Policy` tanpa `'unsafe-eval'` dan `script-src 'self'` tanpa `'unsafe-inline'`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Strict-Transport-Security` pada HTTPS/production) hadir konsisten di respons.
  5. `auditLogService.recordAdminAuditLog` + integrasi rute admin (`balance/add`, `deposits/approve`, `transactions/:invoiceId/resolve`, `games/:gameId/margins`, `games`, `payment-methods`) mencatat audit log terparameter tanpa secret bocor dan tetap fail-safe saat error log terjadi.
  6. `logger.redactSensitiveData` & `safeErrorDetail` meredaksi field/header `password`, `token`, `jwt`, `api_key`, `secret`, `authorization`, `x-api-key`, `x-callback-token`.
  7. Anti-SSRF `isSafeAssetUrl` & endpoint terkait (`POST /api/admin/games`, `POST /api/admin/payment-methods`, `PUT /h2h/profile/callback`) memblokir `http://127.0.0.1`, `http://localhost`, `http://169.254.169.254/latest/meta-data`, `https://10.0.0.5/x.png`, `https://[::1]/x.png`, `javascript:alert(1)`, mewajibkan `https:` di `NODE_ENV=production`, serta mengizinkan URL `https://` publik valid dan path lokal `/images/...`.
- **Pembaruan dokumen:**
  - `docs/refactor-baseline-tests.txt` (tambahkan seluruh judul tes baru dalam urutan alfabetis atau sesuai struktur baseline yang ada — cek penamaan di akhir).
  - `AUDIT_SECURITY.md` (tambahkan catatan pembaruan status pasca-hardening `SEC-001..SEC-004, SEC-006..SEC-010, SEC-012..SEC-013, SEC-016, SEC-020, SEC-023` tanpa mengubah riwayat temuan 15 Nov 2026).
  - `docs/security-hardening-plan.md` (catat hash commit akhir, jumlah baris aktual file baru/ubah, serta hasil verifikasi).

---

## 3. Verifikasi Wajib Tiap Tahap

1. `cd backend && npm.cmd run check` (`limit_warnings=0`)
2. `cd backend && npm.cmd test` (seluruh test suite lulus, 0 gagal, 0 skip)
3. `node scripts/check-route-overlap.js` (`route set=87/87`, `overlap_conflicts=0`, `effective_chains=87/87`)
4. Normalisasi LF murni & verifikasi Git pasca-commit:
   - `git status --short` (kosong)
   - `git worktree list` (1 entri)
   - `git ls-files --eol` pada seluruh file yang diubah/ditambah (`i/lf w/lf`)

---

## 4. Ringkasan Eksekusi & Ukuran File Aktual

- **Commit 1 (`SEC-016a` — `05ec7c8`):**
  - `backend/middleware/errorHandler.js` (`50` baris, batas `<= 300`)
  - `backend/app.js` (`108` -> `110` baris setelah Commit 2, batas `<= 150`)
  - `docs/security-hardening-plan.md`
- **Commit 2 (`SEC-016b` — `056f509`):**
  - `migrations/012_add_admin_audit_logs.sql` (`40` baris)
  - `migrations/README.md` (`255` baris)
  - `backend/services/auditLogService.js` (`153` baris, batas `<= 600`)
  - Rute admin (`balance.routes.js`: `104`, `deposits.routes.js`: `239`, `transactions.routes.js`: `186`, `margins.routes.js`: `142`, `games.routes.js`: `223`, `paymentMethods.routes.js`: `274` baris pasca Commit 3, seluruhnya `<= 400`)
- **Commit 3 (`SEC-016c` — `c17b926`):**
  - `backend/middleware/securityHeaders.js` (`63` baris, batas `<= 300`)
  - `backend/utils/logger.js` (`143` baris, batas `<= 300`)
  - `backend/utils/validation.js` (`189` baris, batas `<= 300`)
  - `backend/routes/h2h.routes.js` (`187` baris, batas `<= 400`) + sanitasi `logSafeError` dan anti-SSRF pada rute admin tersentuh
- **Commit 4 (`SEC-016d` — `aa7cbee`):**
  - `backend/tests/integration/securityHardening.test.js` (`7` kasus uji integrasi baru, batas `<= 800`)
  - Pembaruan `docs/refactor-baseline-tests.txt` (`192` -> `199` tes), `AUDIT_SECURITY.md`, dan `docs/security-hardening-plan.md`

---

## 5. Rencana Batch 2: Autentikasi (`SEC-014`) & Validasi Skema Input (`SEC-011`)

**Branch Target:** `sec/auth-and-validation` (dari `main` @ `db8d37b`)  
**Batas Ukuran Kode:** `route <= 400`, `service <= 600`, `middleware/util <= 300`, `test <= 800`, `app.js/server.js <= 150` baris.

### 5.1 Hasil Audit Celah `SEC-014` (Autentikasi, Bcrypt Cost, & Reset Password)

| File | Kondisi Sebelum `sec/auth-and-validation` | Perbaikan Batch 2 (`COMMIT 1 — SEC-014`) |
|---|---|---|
| `backend/routes/auth.routes.js` (`211` baris) | `register` & `reset-password` memakai `bcrypt.hash(..., 10)`; `forgot-password` destructuring `req.body` di luar `try/catch`, expiry token reset `3600000` ms (`1 jam`), tidak menghapus token lama, dan menahan koneksi DB saat `sendPasswordResetEmail`; `reset-password` destructuring `req.body` di luar `try/catch`, query `WHERE token IN ($1, $2)` (fallback plaintext) **tanpa `FOR UPDATE`** sehingga rawan pemakaian ganda paralel. | Naikkan ke `BCRYPT_SALT_ROUNDS = 12` (`register` & `reset-password`, `bcrypt.compare` tetap mendukung hash lama cost 10); cek tipe & objek body dengan aman di semua endpoint auth; pada `forgot-password`: masa berlaku token `30 * 60 * 1000` ms (`30 menit`), hapus token reset lama + simpan hash SHA-256 token baru dalam transaksi lalu release koneksi sebelum `sendPasswordResetEmail`, dan selalu kirim respons HTTP `200` generik identik untuk email terdaftar vs tidak terdaftar; pada `reset-password`: `BEGIN -> SELECT ... WHERE token = $1 FOR UPDATE` (hanya `tokenHash`, tanpa fallback plaintext) -> verifikasi `expires_at > NOW()` -> `DELETE FROM password_resets WHERE email = $1` + update password dalam satu transaksi atomik (`client.release()` di `finally`). |
| `backend/routes/user.routes.js` (`222` baris) | `PUT /api/user/password` tidak memeriksa tipe string & `isValidPassword(newPassword)`, tidak memeriksa `!user`, memakai `bcrypt.hash(newPassword, 10)`, dan memakai `console.error`. | Validasi objek `req.body`, pastikan `currentPassword` & `newPassword` bertipe string, terapkan `isValidPassword(newPassword)` (`8-128` karakter), cek `rows.length === 0` (`404`), naikkan `bcrypt.hash` ke cost `12`, dan gunakan `logSafeError`. |
| `backend/middleware/auth.js` (`68` baris) | `jwt.verify(token, jwtSecret)` belum membatasi `algorithms: ['HS256']`. | Terapkan `{ algorithms: ['HS256'] }` pada `protect` & `softProtect` (100% kompatibel dengan `jwt.sign` & `auth.test.js`). *(Catatan: migrasi JWT ke cookie `HttpOnly` + token revokasi penuh `token_version` lintas frontend/backend dijadwalkan fase terpisah agar tidak memutus kontrak SPA `Bearer` eksisting).* |

### 5.2 Hasil Audit Celah `SEC-011` (Validasi Skema Ketat & Batas Baris File)

- `backend/utils/validation.js` saat ini `189` baris dan `backend/routes/public.routes.js` saat ini `368` baris. Agar seluruh file util tetap `<= 300` baris dan route tetap `<= 400` baris, seluruh validator skema baru ditempatkan pada modul terpisah: **`backend/utils/schemaValidators.js`** (`<= 300` baris, tanpa dependensi eksternal).
- Daftar helper pada `backend/utils/schemaValidators.js`:
  - `getBodyObject(req)` / `requirePlainObject(value, label)`
  - `requireString(value, label, opts)` & `optionalTrimmedString(value, label, opts)`
  - `requirePositiveInt(value, label, opts)` & `optionalPositiveInt(value, label, opts)`
  - `requireBoundedNumber(value, label, opts)`
  - `requireBoolean(value, label)` & `optionalBoolean(value, label, fallback)`
  - `requireEnum(value, label, allowed, opts)`
  - `requireValidDate(value, label)`
  - `validatePromoRulesObject(rules)` & `validateManualPricesMap(manualPrices)`

| Commit | File Target | Ringkasan Penguatan Skema (`SEC-011`) |
|---|---|---|
| **COMMIT 2 (`SEC-011a`)** | `backend/utils/schemaValidators.js` (baru), `promos.routes.js` (`56` baris), `flashSales.routes.js` (`71`), `margins.routes.js` (`142`), `products.routes.js` (`271`), `games.routes.js` (`223`), `deposits.routes.js` (`239`), `transactions.routes.js` (`186`), `paymentMethods.routes.js` (`274`) | Validasi body plain object, param ID integer positif (`:id`, `:gameId`, `:productId`, `:invoiceId`), string panjang terukur & enum (`type`, `status`, `action`, `promo_code`), rentang angka (`margin 0..500%`, `price/discount_price 1..100.000.000`, `percentage 0.01..100`, `depositId` positive integer tanpa float, `max_uses` int positif), tanggal valid & `end_at > start_at`, struktur `rules`/`manual_prices`, pertahankan audit log `SEC-016b` & query berparameter, serta konversi `console.error` ke `logSafeError`. *(Catatan: `balance.routes.js` tidak diubah perilaku statusnya pada batch ini; validasi lanjutan nominal saldo manual dicatat ke fase berikutnya).* |
| **COMMIT 3 (`SEC-011b`)** | `user.routes.js` (`222` baris), `catalog.routes.js` (`194`), `public.routes.js` (`368`) | Validasi body plain object & batas string/email/telepon pada `PUT /api/user/profile`, validasi param ID & field `validate`/`full-validate`/`promos/validate` pada `catalog.routes.js` (dengan whitelist `rules.allowedRegions`/`disallowedRegions` dan `gameCode` aman), validasi `:gameId` & `:gameName` pada `public.routes.js` sambil mempertahankan kompatibilitas `publicEndpoints.test.js` (`?limit=999` clamp `50`, `?period=invalid` fallback `'all_time'`), mempertahankan batas `<= 400` baris, serta memastikan urutan middleware / `effective_chains` (`87/87`) tetap identik. |
| **COMMIT 4 (`SEC-014/011-test`)** | `backend/tests/integration/authAndSchemaHardening.test.js` (baru, `<= 600` baris), `docs/refactor-baseline-tests.txt`, `AUDIT_SECURITY.md`, `docs/security-hardening-plan.md` | Uji otomatis bcrypt cost `>= 12`, token reset kedaluwarsa (`> 30` menit) & single-use atomik (`FOR UPDATE`/replay gagal), anti-enumeration `forgot-password`, dan penolakan HTTP `400` pada payload tipe/rentang/panjang/enum ilegal di rute admin & publik. Diikuti verifikasi manual 3 skrip PostgreSQL (`concurrency.js`, `idempotency.js`, `pool.js`). |
