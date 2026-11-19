# Laporan Audit QA & Keamanan — `topup-miku`

## 1. Ringkasan Eksekutif & Verdict Kesiapan

- **Verdict Kesiapan:** **`BELUM SIAP`** *(untuk rilis penuh ke pengguna; **Batch 1 — `BUG-026`, `BUG-007`, `BUG-024`, `BUG-004`, `BUG-003`, `BUG-006` telah diperbaiki & lulus regresi pada branch `fix/pricing-and-provider-safety`**, tersisa Batch 2/3 untuk temuan keamanan/UI lainnya)*
- **Ringkasan Eksekutif:**
  Audit penuh (statis, eksplorasi browser multi-viewport, E2E top-up/deposit/H2H dengan mock provider, dan pengujian keamanan/konkurensi DB) mengonfirmasi fondasi keamanan inti **kuat** pada jalur 3-fase order (`FOR UPDATE` + lock-free provider HTTP), anti-double-refund, Zero-Trust callback Foxy, SSRF webhook DNS pinning, serta bcrypt cost 12. Namun ditemukan **26 bug terbukti (`CONFIRMED`)**, termasuk bug berdampak bisnis langsung: item flash sale utama `DUMMY-ML-86` tidak bisa dibeli (`400 Harga sedang diperbarui`), cache harga Foxy 5 menit memungkinkan penjualan rugi saat harga provider naik, cron/`sync-products` mengabaikan `FOXY_BASE_URL`, endpoint publik `POST /api/test` terbuka tanpa auth, editor Harga Manual Admin gagal `HTTP 400`, serta form Promo Admin diam-diam membuang batas diskon maksimum (`promo-max-discount`). Perlu menyelesaikan minimal prioritas #1–#8 sebelum go-live.

---

## 2. Lingkungan & Versi yang Diuji

