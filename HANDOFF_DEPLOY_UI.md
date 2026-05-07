# HANDOFF_DEPLOY_UI.md - Project topup-miku

Laporan ini merangkum seluruh progres pengembangan, deployment, dan perbaikan UI/UX pada project `topup-miku`. Laporan ini disusun untuk memastikan transisi pekerjaan antar agent/AI berjalan mulus tanpa kehilangan konteks teknis.

---

## 1. Ringkasan Project

* **Nama Project:** topup-miku
* **Stack Utama:** 
    * Backend: Express.js (Node.js)
    * Frontend: Static HTML, CSS (Vanilla), JavaScript
    * Database: PostgreSQL
* **Target Deployment:** VPS SumoPod Ubuntu 24.04
* **Public IP VPS:** `43.133.133.124`
* **Domain Utama:** `mikutopup.my.id`
* **Database Target:** SumoBase/SumoPod PostgreSQL
* **Alur Deployment (GitHub Flow):**
    * Development dilakukan secara lokal.
    * Perubahan di-commit dan di-push ke branch `main`.
    * Di VPS, dilakukan `git pull origin main`.
    * Backend di-restart menggunakan PM2.

## 2. Status Deploy VPS Saat Ini

Seluruh infrastruktur dasar di VPS telah berhasil dikonfigurasi:

* **Repository:** Clone sukses di `/var/www/topup-miku` (Branch: `main`).
* **Backend:** Berjalan lancar di bawah kendali PM2.
* **Service Persistence:** PM2 terintegrasi dengan systemd (`pm2-ubuntu.service`) agar otomatis jalan saat VPS reboot.
* **Health Check Lokal:** Berhasil via `curl http://127.0.0.1:3000/healthz`.
* **Nginx Reverse Proxy:** Mengarah ke port 3000. Konfigurasi di `/etc/nginx/sites-available/topup-miku`.
* **Health Check Publik:** Berhasil via `curl http://43.133.133.124/healthz`.
* **Status DNS:** 
    * A record `mikutopup.my.id` -> `43.133.133.124` (Selesai/Propagasi).
    * CNAME `www.mikutopup.my.id` -> `mikutopup.my.id` (Selesai/Propagasi).
* **SSL (Certbot):** **BELUM DIJALANKAN**. Menunggu DNS resolve secara konsisten di semua region sebelum instalasi sertifikat.

## 3. Database Setup & Catatan Penting SSL

Terjadi kendala saat koneksi database awal karena pengaturan SSL SumoBase:

* **Kronologi:**
    1. Awalnya `PGSSLMODE=require` gagal dengan error: `server does not support SSL, but SSL was required`.
    2. Koneksi berhasil setelah diubah ke `PGSSLMODE=disable`.
* **Konfigurasi DB:**
    * **Host:** `pgsql-dbas-jkt-001.sumobase.my.id`
    * **Port:** `65432`
    * **Database Name:** `dbb07df9d5e2bc08c3`
    * **Kredensial:** (Tersimpan di `.env` VPS, jangan ditulis di sini).
* **Perbaikan Kode:** Backend telah dimodifikasi agar fleksibel terhadap status SSL DB melalui env `DB_SSL`.
    * Digunakan di: `backend/server.js` dan `backend/utils/cronUtils.js`.
    * Logika: `dbSslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true'`.
    * Di VPS Production, set `DB_SSL=false`.

## 4. Migration Database yang Sudah Dijalankan

Semua tahap migrasi telah dijalankan secara berurutan dan sukses:

1. `setup_db.sql` (Skema awal & Seed data).
2. `migrations/001_add_missing_columns.sql`
3. `migrations/002_add_missing_tables.sql`
4. `migrations/003_add_safe_indexes.sql`
5. `migrations/004_add_low_risk_unique_constraints.sql`

**Hasil Verifikasi Final:**
* **Tabel:** 15 tabel utama tersedia.
* **Role:** 7 role default (Admin, Partner, Gold, Silver, Bronze, User, Guest).
* **Skema:** 8 kolom tambahan telah masuk.
* **Performa:** 21 index (`idx_%`) dan 4 unique constraint (`uq_%`) telah diterapkan.

## 5. PM2 dan Nginx

* **PM2 App Name:** `topup-miku`
* **Path Eksekusi:** `/var/www/topup-miku/backend/server.js`
* **Status:** Online/Running.
* **Nginx Config Path:** `/etc/nginx/sites-available/topup-miku`
* **Upstream:** `http://127.0.0.1:3000`

## 6. Frontend UI/Responsive Audit

Dilakukan audit mendalam terhadap seluruh file frontend (`.html`, `.css`, `.js`).

**Masalah yang Ditemukan (Sebelum Perbaikan):**
1. **Desktop Spacing:** Terlalu banyak ruang kosong (whitespace), elemen terasa terlalu besar dan tidak estetik.
2. **Hero Banner:** Terlalu tinggi di PC, menghabiskan area "above the fold".
3. **Pricelist Mobile Bug:** Table harga yang lebar memaksa seluruh layout (termasuk sidebar list game) ikut bergeser secara horizontal.
4. **Layout Global:** Kurangnya `overflow-x: hidden` yang menyebabkan "layar goyang" di mobile.
5. **UI Consistency:** Border-radius dan bayangan (shadow) tidak seragam antar komponen.

## 7. Perubahan UI yang Telah Dilakukan

Kami mengambil pendekatan **Patch CSS** agar tidak mengganggu file `style.css` original yang sudah sangat besar.

