# HANDOFF_DEPLOY_UI.md - Project topup-miku

> **Dokumen Handoff Agent**
> Harap baca dokumen ini sebelum memulai pekerjaan untuk mendapatkan konteks production terbaru dan aturan main (safety rules) yang ketat.

## Status Production

* Website live: `https://mikutopup.my.id`
* Domain `mikutopup.my.id` dan `www.mikutopup.my.id` sudah aktif.
* HTTPS Certbot sudah aktif dan renewal dry-run pernah sukses.
* VPS Ubuntu, project path: `/var/www/topup-miku`
* PM2 app: `topup-miku`
* Nginx reverse proxy ke backend port `3000`
* Healthcheck: `/healthz`
* Repo workflow: branch kerja `codex-sandbox`, merge PR ke `main`, lalu VPS `git pull origin main`.

## Database

* DB: SumoBase PostgreSQL.
* `DB_SSL=false` karena database tidak support SSL required.
* Error yang pernah terjadi:
  `server does not support SSL, but SSL was required`
* Solusi: backend PostgreSQL config dibuat conditional via `DB_SSL`.
* Migrations 001–005 sudah berhasil.
* Migration 005:
  * normalisasi `users.nomor_wa` ke format E.164, contoh `+628...`
  * unique index aktif: `uq_users_nomor_wa`
  * duplicate nomor WA test user pernah ditemukan, sudah diselesaikan dengan set `nomor_wa = NULL` pada user test
  * `non_e164_count = 0`
  * `npm test` sudah 26/26 pass setelah Phase 2B.

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
cd /var/www/topup-miku/backend
npm run check
npm test
pm2 status
curl https://mikutopup.my.id/healthz
tail -n 80 /var/log/topup-miku-cron.log
```

## Roadmap Sisa

1. **Fitur safety Foxy `PARTIAL_REFUND`**
   * Audit sudah dibuat di `partial_refund_audit.md`.
   * Implementasi BELUM dimulai.
   * Next agent harus lanjut dari audit tersebut.
   * Status `PARTIAL_REFUND` tidak boleh dianggap Success atau Failed otomatis.
   * Tidak boleh refund otomatis.
   * Harus masuk status internal, rekomendasi: `Partial Refund`.
   * Admin nanti harus bisa manual:
     * mark berhasil,
     * refund/gagalkan,
     * keep review/pending.
   * Wajib jaga double-refund.
   * Endpoint admin resolve harus transaction-safe dan pakai role admin.
   * Audit menyarankan tidak perlu migration besar karena `transactions.status` VARCHAR.

2. **Manual Deposit Page + Admin Approval**
   * Metode: GoPay, DANA, ShopeePay, SeaBank.
   * User buat request deposit.
   * Admin approve/reject.
   * Approve menambah saldo, insert balance_history, notifikasi user.

3. **Public Transaction Checker**
   * Cek transaksi via invoice.
   * Tampilkan 10 transaksi terakhir MIKU.
   * Invoice disensor sebagian.
   * Jangan tampilkan data sensitif.

4. **Leaderboard**
   * Top spender, top transaction count, top product/game.
   * Username publik harus disensor sebagian.

5. **Bot WA Admin API**
   * Bot WA bisa add saldo.
   * Bot WA bisa cek/approve deposit pending.
   * Pakai admin API key khusus, optional IP whitelist, rate limit, safe logging.

6. **Admin Product Controls Audit**
   * on/off produk
   * on/off game
   * validasi ID perlu/tidak
   * pilih validator PGS Code per game/produk
   * harga manual
   * margin/flash sale/promo

7. **UI polish tambahan**
   * kecilkan teks pricelist.
   * homepage card produk/game:
     * kotak gambar produk
     * overlay hitam transparan untuk nama
     * nama auto-marquee kanan ke kiri
     * overlay bisa diklik untuk expand nama full
     * tombol close dan "Lanjut Beli"
   * tetap jaga mobile/desktop.

8. **Syarat & Ketentuan page**
   * isi halaman syarat dan ketentuan untuk register
   * link checkbox register harus benar.

9. **Hardening**
   * database backup otomatis
   * logrotate
   * monitoring cron/order/callback
   * npm audit review, jangan `npm audit fix --force` sembarangan.

## File Penting

* `backend/server.js`
* `backend/utils/cronUtils.js`
* `backend/cron_job_script.js`
* `frontend/index.html`
* `frontend/script.js`
* `frontend/product.html`
* `frontend/product.js`
* `frontend/style.css`
* `frontend/style-responsive.css`
* `frontend/admin.html`
* `frontend/admin.js`
* `frontend/dashboard.html`
* `frontend/dashboard.js`
* `frontend/invoice.html`
* `frontend/invoice.js`
* `migrations/005_unique_phone_and_register_safety.sql`
* `partial_refund_audit.md`
* `NEXT_PHASE_ROADMAP.md`

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