| Item | Nilai |
|---|---|
| Tanggal Audit | 17–18 November 2026 |
| Branch / Commit Diuji | Branch `qa/audit` dari `main` `@ 794431e` |
| URL Target Lokal | `http://localhost:3000` (Express `4.22.3`, Node.js `v24.20.0`) |
| Mock Provider Lokal | `http://127.0.0.1:4010` ([foxyMockServer.js](file:///d:/DICKY%20BELAJAR/topup-miku/qa/mocks/foxyMockServer.js)) |
| Database Lokal | PostgreSQL 16 `topup_miku_local@127.0.0.1:5432` (skema `001`–`012`, `DB_SSL=false`) |
| Browser & Runner | Microsoft Edge (headless & visual webview) via Playwright `^1.52.0` |
| Viewport UI Diuji | Desktop `1440x900`, Tablet `768x1024`, Mobile `375x812` & `390x844` |

---

## 3. Coverage Matrix (Fitur, Halaman, & Endpoint)

| Area / Fitur / Endpoint | Status | Catatan & Bukti |
|---|---|---|
| Storefront `index.html`, navigasi, flash sale, katalog | `FAIL` | Layout & 4 viewport bebas overflow (`PASS`), tetapi kategori kosong blank tanpa empty state (`BUG-UI-01`), harga coret flash sale home beda dgn `product.html` (`BUG-024`/margin), `/favicon.ico` 404 (`BUG-019`) |
| Halaman publik (`cek-transaksi`, `compare-prices`, `leaderboard`, `validate`, `reset-password`, statis) | `FAIL` | Bebas horizontal overflow & JS error (`PASS`), namun eye toggle `reset-password.html` keluar kotak 167px (`BUG-025`), `<select>` panah ganda (`compare-prices`, `validate`), `compare-prices` bocor game Inactive & `base_price` (`BUG-015`) |
| Auth (`register`, `login`, `forgot-password`, `reset-password`, `PUT /api/user/password`) | `FAIL` | Bcrypt 12 & reset token atomic aman (`PASS`), namun login email huruf campuran ditolak `401` & JWT lama tidak dicabut setelah ganti password (`BUG-011`) |
| Profil Member (`GET/PUT /api/user/profile`) | `FAIL` | Ganti email setelah `forgot-password` crash `500` FK `23503` (`BUG-008`) |
| Produk & Validasi Promo (`/api/games/:id/products`, `/api/promos/validate`) | `FAIL` | Menampilkan flash sale habis kuota (`BUG-004`), URL `?fsPrice=1` timpa harga UI (`BUG-017`), edit input promo desinkron (`BUG-018`) |
| Alur Order Web (`POST /api/order` & `product.html` -> `invoice.html`) | `FAIL` | Order normal sukses + refund Fase (b) aman (`PASS`), namun `DUMMY-ML-86` flash sale selalu gagal `400` (`BUG-024`), cache 5m loloskan harga rugi (`BUG-026`), HTTP 200 HTML dianggap `201` (`BUG-006`), `NaN` modal lolos (`BUG-007`), klik ulang metode bayar tunggal batalkan pilihan (`BUG-023`) |
| Deposit Member (`GET /payment-methods`, `POST /api/deposit/request`, `dashboard.html`) | `FAIL` | Flow & anti-double-approve `PASS`, namun `step="1000"` blokir nominal valid (`BUG-020`), request paralel tembus batas 2 Pending (`BUG-013`), tabel Mutasi Saldo bertumpuk di UI |
| H2H Reseller API (`/h2h/order`, `/h2h/products`, `/h2h/profile*`, `/api/user/apikey*`, `/whitelisted-ips`) | `FAIL` | Konkurensi 1/10, idempotency, isolasi `ref_id`, & SSRF `PASS`; tidak ada endpoint status transaksi H2H (`BUG-010`), `[123]` hapus whitelist (`BUG-009`), flash sale habis tetap tampil (`BUG-004`) |
| Foxy Callback (`POST /api/foxy/callback`) | `FAIL` | Token invalid 403, Zero-Trust `/v1/status`, & mismatch SKU `PASS`; cooldown 5s blokir retry setelah provider 500 (`BUG-012`) |
| Panel Admin (`admin.html` & `/api/admin/*`) | `FAIL` | Approve/reject deposit & RBAC 403 `PASS`; `POST /api/test` publik (`BUG-001`), Manual Price kirim `"admin"` 400 (`BUG-002`), `add` saldo terima `"1e5"`/`0.5` (`BUG-005`), audit log kosong pd produk/promo (`BUG-014`), `promo-max-discount` dibuang UI (`BUG-016`), non-admin tidak diredirect (`BUG-021`), `reject-reason` `maxlength=300` vs 200 (`BUG-022`), 4 tabel overflow horizontal pada 1440px |
| Cron & Sinkronisasi Produk (`jobs/pendingTransactions.js`, `jobs/productSync.js`, `/api/admin/sync-products`) | `FAIL` / `BLOCKED` | `FOXY_BASE_URL` hardcoded ke produksi (`BUG-003`); eksekusi dinamis `sync-products` sengaja tidak dipanggil agar tidak menembak `api.foxygamestore.com` (`BLOCKED`) |
| Validasi Eksternal PGSCODE / Mobapay & Email Brevo (`/api/full-validate`, `/pgs-preview`, mailer) | `BLOCKED` | `PGS_KEY`, `PGS_API_KEY`, dan `BREVO_API_KEY` kosong di `.env` lokal |
| WA Bot Deposit API (`/api/bot/admin/deposits/*`) | `PASS` *(existing test)* / `UNVERIFIED` *(live)* | Terverifikasi lewat `npm test` backend (`Phase 7A/7B`), belum diuji live terhadap server HTTP tersendiri di suite `qa/` |

---

## 4. Fitur yang Belum Dapat Diuji (`BLOCKED`)

1. **Sinkronisasi Produk Foxy (`POST /api/admin/sync-products` & `jobs/cronJob.js`):** Terblokir aturan Safety Gate karena `backend/jobs/pendingTransactions.js:15` dan `productSync.js:4` meng-hardcode `https://api.foxygamestore.com` dan mengabaikan `FOXY_BASE_URL=http://127.0.0.1:4010` (`BUG-003`). Butuh perbaikan agar membaca `config/constants.FOXY_BASE_URL`.
2. **Validasi Nickname Game Eksternal (`POST /api/full-validate`, `GET /api/admin/validation-services/pgs-preview`):** Terblokir karena `PGS_KEY` dan `PGS_API_KEY` kosong pada `.env` lokal (ditolak aman `400`/`503`). Membutuhkan mock atau kredensial sandbox PGSCODE.
3. **Pengiriman Email Reset Password (`POST /api/auth/forgot-password` -> Brevo):** `BREVO_API_KEY` kosong di `.env` lokal (token tetap tersimpan di `password_resets`, email eksternal tidak terkirim). Membutuhkan SMTP/HTTP mock mailer.

---

## 5. Daftar Bug Terbukti (`CONFIRMED`) — Diurutkan Berdasarkan Severity

### `[BUG-024]` Flash Sale Unggulan (`DUMMY-ML-86`, Rp 17.500) Selalu Gagal Checkout `HTTP 400` & Admin Bisa Buat Flash Sale di Bawah Modal — `CRITICAL` — `FIXED (Batch 1)`
- **Area:** Business Logic / Checkout / Admin Flash Sale
- **Langkah reproduksi:**
  1. Buka `http://localhost:3000` atau klik kartu Flash Sale `86 Diamonds (Rp 17.500)` (`product.html?gameId=1&fsProductId=2&fsPrice=17500.00`).
  2. Login sebagai `qa_member` (saldo `Rp 100.000`), isi User ID & Server ID, klik nominal `86 Diamonds`, lalu konfirmasi bayar (`POST /api/order`).
- **Hasil aktual:** Order selalu ditolak `HTTP 400 {"message":"Harga sedang diperbarui, coba lagi sebentar"}` via `window.alert()`, karena harga modal `DUMMY-ML-86` = `19.000` > harga flash sale `17.500`, sementara `/api/public/flash-sales` & `product.html` tetap mengiklankannya dan tidak memvalidasi modal saat pembuatan flash sale di `admin/flashSales.routes.js`. (Selain itu, harga coret di Home `Rp 20.900` berbeda dengan `product.html` `Rp 21.281` karena `public.routes.js` join `roles.id = 1` [`User` 10%] alih-alih `BRONZE` 12%).
- **Hasil yang diharapkan:** Produk promo yang diiklankan di storefront dapat dibeli (`201 Created`) atau ditolak sejak pembuatan oleh admin jika `discount_price < product.price` (kecuali promo subsidi disengaja & cost guard tahu).
- **Bukti:** Gagalnya tes `@bug-BUG-024` di `qa/tests/02-topup-and-business-logic.api.spec.js:315` serta observasi langsung `browser` subagent (`POST /api/order -> 400`).
- **Lokasi kode penyebab:** `backend/services/orderService.js:423`, `backend/routes/admin/flashSales.routes.js:47-92`, `backend/routes/public.routes.js:146-152`, `backend/scripts/seed_local_dummy.js`.
- **Dampak:** Pelanggan gagal membeli barang promo utama toko dan mendapat pesan error membingungkan ("Harga sedang diperbarui").
- **Rekomendasi:** Validasi `discount_price >= product.price` (atau tandai subsidi resmi) pada `POST /api/admin/flash-sales`, perbaiki harga flash sale seed (`>= 19.000`), dan samakan role baseline storefront ke `BRONZE`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-024`).

### `[BUG-026]` Cache Produk Foxy 5 Menit Loloskan Penjualan Rugi Saat Harga Provider Naik — `CRITICAL` — `FIXED (Batch 1)`
- **Area:** Business Logic / Pricing / Financial Safety
- **Langkah reproduksi:**
  1. Lakukan 1 order normal `DUMMY-ML-19` (modal `5.000`, jual BRONZE `5.601`) sehingga cache `foxyProductCache` terisi.
  2. Naikkan harga modal `DUMMY-ML-19` pada provider mock (`127.0.0.1:4010/__mock/mode`) menjadi `99.000`.
  3. Kirim `POST /api/order` untuk `DUMMY-ML-19` sebelum 5 menit berakhir.
- **Hasil aktual:** Backend mengembalikan `201 Created` dan memproses order seharga `Rp 5.601` meski modal provider sudah `Rp 99.000` (kerugian Rp 93.399 per transaksi).
- **Hasil yang diharapkan:** Price guard mendeteksi lonjakan harga modal dan menolak order (`400`) tanpa memotong saldo atau mengirim order rugi.
- **Bukti:** Kegagalan tes `@bug-BUG-026` (`Expected: 400, Received: 201`) pada `qa/tests/02-topup-and-business-logic.api.spec.js:147`.
- **Lokasi kode penyebab:** `backend/services/foxyClient.js:90-93` & `backend/config/constants.js:12` (`FOXY_CACHE_TTL = 5 * 60 * 1000`).
- **Dampak:** Kerugian finansial langsung hingga ratusan kali lipat jika harga supplier naik atau berubah mendadak.
- **Rekomendasi:** Nonaktifkan cache untuk jalur `POST /api/order` & `/h2h/order` (atau TTL sangat singkat mis. 5–15 detik) serta simpan `provider_cost` di `transactions`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-026`).

### `[BUG-007]` Harga Modal Foxy Non-Numerik (`NaN`) Menembus Price Guard — `CRITICAL` — `FIXED (Batch 1)`
- **Area:** Business Logic / Pricing
- **Langkah reproduksi:**
  1. Konfigurasikan respons `/v1/products` mengembalikan `product_price: "NOT_A_NUMBER"` pada SKU yang dipesan.
  2. Panggil `POST /api/order` saat cache belum terisi.
- **Hasil aktual:** `Number("NOT_A_NUMBER")` menghasilkan `NaN`; perbandingan `NaN > finalPrice` bernilai `false`, sehingga order tetap lolos (`201 Created`) tanpa validasi modal.
- **Hasil yang diharapkan:** `Number.isFinite(cost) && cost >= 0` wajib diperiksa fail-closed; nilai non-numerik ditolak `400`.
- **Bukti:** Kegagalan tes `@bug-BUG-007` (`Expected: 400, Received: 201`) dan inspeksi `orderService.js:150, 423`. *(Catatan: saat tes dijalankan berurutan setelah tes lain, cache `BUG-026` juga menutupi lookup mock).*
- **Lokasi kode penyebab:** `backend/services/orderService.js:150, 423, 527`.
- **Dampak:** Jika format API provider berubah atau korup, seluruh proteksi anti-rugi mati diam-diam.
- **Rekomendasi:** Tambahkan pengecekan `if (!Number.isFinite(cost) || cost < 0) throw new Error(...)` di `fetchRealtimeFoxyCostForOrder()`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-007`).

### `[BUG-001]` Endpoint Debug `POST /api/test` Terbuka Publik Tanpa Autentikasi & Tanpa Rate Limit — `HIGH` — `CONFIRMED`
- **Area:** Security / Access Control
- **Langkah reproduksi:**
  1. Kirim `POST http://localhost:3000/api/test` tanpa header `Authorization` maupun `X-API-Key`.
- **Hasil aktual:** Server membalas `200 OK` (`{"message":"Halo! Rute tes POST ini berfungsi!"}`) dan menulis ke stdout log server tanpa pembatasan rate limiter.
- **Hasil yang diharapkan:** Dihapus di produksi / seluruh environment atau dilindungi `protectAdmin` (mengembalikan `401`/`403`/`404`).
- **Bukti:** Kegagalan tes `@bug-BUG-001` (`Expected [401,403,404], Received: 200`).
- **Lokasi kode penyebab:** `backend/routes/admin/games.routes.js:238-241`.
- **Dampak:** Penyerang dapat membanjiri log disk VPS (`stdout`) tanpa batas rate limit.
- **Rekomendasi:** Hapus rute `/api/test` sepenuhnya atau batasi hanya non-production + `protectAdmin`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-001`).

### `[BUG-002]` Editor Harga Manual Produk di Panel Admin Selalu Gagal `HTTP 400` — `HIGH` — `CONFIRMED`
- **Area:** UI / API Contract (`admin.html`)
- **Langkah reproduksi:**
  1. Login sebagai `qa_admin`, buka `admin.html` → tab `Produk & Game`.
  2. Klik tombol `Atur Harga` pada salah satu produk, aktifkan toggle `Gunakan Harga Manual?`, isi kolom termasuk `Harga Jual Admin (Rp)`, lalu klik `Simpan`.
- **Hasil aktual:** Request `POST /api/admin/products/:id/manual-prices` mengirim kunci `admin` di `manual_prices`, yang ditolak backend dengan **`400` (`Role "admin" pada manual_prices tidak dikenal.`)**.
- **Hasil yang diharapkan:** Frontend hanya merender & mengirim role komersial yang diizinkan backend (`bronze`, `silver`, `gold`, `partner`) dan simpan sukses `200`.
- **Bukti:** Kegagalan `@bug-BUG-002` (`Expected: 200, Received: 400`) di `qa/tests/01-ui-exploratory.spec.js:200` + screenshot gagal di `qa/test-results/`.
- **Lokasi kode penyebab:** `frontend/js/admin/state.js:8` (`ADMIN_PRICE_ROLE_ORDER` menyertakan `'Admin'`) vs `backend/utils/schemaValidators.js:253-259`.
- **Dampak:** Fitur harga jual manual di dashboard admin tidak bisa dipakai jika kolom Admin diisi.
- **Rekomendasi:** Hapus `'Admin'` dari `ADMIN_PRICE_ROLE_ORDER` (dan `PUBLIC_ROLE_ORDER` bila perlu) serta refresh tabel produk setelah simpan.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-002`).