* **Dibuat File Baru:** `frontend/style-responsive.css`.
* **Implementasi:** Seluruh 11 file HTML utama telah ditambahkan tag link ke CSS patch ini.
* **Area Perbaikan:**
    * **Global:** Menambahkan `overflow-x: hidden` pada body dan font Inter dari Google Fonts.
    * **Header:** Dibuat lebih compact (56px) untuk hemat ruang.
    * **Hero:** Tinggi banner dikurangi menggunakan `clamp()` agar responsif.
    * **Pricelist Fix:** Mengisolasi horizontal scroll hanya pada `.table-container`. Sidebar list game kini tetap diam di tempat (fixed/sticky) saat tabel digeser.
    * **Admin & Dashboard:** Perbaikan `min-width` agar tidak memicu overflow di layar kecil.
    * **Grid:** Grid game card disesuaikan (clamp) agar proporsional di HP kecil maupun Monitor besar.
    * **Modal & Form:** Ukuran tap target (min 42px) untuk kenyamanan pengguna mobile/Android.

## 8. Pembersihan File Temporary

* File `frontend/style.css.bak` telah dihapus.
* File `.env` lokal tidak masuk ke repository.
* Folder `node_modules` diabaikan sesuai `.gitignore`.
* File helper migrasi yang sudah tidak diperlukan telah dibersihkan.

## 9. Test yang Sudah Dijalankan

Verifikasi backend berjalan sempurna:
* **Command:** `cd backend && npm run check` -> **Success** (Syntax & Structure OK).
* **Command:** `npm test` -> **12/12 Tests Pass**.
* **Status:** Perbaikan UI tidak merusak logika API backend.

## 10. Sisa Pekerjaan / Next Steps

### [HIGH PRIORITY]
1. **SSL Activation:** Tunggu DNS root resolve stabil, lalu jalankan:
   `sudo certbot --nginx -d mikutopup.my.id -d www.mikutopup.my.id`
2. **Review UI:** Lakukan review visual pada browser nyata. Jika oke, commit & push perubahan UI ini.
3. **VPS Sync:** Pull perubahan terbaru ke VPS dan restart PM2:
   `git pull origin main` -> `cd backend && npm ci --omit=dev` -> `pm2 restart topup-miku`

### [MEDIUM PRIORITY]
1. **Setup Cron:** Cron job sekarang mendukung mode argumen terpisah. Gunakan jadwal berikut di VPS:

   ```bash
   # Cek & resolve pending transactions — setiap 5 menit
   */5 * * * * cd /var/www/topup-miku/backend && /usr/bin/node cron_job_script.js --pending-only >> /var/log/topup-miku-cron.log 2>&1

   # Sync produk dari Foxy — setiap 4 jam (bukan 5 menit, terlalu sering)
   0 */4 * * * cd /var/www/topup-miku/backend && /usr/bin/node cron_job_script.js --sync-only >> /var/log/topup-miku-cron.log 2>&1
   ```

   > **Catatan Cloudflare:** Jika Foxy API mengembalikan 403 (Cloudflare challenge), sync produk akan gagal dengan log ringkas — tidak akan mencetak FOXY_API_KEY atau header sensitif. Pending check tetap berjalan normal.
   > Pastikan IP VPS `43.133.133.124` sudah diwhitelist oleh Foxy di dashboard mereka.

2. **Transaction Test:** Lakukan simulasi order kecil (real data) untuk memastikan flow Foxy -> Callback -> Saldo berjalan 100%.
3. **Security Audit:** Cek `npm audit` secara berkala (Gunakan review manual, jangan otomatis `--force`).

### [LOW PRIORITY]
1. **Database Backup:** Setup otomatisasi backup PostgreSQL ke storage eksternal.
2. **Mobile Optimization:** Konversi tabel admin/dashboard menjadi layout kartu (cards) khusus untuk layar di bawah 480px.

## 11. Rekomendasi UI Lanjutan

| Halaman | Rekomendasi | Prioritas |
| :--- | :--- | :--- |
| Homepage | Tambahkan skeleton loading saat game grid dimuat. | Medium |
| Product Page | Sticky "Buy Now" bar di bagian bawah layar mobile. | High |
| Admin Panel | Implementasi Sidebar Drawer yang lebih halus di mobile. | Medium |
| Pricelist | Tambahkan filter kategori (Mobile, PC, Voucher) di atas list. | Medium |
| Dashboard | Visualisasi chart untuk riwayat transaksi bulanan. | Low |
| Invoice | Tambahkan tombol "Download PDF" atau "Share Screenshot". | Low |

## 12. Larangan

1. **JANGAN** pernah commit file `.env` atau mengekspos secret key di log/laporan.
2. **JANGAN** mengubah route API atau logic backend tanpa koordinasi dokumentasi (untuk menghindari kerusakan integrasi frontend).
3. **JANGAN** jalankan `npm audit fix --force` karena berisiko memecah dependensi Express 4 yang stabil saat ini.
4. **JANGAN** log full Axios error — hanya gunakan `safeAxiosError()` helper yang sudah ada di `server.js` dan `cronUtils.js`. FOXY_API_KEY tidak boleh muncul di log.
5. **JANGAN** truncate lock file `/tmp/topup-miku-cron.lock` secara manual kecuali diperlukan (stale lock auto-removed setelah 10 menit).

---
*Laporan ini dibuat oleh Antigravity (Advanced Agentic Coding AI).*
*Tanggal: 2026-05-06*
