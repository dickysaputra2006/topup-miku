# HANDOFF_DEPLOY_UI.md - Project topup-miku

> **Dokumen Handoff Agent & Kesiapan Deploy**
> Harap baca dokumen ini sebelum memulai pekerjaan atau pengujian untuk mendapatkan konteks terbaru arsitektur modular, migrasi database `001`–`012`, hardening keamanan, dan safety rules yang ketat. Untuk checklist lengkap persiapan QA & end-to-end testing, lihat [docs/qa-readiness-checklist.md](file:///d:/DICKY%20BELAJAR/topup-miku/docs/qa-readiness-checklist.md).

## Status Production & Pembaruan Repositori

* Website live: `https://mikutopup.my.id`
* Domain `mikutopup.my.id` dan `www.mikutopup.my.id` sudah aktif.
* HTTPS Certbot sudah aktif dan renewal dry-run pernah sukses.
* VPS Ubuntu, project path: `/var/www/topup-miku`
* PM2 app: `topup-miku`
* Nginx reverse proxy ke backend port `3000`
* Healthcheck: `/healthz`
* Repo sandbox lokal (per 17 Nov 2026):
  * Backend sudah direfaktor modular (`backend/app.js`, `backend/server.js`, `config/`, `middleware/`, `routes/`, `routes/admin/`, `services/`, `jobs/`, `utils/`) dengan `87/87` route & `effective_chains` terverifikasi `scripts/check-route-overlap.js`.
  * Frontend sudah direfaktor modular (`frontend/css/*`, `frontend/js/{shared,product,dashboard,admin}/*`) dan diperbarui ke design system UI-1 s.d. UI-3.
  * Security hardening telah diterapkan untuk `SEC-001`–`SEC-004`, `SEC-006`–`SEC-014`, `SEC-016`, `SEC-020`, `SEC-023` (lihat rincian & sisa temuan fase lanjutan di [AUDIT_SECURITY.md](file:///d:/DICKY%20BELAJAR/topup-miku/AUDIT_SECURITY.md)).
  * `npm audit --omit=dev` di `backend/`: **`0 vulnerabilities`** (`found 0 vulnerabilities`).

## Database

* DB: SumoBase PostgreSQL (lokal sandbox: `topup_miku_local@127.0.0.1`).
* `DB_SSL=false` pada host PostgreSQL yang tidak mendukung SSL required (`backend/config/db.js`).
* Error yang pernah terjadi:
  `server does not support SSL, but SSL was required`
* Solusi: backend PostgreSQL config dibuat conditional via `DB_SSL`.
* Skema & Migrasi lengkap: `setup_db.sql` + **`migrations/001_*.sql` s.d. `migrations/012_*.sql`** (`17` tabel termasuk `payment_methods`, `promo_codes`, `flash_sales`, `balance_history`, dan `admin_audit_logs`; daftar lengkap & query verifikasi tersedia di [migrations/README.md](file:///d:/DICKY%20BELAJAR/topup-miku/migrations/README.md) dan [docs/qa-readiness-checklist.md](file:///d:/DICKY%20BELAJAR/topup-miku/docs/qa-readiness-checklist.md)).
* Migration 005:
  * normalisasi `users.nomor_wa` ke format E.164, contoh `+628...`
  * unique index aktif: `uq_users_nomor_wa`
  * `non_e164_count = 0`
* Sebelum deploy update ke VPS production, pastikan migrasi `006` s.d. `012` sudah diverifikasi/diterapkan berurutan dan `FOXY_CALLBACK_SECRET` + `CORS_ORIGINS` + `JWT_SECRET` (>= 32 karakter) + `NODE_ENV=production` terisi di `.env` VPS.

## Foxy Integration

* Foxy API awalnya kena Cloudflare challenge 403:
  * `cf-mitigated: challenge`
  * response HTML `Just a moment...`
* IP VPS `43.133.133.124` sudah di-whitelist oleh Foxy owner.
* Setelah whitelist, Foxy products API dari VPS sudah HTTP 200.
* Product sync berhasil, pernah upsert 1081 product(s).
* Core order flow real sudah berhasil:
  * invoice `TRX-17781619937353`
  * produk Mobile Legends 3 Diamonds
  * status Berhasil
  * callback Foxy diterima
  * notifikasi user berhasil dibuat.

## Cron

* Cron aktif:
  * pending transaction checker tiap 5 menit
  * product sync tiap 4 jam
* Current crontab:
  * `*/5 * * * * cd /var/www/topup-miku/backend && /usr/bin/node cron_job_script.js --pending-only >> /var/log/topup-miku-cron.log 2>&1`
  * `0 */4 * * * cd /var/www/topup-miku/backend && /usr/bin/node cron_job_script.js --sync-only >> /var/log/topup-miku-cron.log 2>&1`
* Cron lock bug pernah terjadi:
  * `/tmp/topup-miku-cron.lock` tidak terhapus karena `process.exit()` terjadi sebelum `finally`
  * sudah fix dengan `releaseLock()` di `finally`
  * pending-only dan sync-only sudah terbukti menghapus lock
  * cron log sudah menunjukkan pending checker jalan tiap 5 menit.

## UI/UX Phase 2A

* Product page desktop sekarang sudah bagus:
  * layout 2 grid
  * kiri: ID + produk
  * kanan: voucher/promo + payment
* Product page HP aman.
* Mobile checkout step navigation sudah ditambahkan:
  * `1 ID → 2 Produk → 3 Promo → 4 Bayar`
  * hanya muncul di mobile
  * auto-scroll setelah validasi ID dan setelah pilih produk
  * desktop tidak terpengaruh.
* Compare prices sudah diperbaiki:
  * tidak memanjang liar ke bawah
  * list/table scroll internal.
* Admin/dashboard sidebar mobile aman.
* Hamburger desktop sudah ditangani.
* Register phone input country code sudah dirapikan.

## Phase 2B Registration Safety

* Backend register sekarang normalisasi nomor WA.
* Nomor WA disimpan format E.164, contoh `+6281234567890`.
* Duplicate nomor WA ditolak.
* Unique username/email/nomor WA aman.
* Homepage sempat rusak karena `frontend/index.html` dan `frontend/script.js` di-rewrite terlalu besar:
  * gejala: Mobile Game stuck "Memuat game..."
  * tombol Masuk dan notifikasi tidak bisa dipencet
* Emergency hotfix:
  * restore `frontend/index.html` dan `frontend/script.js` dari safe commit `444ca08`
  * lalu hotfix PR masuk ke main commit `7a603e6`
  * VPS `git pull`, status clean, PM2 restart, healthz OK.
* Setelah itu country code picker homepage register diimplement ulang dengan patch kecil, bukan rewrite full file.
* **Catatan penting untuk agent baru:**
  * Jangan rewrite full `index.html`/`script.js` sembarangan.
  * Kalau perlu perubahan homepage, patch kecil saja dan wajib cek:
    * game loading
    * tombol Masuk
    * notifikasi
    * search
    * register modal.

## Known Good Checks

Gunakan command validasi berikut setelah melakukan perubahan:

```bash
cd backend
npm run check                        # cek sintaks JS, batas ukuran file, dan aset frontend
npm test                             # 205/205 tes unit & integrasi (mock DB/Foxy)
cd ..
node scripts/check-route-overlap.js  # pastikan 87/87 route, overlap_conflicts=0
```

Tambahan verifikasi PostgreSQL lokal (membutuhkan DB lokal dengan nama mengandung `dev`/`local`/`test`) dan server live VPS:

```bash
cd backend
npm run seed                         # isi katalog dummy & 3 akun QA lokal (non-production)
node tests/manual/concurrency.js
node tests/manual/idempotency.js
node tests/manual/pool.js
pm2 status
curl https://mikutopup.my.id/healthz
tail -n 80 /var/log/topup-miku-cron.log
```

## Status Roadmap Sebelumnya vs Sisa Lanjutan

Item 1–8 pada catatan historis sebelumnya telah diimplementasikan (`Partial Refund` + resolve admin, deposit manual + `payment_methods` + reject admin, cek transaksi publik, leaderboard tersamarkan, WA Bot Admin API, kontrol validasi PGS/Mobapay & margin/promo/flash sale, perapian UI-1..UI-3, halaman `syarat-ketentuan.html`).

**Sisa pekerjaan lanjutan (bukan blocker QA fungsional lokal):**
* Hardening fase berikutnya (`AUDIT_SECURITY.md`): Admin 2FA TOTP (`SEC-005`), migrasi sesi cookie `HttpOnly` + CSRF & revokasi JWT (`SEC-014`), CA strict DB SSL (`SEC-015`), rate limiter khusus endpoint admin/publik + Turnstile (`SEC-017`), perbaikan cron bulk-disable/advisory lock (`SEC-018`/`019`), kolom `balance_before`/`balance_after` pada `balance_history` (`SEC-022`), serta paginasi server-side (`SEC-024`).
* Operasional produksi (`VPS`): backup PostgreSQL otomatis + uji restore berkala, `logrotate`, monitoring cron/order/callback, serta **dilarang** menjalankan `npm audit fix --force`.

## File Penting (Struktur Modular Terkini)

* `backend/server.js`, `backend/app.js`, `backend/config/*` (`env.js`, `db.js`, `constants.js`)
* `backend/middleware/*` (`auth.js`, `h2hAuth.js`, `rateLimiters.js`, `securityHeaders.js`, `errorHandler.js`, `waBotAuth.js`)
* `backend/routes/*.routes.js` & `backend/routes/admin/*.routes.js`
* `backend/services/*` (`orderService.js`, `refundService.js`, `priceService.js`, `foxyClient.js`, `idempotency.js`, `auditLogService.js`, `notificationService.js`)
* `backend/jobs/*` (`cronJob.js`, `pendingTransactions.js`, `productSync.js`) & `backend/cron_job_script.js`
* `backend/utils/*` (`schemaValidators.js`, `validation.js`, `networkSecurity.js`, `webhookClient.js`, `logger.js`, `mailer.js`, `crypto.js`, `strings.js`)
* `frontend/*.html`, `frontend/css/*`, `frontend/js/{shared,product,dashboard,admin}/*`
* `migrations/001_*.sql` s.d. `migrations/012_add_admin_audit_logs.sql` & `migrations/README.md`
* `docs/qa-readiness-checklist.md`, `AUDIT_SECURITY.md`, `docs/security-hardening-plan.md`

## Safety Rules

* Jangan commit `.env`, API key, token, password, log.
* Jangan log full Axios error.
* Jangan log Authorization/API key.
* Jangan apply migration tanpa preflight.
* Jangan ubah order/saldo/refund flow tanpa test.
* Jangan rewrite full homepage file kecuali benar-benar perlu.
* Jangan `npm audit fix --force`.
* Setelah perubahan, minimal jalankan:
  ```bash
  cd backend
  npm run check
  npm test
  ```