### `[BUG-003]` `jobs/pendingTransactions.js` & `jobs/productSync.js` Abaikan `FOXY_BASE_URL` Env — `HIGH` — `FIXED (Batch 1)`
- **Area:** Configuration / Cron & Provider Safety
- **Langkah reproduksi:**
  1. Set `FOXY_BASE_URL=http://127.0.0.1:4010` di `.env`.
  2. Muat `backend/jobs/pendingTransactions.js` dan baca ekspor `FOXY_BASE_URL`.
- **Hasil aktual:** Nilainya tetap hardcoded `'https://api.foxygamestore.com'`.
- **Hasil yang diharapkan:** Mengikuti `FOXY_BASE_URL` dari `backend/config/constants.js`.
- **Bukti:** Kegagalan `@bug-BUG-003` (`Expected: "http://127.0.0.1:4010", Received: "https://api.foxygamestore.com"`).
- **Lokasi kode penyebab:** `backend/jobs/pendingTransactions.js:15` & `backend/jobs/productSync.js:4`.
- **Dampak:** Pengujian QA `sync-products` atau cron lokal diam-diam mengirim trafik ke server produksi Foxy.
- **Rekomendasi:** Impor `FOXY_BASE_URL` & `PROVIDER_TIMEOUT_MS` dari `../config/constants.js`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-003`).

### `[BUG-004]` Flash Sale yang Kuotanya Sudah Habis Tetap Diiklankan di Katalog Publik & H2H — `HIGH` — `FIXED (Batch 1)`
- **Area:** Business Logic / Pricing Consistency
- **Langkah reproduksi:**
  1. Buat entri `flash_sales` aktif dengan `max_uses = 1, uses_count = 1` untuk produk `DUMMY-FF-50` (`discount_price = 6600`).
  2. Panggil `GET /api/games/:gameId/products` (atau `/h2h/products`, `/api/public/compare-prices`, `/api/public/flash-sales`).
- **Hasil aktual:** Respons masih mengembalikan `isFlashSale: true` dan `price: 6600`, padahal `POST /api/order` akan menagih harga reguler lebih mahal (`7280`).
- **Hasil yang diharapkan:** Flash sale habis kuota tidak lagi ditampilkan sebagai harga flash sale (`isFlashSale: false`).
- **Bukti:** Kegagalan `@bug-BUG-004` (`Expected: false, Received: true`).
- **Lokasi kode penyebab:** `backend/services/priceService.js:93-96`, `backend/routes/h2h.routes.js:70-73`, `backend/routes/public.routes.js:90, 149`.
- **Dampak:** Pembeli melihat harga promo di halaman produk lalu ditagih harga normal saat `POST /api/order`.
- **Rekomendasi:** Tambahkan `AND (max_uses IS NULL OR uses_count < max_uses)` dan cek `discount_price < normalPrice` pada seluruh query katalog.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-004`).

### `[BUG-005]` `POST /api/admin/balance/add` Menerima `"1e5"` (`+Rp 1`) & `0.5` (Mutasi `Rp 0`) — `HIGH` — `CONFIRMED`
- **Area:** Business Logic / Validation / Ledger Integrity
- **Langkah reproduksi:**
  1. Kirim `POST /api/admin/balance/add` dengan `{ userId, amount: "1e5" }` lalu `{ userId, amount: 0.5 }` memakai token admin.
- **Hasil aktual:** `"1e5"` lolos cek `!isNaN` lalu di-`parseInt` menjadi `1` (menambah Rp 1 sambil membalas pesan sukses `"1e5"`), sedangkan `0.5` lolos lalu di-`parseInt` menjadi `0` (mencatat mutasi `balance_history` Rp 0).
- **Hasil yang diharapkan:** Input non-integer atau string non-digit ditolak `HTTP 400`.
- **Bukti:** Kegagalan `@bug-BUG-005` di `qa/tests/02-topup-and-business-logic.api.spec.js:228`.
- **Lokasi kode penyebab:** `backend/routes/admin/balance.routes.js:33-38, 70-78`.
- **Dampak:** Kesalahan mutasi saldo & pencemaran ledger `balance_history`.
- **Rekomendasi:** Gunakan `requirePositiveInt` & `getBodyObject` dari `utils/schemaValidators.js` pada `balance.routes.js`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-005`).

### `[BUG-006]` Respons HTML/Non-JSON `200 OK` dari Provider Dianggap Order Berhasil (`201 Pending`) — `HIGH` — `FIXED (Batch 1)`
- **Area:** Provider Integration / Order Reliability
- **Langkah reproduksi:**
  1. Set mock Foxy `orderBehavior = 'invalid_json'` (mengembalikan HTTP `200` HTML Cloudflare/error page).
  2. Kirim `POST /api/order`.
- **Hasil aktual:** `orderService.js:366` hanya mengecek `foxyRes.data.status === false`; pada string HTML `foxyRes.data.status` adalah `undefined`, sehingga transaksi dianggap diterima (`201 Created`) padahal provider menolak/Cloudflare challenge.
- **Hasil yang diharapkan:** Respons `/v1/order` harus berupa JSON valid dengan `status === true` (atau ditandai ambiguous/rejected, bukan dianggap sukses begitu saja).
- **Bukti:** Kegagalan `@bug-BUG-006` (`Expected: not 201, Received: 201`).
- **Lokasi kode penyebab:** `backend/services/orderService.js:365-371`.
- **Dampak:** Saldo pengguna terpotong & status tertahan `Pending` untuk order yang tidak pernah masuk ke provider hingga cron timeout.
- **Rekomendasi:** Tolak respons `/v1/order` jika `typeof foxyRes.data !== 'object' || foxyRes.data === null || foxyRes.data.status !== true`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-006`).

### `[BUG-008]` User Tidak Bisa Mengubah Email Setelah Pernah Meminta Reset Password (`500` FK Error) — `HIGH` — `CONFIRMED`
- **Area:** Database Schema / Member Profile
- **Langkah reproduksi:**
  1. Panggil `POST /api/auth/forgot-password` untuk email user (menyisipkan baris di `password_resets`).
  2. Panggil `PUT /api/user/profile` dengan email baru.
- **Hasil aktual:** Backend crash `HTTP 500` karena foreign key `fk_password_resets_email` tidak memiliki `ON UPDATE CASCADE`.
- **Hasil yang diharapkan:** `200 OK` dan email pada `users` (serta `password_resets`) terbarui atau token reset lama dibersihkan.
- **Bukti:** Kegagalan `@bug-BUG-008` (`Expected: 200, Received: 500`).
- **Lokasi kode penyebab:** `migrations/002_add_missing_tables.sql:18-21` & `backend/routes/user.routes.js:70`.
- **Dampak:** Setiap member yang pernah lupa password terkunci permanen tidak bisa mengganti alamat email profilnya.
- **Rekomendasi:** Tambahkan migrasi `ON UPDATE CASCADE` pada `fk_password_resets_email` atau hapus baris `password_resets` lama dalam transaksi `PUT /api/user/profile` saat email berubah.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-008`).

### `[BUG-009]` `PUT /api/user/whitelisted-ips` dengan Elemen Non-String (`[123]`) Menghapus Seluruh IP Allowlist — `HIGH` — `CONFIRMED`
- **Area:** Security / H2H Configuration
- **Langkah reproduksi:**
  1. User punya `whitelisted_ips = ['203.0.113.10']`.
  2. Kirim `PUT /api/user/whitelisted-ips` dengan `{ ips: [123] }`.
- **Hasil aktual:** Backend membalas `200 OK` dan menyimpan `[]` (menghapus proteksi whitelist IP secara diam-diam sehingga semua IP menjadi terbuka).
- **Hasil yang diharapkan:** Ditolak `HTTP 400` karena elemen array harus string IP/CIDR valid.
- **Bukti:** Kegagalan `@bug-BUG-009` (`Expected: 400, Received: 200`).
- **Lokasi kode penyebab:** `backend/routes/userApiKey.routes.js:162` (`typeof item === 'string' ? ... : ''` lalu `.filter(Boolean)`).
- **Dampak:** Kesalahan klien mengirim tipe angka dapat mematikan seluruh pembatasan IP whitelist H2H secara tidak sengaja.
- **Rekomendasi:** Tolak `400` jika ada elemen bukan string atau string kosong pada `ips`.
- **Test regresi:** `qa/tests/03-h2h-and-security.api.spec.js` (`@bug-BUG-009`).

### `[BUG-010]` Reseller H2H Tidak Memiliki Endpoint Cek Status / Daftar Transaksi — `HIGH` — `CONFIRMED`
- **Area:** H2H API / Feature Gap
- **Langkah reproduksi:**
  1. Kirim `GET /h2h/transactions` memakai `X-API-Key` reseller valid.
- **Hasil aktual:** `404 Not Found`; seluruh `routes/h2h.routes.js` hanya menyediakan `POST /h2h/order`, `GET /h2h/products`, `PUT /h2h/profile/callback`, dan `GET /h2h/profile`.
- **Hasil yang diharapkan:** Tersedia endpoint H2H read-only untuk memeriksa status order (`invoiceId`/`ref_id`) beserta `provider_sn` bila webhook tertunda/gagal.
- **Bukti:** Kegagalan `@bug-BUG-010` (`Expected: 200, Received: 404`).
- **Lokasi kode penyebab:** `backend/routes/h2h.routes.js:1-187`.
- **Dampak:** Mitra H2H tidak dapat melakukan rekonsiliasi otomatis jika webhook terlewat.
- **Rekomendasi:** Tambahkan `GET /h2h/order/:refOrInvoiceId` dan `GET /h2h/transactions` (paginasi terikat `req.user.id`).
- **Test regresi:** `qa/tests/03-h2h-and-security.api.spec.js` (`@bug-BUG-010`).

### `[BUG-011]` JWT Lama Tetap Valid Setelah Ganti Password & Login Email Huruf Campuran Gagal `401` — `HIGH` — `CONFIRMED`
- **Area:** Security / Authentication (`SEC-014`)
- **Langkah reproduksi:**
  1. Login menggunakan email versi kapital campuran (`QA.TEST@LOCAL.TEST`) dari akun yang terdaftar lowercase.
  2. Login normal untuk dapat `oldToken`, ubah password via `PUT /api/user/password`, lalu panggil `GET /api/user/profile` memakai `oldToken`.
- **Hasil aktual:** Login email huruf campuran ditolak `401`; setelah ganti password, `oldToken` tetap diterima `200 OK` hingga masa 24 jam berakhir.
- **Hasil yang diharapkan:** Login email bersifat case-insensitive (`200`); perubahan/reset password mencabut seluruh JWT lama (`401`).
- **Bukti:** Kegagalan `@bug-BUG-011` di `qa/tests/03-h2h-and-security.api.spec.js:227`.
- **Lokasi kode penyebab:** `backend/routes/auth.routes.js:112`, `backend/middleware/auth.js:13-23`.
- **Dampak:** Token sesi yang bocor tetap bisa menguras saldo pasca-ganti password.
- **Rekomendasi:** Lowercase `$2` saat login email; tambahkan `token_version` di tabel `users` & verifikasi di `protect`.
- **Test regresi:** `qa/tests/03-h2h-and-security.api.spec.js` (`@bug-BUG-011`).

### `[BUG-013]` Race Condition Request Deposit Paralel Tembus Batas Maksimal 2 Deposit Pending — `HIGH` — `CONFIRMED`
- **Area:** Concurrency / Database Integrity (`SEC-021`)
- **Langkah reproduksi:**
  1. Kirim 6 request `POST /api/deposit/request` secara paralel (`Promise.all`) dari user yang sama dengan `Idempotency-Key` unik.
- **Hasil aktual:** Lebih dari 2 permintaan berhasil dibuat (`201 Created` hingga 6 kali) karena pengecekan `SELECT COUNT(*) FROM deposits` berjalan sebelum insert tanpa mengunci baris user (`FOR UPDATE`).
- **Hasil yang diharapkan:** Maksimal 2 deposit `Pending` per user, sisanya `429`.
- **Bukti:** Kegagalan `@bug-BUG-013` di `qa/tests/02-topup-and-business-logic.api.spec.js:297`.
- **Lokasi kode penyebab:** `backend/routes/deposit.routes.js:188-200`.
- **Dampak:** Pelaku dapat membanjiri antrian deposit Pending (dan berisiko bertabrakan kode unik).
- **Rekomendasi:** Tambahkan `SELECT id FROM users WHERE id = $1 FOR UPDATE` di awal transaksi `POST /api/deposit/request`.
- **Test regresi:** `qa/tests/02-topup-and-business-logic.api.spec.js` (`@bug-BUG-013`).

### `[BUG-016]` Form Promo Admin Mengabaikan Input Diskon Maksimal (`promo-max-discount`) — `HIGH` — `CONFIRMED`
- **Area:** UI / Business Logic (`admin.html`)
- **Langkah reproduksi:**
  1. Buka `admin.html` → tab `Promo`, pilih tipe `Persentase (%)`, isi Nilai `50`, isi Maksimal Diskon `2500`, lalu submit.
  2. Cek kolom `rules` pada tabel `promo_codes`.
- **Hasil aktual:** `rules.max_discount_amount` bernilai `undefined` — promo tersimpan tanpa batas maksimal diskon (bisa memberi diskon 50% atas transaksi besar meski admin sudah mengisi batas Rp 2.500!).
- **Hasil yang diharapkan:** `rules.max_discount_amount === 2500`.
- **Bukti:** Kegagalan `@bug-BUG-016` (`Expected: 2500, Received: undefined`).
- **Lokasi kode penyebab:** `frontend/admin.html:346-347` vs `frontend/js/admin/promosAndFlashSales.js:163-177`.
- **Dampak:** Kerugian bisnis langsung karena diskon persentase menjadi tidak terbatas (*uncapped*).
- **Rekomendasi:** Baca `document.getElementById('promo-max-discount').value` dan masukkan ke `rules.max_discount_amount`.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-016`).

### `[BUG-017]` Query URL `fsPrice` pada `product.html` Dapat Dimanipulasi untuk Mengubah Harga Tampilan — `HIGH` — `CONFIRMED`
- **Area:** UI / Integrity (`product.html`)
- **Langkah reproduksi:**
  1. Buka `http://localhost:3000/product.html?gameId=1&fsProductId=1&fsPrice=1`.
- **Hasil aktual:** Tampilan nominal, ringkasan Step 4 (`#total-price`), dan modal konfirmasi menampilkan **`Rp 1`** (dan merusak halaman jika `fsProductId` berisi tanda kutip karena selector CSS tidak di-escape).
- **Hasil yang diharapkan:** UI hanya memakai harga resmi dari `GET /api/games/:gameId/products`; parameter URL hanya dipakai untuk auto-select ID produk secara aman.
- **Bukti:** Kegagalan `@bug-BUG-017` (`Received: "1"`).
- **Lokasi kode penyebab:** `frontend/js/product/validation.js:239-254`, `frontend/js/product/state.js:302-303`.
- **Dampak:** Ketidaksesuaian harga tampilan vs saldo terpotong serta potensi phishing link (`?fsPrice=1`) yang membingungkan pembeli.
- **Rekomendasi:** Hapus penimpaan harga dari `fsPrice` dan gunakan `CSS.escape(String(fsProductId))` saat query DOM.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-017`).

### `[BUG-012]` Cooldown Callback Foxy 5 Detik Memblokir Retry Setelah Kegagalan Sementara `/v1/status` — `MEDIUM` — `CONFIRMED`
- **Area:** Callback / Resilience
- **Langkah reproduksi:**
  1. Order masuk status `Pending`.
  2. Mock `/v1/status` melempar `500` saat callback pertama datang, lalu pulih `SUCCESS` dan callback kedua dikirim segera (< 5s).
- **Hasil aktual:** Callback kedua diabaikan oleh `checkAndMarkCallbackCooldown()` tanpa memanggil `/v1/status`; status tetap `Pending` sampai cron berjalan.
- **Hasil yang diharapkan:** Cooldown hanya diaktifkan bila panggilan `/v1/status` ke provider berhasil dijangkau (atau tidak memblokir retry pasca-500).
- **Bukti:** Kegagalan `@bug-BUG-012` (`Expected: "Success", Received: "Pending"`).
- **Lokasi kode penyebab:** `backend/routes/foxyCallback.routes.js:151-174`.
- **Dampak:** Keterlambatan penyelesaian order pelanggan ketika Foxy mengirim ulang webhook segera setelah error sementara.
- **Rekomendasi:** Catat cooldown setelah `axios.get('/v1/status/...')` mendapat respons sukses (atau hapus key cooldown pada blok `catch`).
- **Test regresi:** `qa/tests/03-h2h-and-security.api.spec.js` (`@bug-BUG-012`).

### `[BUG-014]` Aksi Admin Produk & Promo Tidak Tercatat di `admin_audit_logs` — `MEDIUM` — `CONFIRMED`
- **Area:** Auditability / Compliance (`SEC-010`)
- **Langkah reproduksi:**
  1. Admin membuat kode promo (`POST /api/admin/promos`), mengubah produk/flash sale.
  2. Cek tabel `admin_audit_logs`.
- **Hasil aktual:** Nol baris audit tercatat untuk `products.routes.js`, `promos.routes.js`, `flashSales.routes.js`, dan `waBot.routes.js`.
- **Hasil yang diharapkan:** Seluruh aksi mutasi admin tercatat di `admin_audit_logs`.
- **Bukti:** Kegagalan `@bug-BUG-014` (`Expected: > 0, Received: 0`).
- **Lokasi kode penyebab:** `backend/routes/admin/{products,promos,flashSales}.routes.js`, `backend/routes/waBot.routes.js`.
- **Dampak:** Sulit menginvestigasi perubahan harga/produk/promo jika terjadi insiden internal.
- **Rekomendasi:** Teruskan `recordAdminAuditLog` dan catat audit log pada seluruh rute mutasi admin & WA Bot.
- **Test regresi:** `qa/tests/03-h2h-and-security.api.spec.js` (`@bug-BUG-014`).

### `[BUG-015]` `/api/public/compare-prices` Membocorkan Produk Game `Inactive` & Kolom Modal `base_price` — `MEDIUM` — `CONFIRMED`
- **Area:** Data Exposure / Pricing Leak
- **Langkah reproduksi:**
  1. Buat game `Inactive` yang memiliki produk `Active`, lalu panggil `GET /api/public/compare-prices`.
- **Hasil aktual:** Produk dari game yang dinonaktifkan tetap muncul di respons publik beserta field harga modal internal `base_price`.
- **Hasil yang diharapkan:** Filter `AND g.status = 'Active'` dan jangan kembalikan `base_price` ke endpoint publik.
- **Bukti:** Kegagalan `@bug-BUG-015` di `qa/tests/03-h2h-and-security.api.spec.js:297`.
- **Lokasi kode penyebab:** `backend/routes/public.routes.js:85, 97`.
- **Dampak:** Kompetitor dapat membaca seluruh harga modal reseller toko secara publik dan melihat katalog game nonaktif.
- **Rekomendasi:** Tambahkan `AND g.status = 'Active'` dan hapus `base_price` (serta role internal `Admin`/`OWNER` bila tak perlu) dari JSON publik.
- **Test regresi:** `qa/tests/03-h2h-and-security.api.spec.js` (`@bug-BUG-015`).

### `[BUG-018]` Mengubah Teks `#promo-code-input` Setelah `Terapkan` Menyebabkan Desinkronisasi Diskon UI vs Backend — `MEDIUM` — `CONFIRMED`
- **Area:** UI / Checkout UX (`product.html`)
- **Langkah reproduksi:**
  1. Pada `product.html` (`172 Diamonds`), masukkan `MIKUBARU`, klik `Terapkan` -> `#total-price` menampilkan harga diskon.
  2. Hapus atau ubah teks di `#promo-code-input` tanpa mengklik `Terapkan` lagi.
- **Hasil aktual:** `#total-price` tetap menampilkan harga diskon lama sementara payload submit membaca nilai input baru yang kosong/berbeda.
- **Hasil yang diharapkan:** Event `input` pada `#promo-code-input` otomatis mereset `app.state.appliedPromo` dan memanggil `updatePrice()`.
- **Bukti:** Kegagalan `@bug-BUG-018` di `qa/tests/01-ui-exploratory.spec.js:260`.
- **Lokasi kode penyebab:** `frontend/js/product/state.js:87` & `frontend/js/product/checkout.js:301-343`.
- **Dampak:** Total yang dibayar di backend tidak cocok dengan angka total yang dilihat pengguna di layar.
- **Rekomendasi:** Reset `appliedPromo` dan perbarui harga setiap kali nilai `#promo-code-input` berubah.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-018`).

### `[BUG-020]` Input Deposit Member Memblokir Nominal Valid Non-Kelipatan 1.000 (`step="1000"`) — `MEDIUM` — `CONFIRMED`
- **Area:** UI / Validation (`dashboard.html`)
- **Langkah reproduksi:**
  1. Buka `dashboard.html` → tab `Isi Saldo / Deposit`, ketik `15500` pada `#amount`.
- **Hasil aktual:** Validasi HTML5 native menolak input (`checkValidity() === false`) karena `step="1000"`, meskipun backend `POST /api/deposit/request` menerima semua integer `>= 10.000`.
- **Hasil yang diharapkan:** `step="1"` (atau `100`), sehingga nominal seperti Rp 15.500 valid.
- **Bukti:** Kegagalan `@bug-BUG-020` (`Expected: true, Received: false`).
- **Lokasi kode penyebab:** `frontend/dashboard.html:279`.
- **Dampak:** Member tidak bisa mengajukan deposit selain kelipatan Rp 1.000.
- **Rekomendasi:** Ubah atribut menjadi `step="1"`.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-020`).

### `[BUG-021]` User Non-Admin Bisa Membuka `admin.html` & Memicu Banjir Request `403` — `MEDIUM` — `CONFIRMED`
- **Area:** UI / Access Control (`admin.html`)
- **Langkah reproduksi:**
  1. Login sebagai `qa_member`, buka `http://localhost:3000/admin.html`.
- **Hasil aktual:** Halaman admin dirender penuh dan langsung menembak ~10 request `/api/admin/*` yang seluruhnya gagal `403`, tanpa redirect otomatis.
- **Hasil yang diharapkan:** Cek role dari `/api/user/profile` sebelum menampilkan UI admin dan segera alihkan non-admin ke `dashboard.html`/`index.html`.
- **Bukti:** Kegagalan `@bug-BUG-021` di `qa/tests/01-ui-exploratory.spec.js:300`.
- **Lokasi kode penyebab:** `frontend/js/admin/state.js:308-324`.
- **Dampak:** Pengalaman buruk & membocorkan struktur UI panel admin ke member biasa.
- **Rekomendasi:** Tambahkan pengecekan profil/role saat `initAdminPage()` dan redirect jika bukan `Admin` atau token invalid (`401`/`403`).
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-021`).

### `[BUG-022]` Input Alasan Penolakan Deposit Admin (`maxlength="300"`) Melebihi Batas Backend (`200`) — `MEDIUM` — `CONFIRMED`
- **Area:** UI / API Validation Mismatch (`admin.html`)
- **Langkah reproduksi:**
  1. Periksa `#reject-reason-input` di `admin.html` (`maxlength="300"`), lalu kirim alasan 250 karakter.
- **Hasil aktual:** UI mengizinkan hingga 300 karakter, tetapi `POST /api/admin/deposits/reject` menolaknya dengan `400 Alasan penolakan maksimal 200 karakter.`.
- **Hasil yang diharapkan:** `maxlength="200"` agar selaras dengan backend.
- **Bukti:** Kegagalan `@bug-BUG-022` (`Received: 300`).
- **Lokasi kode penyebab:** `frontend/admin.html:703` vs `backend/routes/admin/deposits.routes.js:189`.
- **Dampak:** Admin gagal menolak deposit setelah mengetik alasan panjang.
- **Rekomendasi:** Ubah `maxlength="200"` pada `frontend/admin.html:703`.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-022`).

### `[BUG-023]` Mengklik Metode Pembayaran Tunggal ("Saldo Akun") Membatalkan Pilihan — `MEDIUM` — `CONFIRMED`
- **Area:** UI / Checkout UX (`product.html`)
- **Langkah reproduksi:**
  1. Buka `product.html?gameId=1`, lihat kartu `"Saldo Akun MIKU Store"` dalam keadaan `.selected`.
  2. Klik kartu tersebut satu kali.
- **Hasil aktual:** Pilihan menjadi kosong (`selectedPaymentMethod = null`) dan tombol checkout mati hingga diklik lagi.
- **Hasil yang diharapkan:** Jika hanya ada satu metode bayar (atau diklik ulang), status tetap terpilih atau menampilkan hint yang jelas.
- **Bukti:** Kegagalan `@bug-BUG-023` di `qa/tests/01-ui-exploratory.spec.js:318`.
- **Lokasi kode penyebab:** `frontend/js/product/checkout.js:202-203`.
- **Dampak:** Pengguna baru bingung mengapa tombol bayar mati padahal hanya ada satu opsi bayar.
- **Rekomendasi:** Jangan toggle-off bila `paymentCards.length === 1`.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-023`).

### `[BUG-025]` Ikon Eye Toggle Password `reset-password.html` Keluar `167px` di Luar Kotak Input — `MEDIUM` — `CONFIRMED`
- **Area:** UI / CSS Layout (`reset-password.html`)
- **Langkah reproduksi:**
  1. Buka `http://localhost:3000/reset-password.html?token=abcd1234` pada `1440x900`.
  2. Periksa posisi `<i class="toggle-password">` vs `<input name="newPassword">`.
- **Hasil aktual:** `input.right = 742.5px`, sedangkan `icon.right = 909.5px` (ikon melayang jauh di luar border kanan kartu/input). Selain itu, ketika `?token=` tidak ada di URL, tombol `Simpan Password Baru` terlihat aktif secara visual meski sebenarnya `disabled`, dan `setupPasswordToggles()` terlewat karena early `return`.
- **Hasil yang diharapkan:** Ikon berada rapi di dalam sisi kanan input (`padding-right` cukup) dan `disabled` button memiliki gaya nonaktif jelas.
- **Bukti:** Kegagalan `@bug-BUG-025` + screenshot bukti di `qa/test-results/` + observasi `browser` subagent.
- **Lokasi kode penyebab:** `frontend/css/modalsAndForms.css` / `publicPages.css` & `frontend/reset-password.js:21, 58`.
- **Dampak:** Tampilan formulir reset password terlihat rusak pada desktop & mobile.
- **Rekomendasi:** Berikan `position: relative; width: 100%;` pada `.password-wrapper` di `reset-password.html` dan style visual `:disabled` yang kontras.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-025`).

### `[BUG-019]` Missing `/favicon.ico` Menyebabkan Console Error `404` di Seluruh Halaman — `LOW` — `CONFIRMED`
- **Area:** UI / Assets
- **Langkah reproduksi:**
  1. Buka halaman mana saja (`index.html`, `kebijakan-refund.html`, dll.) lalu cek Network/Console browser.
- **Hasil aktual:** Request `GET /favicon.ico` membalas `HTTP 404 Not Found`.
- **Hasil yang diharapkan:** Tersedia aset `/favicon.ico` atau `icon` valid (`200 OK`).
- **Bukti:** Kegagalan `@bug-BUG-019` (`Received: 404`) + browser console log pada run awal Playwright.
- **Lokasi kode penyebab:** Seluruh 13 HTML (`<link rel="icon" href="/favicon.ico">`) tanpa file `frontend/favicon.ico`.
- **Dampak:** Memicu console error 404 di setiap kunjungan baru.
- **Rekomendasi:** Tambahkan `frontend/favicon.ico` atau `<link rel="icon" href="data:...">`.
- **Test regresi:** `qa/tests/01-ui-exploratory.spec.js` (`@bug-BUG-019`).

### `[BUG-UI-01]` & `[BUG-UI-02]` Cacat Visual & UX Tambahan Hasil Eksplorasi Browser — `MEDIUM`/`LOW` — `CONFIRMED`
1. **Tabel bertumpuk & terpotong pada `1440x900` (`MEDIUM`):**
   - `dashboard.html` tab `Mutasi Saldo`: teks deskripsi panjang bertabrakan secara visual dengan kolom `Jumlah` (`-Rp 5.601`), dan tabel `Transaksi Terbaru` di `Overview` memotong kolom kanan bahkan di `1440px`.
   - `admin.html`: keempat tabel utama (`Produk & Game` 12 kolom, `Deposit`, `Pembayaran`, `Transaksi`) melampaui lebar kontainer di `1440px` sehingga kolom aksi tersembunyi di scroll horizontal.
2. **Duplicate dropdown arrows pada `<select>` (`LOW`):** `compare-prices.html`, `validate.html`, dan filter `Semua Game` di `admin.html` menampilkan panah ganda (`appearance: none` CSS belum menutupi native caret di Edge).
3. **UX Auth, Kategori Kosong, Saldo Checkout, & Drawer Mobile (`MEDIUM`):**
   - `index.html`: kategori `"Voucher Digital"` saat 0 item tampil kosong tanpa empty-state card; modal auth tidak menutup saat klik backdrop; pesan error login pakai `window.alert()`; spasi saja di username lolos ke API (`400`); drawer mobile tampilkan link `Dashboard` saat belum login; judul Flash Sale terpotong di `768px`/`375px`.
   - `product.html`: saldo wallet user tidak ditampilkan pada Step 3/4 sebelum konfirmasi order.
   - `dashboard.html`: saat resize viewport dari desktop ke `375px` tanpa reload, drawer sidebar tetap terbuka menimpa konten hingga tombol `×` ditekan.

---

## 6. Daftar Dugaan (`SUSPECTED` / `UNVERIFIED`)

Temuan di bawah ini teridentifikasi dari inspeksi kode statis (Tahap 2) dan belum dieksekusi langsung secara dinamis pada lingkungan lokal:

1. **[HIGH - SUSPECTED] Provider HTTP `500` / Cloudflare `52x` di Fase (b) Memicu Refund Dini (`orderService.js:41-50`):** `isProviderTimeoutOrAmbiguous()` menganggap HTTP `500` sebagai penolakan pasti sehingga langsung me-refund saldo & membatalkan order (`Failed`). Jika provider tetap memproses di belakang error 500, callback `SUCCESS` berikutnya akan diabaikan -> topup gratis + saldo kembali.
2. **[HIGH - SUSPECTED] Cron `productSync.js` Menurunkan 100% Katalog Saat Response Kosong (`SEC-018`) & Mengabaikan `effectiveMargin` (`productSync.js:14, 46, 83, 127`):** `syncProductsWithFoxy()` tidak menerima argumen margin dari route admin, crash `TypeError` jika `category_type` null, menahan koneksi DB selama HTTP fetch, dan menonaktifkan semua produk jika Foxy mengembalikan `data: []`.
3. **[HIGH - SUSPECTED] `POST /api/admin/sync-products`, `/api/promos/validate`, & `/api/full-validate` Tidak Berbatas Ketat:** `/api/promos/validate` tanpa rate limiter memungkinkan enumerasi kode promo & probing `customer_game_id` (`SEC-026`); `/api/full-validate` berbatas 300 req/5m per IP dapat menguras kuota berbayar `pgscode.id` jika key aktif.
4. **[MEDIUM - SUSPECTED] `POST /api/admin/balance/reduce` Memakai `type='Refund'` & Timestamp Collision (`balance.routes.js:70-89`):** Menerima angka desimal, memakai reference `ADMIN_REDUCE-${Date.now()}` yang bisa bertabrakan jika 2 call terjadi pada milidetik yang sama.
5. **[MEDIUM - SUSPECTED] Deadlock Pool & Orphan Notification (`foxyCallback.routes.js:235, 242`, `admin/transactions.routes.js:111, 138`):** `await createNotification()` mengambil koneksi pool kedua saat `client` utama masih memegang lock `BEGIN ... FOR UPDATE` sebelum `COMMIT`.
6. **[MEDIUM - SUSPECTED] Admin Resolve Tidak Mengirim Webhook H2H & Menolak Status `'Processing'` (`admin/transactions.routes.js:91, 106-153`):** Resolusi manual `Partial Refund` -> `Success`/`Failed` tidak memicu `dispatchSafeH2HWebhook`, sedangkan transaksi `Processing` tidak bisa di-resolve.
7. **[MEDIUM - SUSPECTED] Dashboard H2H Callback Form Terblokir IP Whitelist & Key One-Time (`h2hIntegration.js:460-470`, `h2h.routes.js:151`):** `PUT /h2h/profile/callback` memakai `protectH2HIp` + `X-API-Key`, sehingga reseller yang mengisi whitelist IP server produksinya tidak bisa memperbarui webhook URL dari browser dashboard; selain itu role `BRONZE` belum dibatasi untuk membuat API key H2H (`userApiKey.routes.js:75`).
8. **[MEDIUM - SUSPECTED] `admin.html` Tambah Produk Stub & Validasi Mobapay Tertimpa (`catalog.js:427`, `validationAndPrices.js:23-70, 180`):** Form HTML "Tambah Produk" masih ada tapi di-stub JS, dan membuka+menyimpan modal validasi pada produk `mobapay-mlbb-eligibility` akan menimpa config menjadi nonaktif karena dropdown validator hanya memuat data PGSCODE.
9. **[LOW/MEDIUM - SUSPECTED] Celah Validasi & Aksesibilitas Lainnya:** Tidak adanya `getBodyObject` check di `order.routes.js:27`, `deposit.routes.js:114`, `h2h.routes.js:39`; input `targetGameId` >80 karakter diam-diam terpotong oleh `normalizeString` & karakter `|` merusak pemisah `${id}|${server}`; `cronJob.js:27` memakai lock file non-atomik di `os.tmpdir()` (`SEC-019`); CSP `img-src` menolak `http://` yang diizinkan helper UI `dom.js:27`; input `.toggle-password` memakai `<i>` non-focusable.

---

## 7. Hasil Automated Testing

| Suite | Perintah | Hasil | Lokasi Artefak |
|---|---|---|---|
| **Backend Lint & Asset Check** | `cd backend && npm run check` | **PASS** (`limit_warnings=0`, 87 routes clean pada `check-route-overlap.js`) | Terminal / `backend/` |
| **Backend Unit & Integration (Mock DB/Foxy)** | `cd backend && npm test` | **PASS** (`205 / 205` lulus, 30 suite, 0 gagal, 0 skipped) | `backend/tests/` |
| **QA Playwright E2E, API & Security Suite** | `cd qa && npm.cmd test` | **39 skenario:** **`13` `PASS:` lulus**, **`26` `@bug-BUG-*` gagal** *(expected-to-fail sbg bukti regresi bug terbukti)* | [index.html](file:///d:/DICKY%20BELAJAR/topup-miku/qa/artifacts/playwright-report/index.html), `qa/artifacts/playwright-results.json`, `qa/test-results/` |

**Cara menjalankan ulang seluruh suite QA:**
1. Terminal 1: `cd qa && npm.cmd run mock:foxy`
2. Terminal 2: `cd backend && npm.cmd start` *(memakai `.env` lokal `FOXY_BASE_URL=http://127.0.0.1:4010`)*
3. Terminal 3: `cd qa && npm.cmd test`

---

## 8. Hasil Performance & Resilience (Edge Headless)

- **Ukuran Aset Statis `frontend/`:** `58` file, total **`626.0 KB`** (`js`, `css`, `html`).
- **Metrik Muat Halaman (Desktop `1440px` / Mobile `375px`):**
  - `index.html`: TTFB `2 ms`, FCP `588 ms` / `1036 ms`, Full Load `2284 ms` / `2881 ms`, Transfer `117.7 KB` *(dipengaruhi pemuatan CDN eksternal Font Awesome / Google Fonts)*.
  - `product.html?gameId=1`: Load `166 ms` / `123 ms`, Transfer `88.8–89.1 KB`.
  - `cek-transaksi.html` & `compare-prices.html`: Load `101–127 ms`, Transfer `22.3–41.6 KB`.
- **Lighthouse CLI:** `N/A` (tidak terpasang di environment lokal).
- **Resilience Offline:** Saat `GET /api/games` diputus di `index.html`, grid menampilkan `"Gagal memuat katalog game. Silakan muat ulang halaman."` tanpa crash. Saat error load pada `product.html` / `dashboard.html`, judul `#game-name` dan profil berisiko tertahan di teks `"Memuat..."`.

---

## 9. Top 10 Prioritas Perbaikan

1. **Perbaiki Price Guard Cache & Flash Sale di Bawah Modal (`BUG-026`, `BUG-007`, `BUG-024`):** Nonaktifkan/perkecil TTL cache harga provider saat order, wajib validasi `Number.isFinite(cost)`, larang flash sale `< modal` tanpa flag subsidi, dan samakan role baseline storefront (`BRONZE`).
2. **Alirkan `FOXY_BASE_URL` dari `constants.js` ke `jobs/pendingTransactions.js` & `productSync.js` (`BUG-003`)** serta lindungi `syncProductsWithFoxy` dari `data: []` (`SEC-018`) & null `category_type`.
3. **Hapus atau Kunci `POST /api/test` (`BUG-001`)** dan tambahkan rate limiter pada `/api/promos/validate`, `/api/full-validate`, serta `/api/admin/*`.
4. **Perbaiki Kontrak Admin Panel (`BUG-002`, `BUG-016`, `BUG-022`, `BUG-021`):** Hapus role `'Admin'` dari editor harga manual, kirim `promo-max-discount`, selaraskan `maxlength="200"` reject deposit, dan redirect user non-admin dari `admin.html`.
5. **Sinkronkan Query Flash Sale & Promo Katalog (`BUG-004`, `BUG-017`, `BUG-018`):** Filter `(max_uses IS NULL OR uses_count < max_uses)`, hentikan override harga dari URL `fsPrice`, dan reset state promo saat input berubah.
6. **Perketat Validasi Provider Phase (b), Admin Balance, & IP Whitelist (`BUG-006`, `BUG-005`, `BUG-009`):** Pastikan `/v1/order` wajib JSON `status === true`, pakai `requirePositiveInt` di `balance.routes.js`, dan tolak non-string di `whitelisted-ips`.
7. **Perbaiki Schema FK `password_resets` (`BUG-008`) & Pencabutan JWT + Case-Insensitive Email (`BUG-011`):** Tambahkan `ON UPDATE CASCADE` (atau hapus token reset lama) saat ganti email, `LOWER(email)` saat login, dan `token_version` untuk revokasi JWT.
8. **Tambahkan Lock User `FOR UPDATE` pada Deposit (`BUG-013`) & Perbaiki Cooldown Callback (`BUG-012`):** Cegah bypass batas 2 deposit Pending serta jangan tandai cooldown jika `/v1/status` gagal 500.
9. **Sediakan Endpoint Status/Riwayat Transaksi H2H (`BUG-010`), H2H Webhook di Admin Resolve, & Audit Log Lengkap (`BUG-014`, `BUG-015`):** Tambah `GET /h2h/transactions` & `GET /h2h/order/:id`, lengkapi `admin_audit_logs`, serta sembunyikan `base_price` & game Inactive di `/api/public/compare-prices`.
10. **Perapian UI/UX Desktop & Mobile (`BUG-019`, `BUG-020`, `BUG-023`, `BUG-025`, `BUG-UI-01..02`):** Tambah `/favicon.ico`, ubah `step="1"` deposit, perbaiki `.password-wrapper` `reset-password.html`, tata ulang lebar tabel dashboard/admin pada 1440px, dan perbaiki double caret `<select>`.

---

## 10. Hal yang Sudah Baik (Wajib Dipertahankan)

- **Arsitektur 3-Fase Lock-Free (`orderService.js`):** Transaksi DB `FOR UPDATE` diputus sebelum panggilan HTTP Foxy sehingga pool DB tidak pernah terkuras (terbukti pada stress test 30 order paralel vs `pool.max=10`).
- **Idempotency & Anti-Double-Spend / Anti-Double-Refund (`idempotency.js`, `refundService.js`, `migrations/007` & `011`):** Terbukti pada tes konkurensi H2H (saldo cukup 1 order vs 10 paralel = tepat 1 sukses, saldo akhir `Rp 0`), isolasi `ref_id` antar-user, serta constraint DB `users_balance_non_negative` + `idx_unique_refund_per_invoice` + `idx_unique_deposit_credit`.
- **Zero-Trust Callback & Anti-SSRF H2H (`foxyCallback.routes.js`, `webhookClient.js`):** Callback mengabaikan `status`/`sn` body dan memverifikasi ke `/v1/status/:trx_id`; webhook reseller memblokir HTTP, localhost, IP privat/CGNAT, dan metadata cloud serta menandatangani HMAC-SHA256 (`X-Timestamp`, `X-Signature`).
- **Keamanan Dasar Express & Frontend (`securityHeaders.js`, `dom.js`):** `script-src 'self'` murni bebas inline script/XSS pada HTML & template JS, error 500 dibersihkan tanpa stack trace, dan login/reset password memakai bcrypt cost 12 serta token single-use SHA-256.
