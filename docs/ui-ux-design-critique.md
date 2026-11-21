# Audit Desain UI/UX & Blueprint Upgrade Visual — MIKU Store

**Peran Auditor:** Lead UI/UX Designer & Gaming E-Commerce Design Critic  
**Tanggal Audit:** 21 November 2026  
**Cakupan:** Storefront (`index.html`), Checkout (`product.html`), Dashboard Member (`dashboard.html`), Halaman Publik (`cek-transaksi.html`, `compare-prices.html`, `validate.html`, `leaderboard.html`, `kontak.html`), serta Design System (`tokens.css`, `base.css`, `components.css`, `portal.css`)  
**Kendala Arsitektur Wajib:** `CSP script-src 'self'` (tanpa inline JS/CDN JS baru), batas keras `CSS <= 800` baris & `JS <= 600` baris, 1 aksen primer (`#22B8CF`), WCAG AA (`>= 4.5:1` teks, `>= 3:1` batas UI).

---

## 1. Skor Visual Saat Ini (1–10) & 5 Alasan Paling Jujur Kenapa Terasa "Hambar"

| Area | Skor Saat Ini | Catatan Singkat |
| --- | :---: | --- |
| **Storefront & Hero (`index.html`)** | **5.5 / 10** | Strukturnya rapi dan cepat dipindai, tetapi Hero datar tanpa visual focal point/banner promo, Flash Sale minus badge `%` hemat, dan fallback gambar game polos seperti wireframe. |
| **Checkout Top-Up (`product.html`)** | **6.5 / 10** | Alur 4 langkah & sticky summary sudah sangat kuat secara UX, namun header game datar, kartu nominal memotong teks bonus (`line-clamp: 2`), state terpilih kurang tegas, dan CTA bayar kurang dominan. |
| **Dashboard Member (`dashboard.html`)** | **6.0 / 10** | Hierarki informasi tepat, tetapi kartu Saldo terasa seperti panel status biasa (bukan dompet digital), ada duplikasi `Kembali ke Toko`, label `Member` tidak sinkron dengan role `Admin`/`Partner`, dan `Keluar Akun` terancam terpotong di laptop 720p–768p. |
| **Halaman Publik (`leaderboard`, `compare-prices`, `cek-transaksi`, `validate`)** | **5.8 / 10** | Fungsional dan bersih, tetapi Leaderboard belum punya efek podium gamified, tabel Pricelist belum menonjolkan keunggulan tier reseller, dan halaman utilitas terasa terlalu klinis. |
| **Design System & Micro-interactions (`tokens.css`, `base.css`, `components.css`)** | **6.0 / 10** | Token sangat disiplin dan aksesibel, tetapi terlalu datar (shadow terdefinisi namun tidak dipakai), satu keluarga font tanpa display pairing, dan kontrol minus feedback taktil (`:active`, hover lift). |
| **Skor Visual Keseluruhan** | **6.0 / 10** | **Stabil & rapi seperti template SaaS B2B, belum memiliki daya tarik emosional dan kepercayaan visual toko top-up game kelas atas.** |

### 5 Alasan Paling Jujur Kenapa Web Terasa "Hambar"

1. **Over-koreksi "Anti AI-Slop" yang Mematikan Depth Visual (`storefront.css:3-17`, `dashboardOverview.css:28-36`, `tokens.css:53-54`):**  
   Penghapusan seluruh gradien, cahaya ambient, dan bayangan lembut membuat setiap permukaan (`.hero-card`, `.card`, `.product-card`, `.balance-summary`) hanya berupa kotak abu-abu gelap `#121826` dengan border datar `1px solid #263043`. Bahkan token `--shadow-sm` di `tokens.css:53` didefinisikan namun tidak pernah dipakai di kartu mana pun. Hasilnya lebih mirip dasbor internal DevOps daripada toko game.
2. **Hero Tanpa Focal Point Visual & Tanpa Visual Storytelling (`index.html:143-155`, `storefront.css:8-61`):**  
   Di toko top-up game (seperti Codashop, Lapakgaming, UniPin, Razer Gold), 2 detik pertama pembeli mencari *suasana gaming + promo aktif + sinyal kepercayaan instan*. Saat ini Hero MIKU Store hanya kotak teks datar dengan 2 tombol (salah satunya `Cek Transaksi` yang sudah ada di Left Icon Rail & Footer).
3. **Fallback Gambar Game Polos Memicu Kesan "Situs Belum Jadi" (`script.js:47-70`, `storefront.css:326-337`):**  
   Ketika `image_url` kosong atau gagal dimuat, katalog menampilkan kotak polos `#1A2233` berisi 2 huruf cyan (`ML`, `FF`, `GI`). Bagi pembeli baru, placeholder seperti ini menurunkan kepercayaan transaksi uang secara drastis.
4. **Tipografi Monoton Satu Karakter (`base.css:3, 50-75`, `tokens.css:31-38`):**  
   `Inter` dipakai seragam dari logo, judul Hero, judul game, nominal harga, sampai label tabel tanpa kontras display/editorial. Selain itu, `@import url('https://fonts.googleapis.com/...')` di `base.css:3` memperlambat penemuan font (render-blocking cascade).
5. **Interaksi Terasa "Mati" / Kurang Taktil (`components.css:65-73`, `product.css:266`, `base.css:116-125`):**  
   Hover pada kartu produk, kartu nominal, dan tombol primer hanya mengubah warna border/latar tanpa micro-lift (`translate`), tanpa shadow elevasi, dan tanpa efek tekan (`:active { scale: 0.98 }`). Di sisi lain, aturan global `prefers-reduced-motion` di `base.css:120-122` mematikan *seluruh* transisi termasuk transisi warna non-gerak dengan `0.01ms !important` (anti-pattern menurut `modern-web-guidance` `motion`).

> **Catatan Rekonsiliasi dengan `miku-store-pro-standar`:**  
> Upgrade visual ini **tidak** kembali ke "AI slop" (neon pelangi di semua kartu atau animasi berlebihan). Kita beralih ke **Disciplined Gaming Fintech Dark UI**: 90% permukaan tetap netral gelap, 1 aksen brand `#22B8CF`, tetapi dengan **hierarki elevasi berlapis**, **3 titik fokus visual terukur** (Banner Hero, Game Checkout Backdrop, Kartu Dompet Saldo), **badge hemat `%` yang jujur**, dan **micro-interaction compositor-only** yang ringan.

---

## 2. Daftar Kritik Tajam per Halaman

### A. Design System (`tokens.css`, `base.css`, `components.css`, `securityHeaders.js`)

| # | Masalah Visual/UX (`file:baris`) | Dampak ke Kesan / Konversi | Rekomendasi Perbaikan Konkret |
| --- | --- | --- | --- |
| DS-1 | **Layer elevasi gelap kurang terpisah & `--shadow-sm` tidak dipakai** (`frontend/css/tokens.css:5-9, 53-54`; `frontend/css/components.css:190-197`) | Semua kartu menyatu datar di atas latar `#0B0F17`; mata pembeli tidak langsung menangkap mana elemen terpenting (CTA/Saldo/Produk terpilih). | Tambahkan token `--surface-elevated: #1E293B`, `--border-subtle: rgba(255, 255, 255, 0.06)`, `--border-strong: #334155`, `--shadow-card: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.55)`, serta `--shadow-accent: 0 8px 20px -6px rgba(34, 184, 207, 0.35)`. Terapkan `--in-oklab` progressive fallback (`visual-effects` guide) agar interpolasi gradien gelap bebas shift warna. |
| DS-2 | **Satu keluarga font untuk semua peran & `@import` font memblokir render** (`frontend/css/base.css:3`; `frontend/css/tokens.css:31-38`) | Judul Hero, Logo, dan angka Saldo tidak punya karakter khas brand gaming; potensi delay render font pada jaringan 4G. | Pasangkan `--font-display: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif` (bobot `700/800`) untuk `.logo`, `h1`, `.hero-title`, `.balance-amount`, dan `.product-card-price`, sementara `--font-sans: 'Inter', ...` tetap untuk body/tabel. Pindahkan muatan Google Fonts ke `<link rel="preconnect">` + `<link rel="stylesheet">` (100% kompatibel dengan CSP `style-src`/`font-src` di `backend/middleware/securityHeaders.js:7-8`). |
| DS-3 | **Tidak ada pembeda visual antara hover, active press, dan keyboard focus** (`frontend/css/components.css:65-73, 102-116`) | Klik tombol dan pilihan nominal terasa kaku/statis seperti halaman statis 2015, bukan aplikasi transaksi cepat. | Ikuti pola `modern-web-guidance` `natural-interactions`: tambahkan `:active:not(:disabled) { scale: 0.98; }` pada tombol primer & kartu pilih, hover elevasi `box-shadow` halus pada `.topup-btn`/`.order-button`, dan pertahankan `:focus-visible` (`outline: 2px solid var(--accent); outline-offset: 3px`) sehingga kombinasi hover + focus + active tetap berbeda jelas. |
| DS-4 | **Reset global `prefers-reduced-motion` memakai `0.01ms !important`** (`frontend/css/base.css:116-125`) | Memutus transisi warna non-motion dan berpotensi membuat animasi terasa patah pada pengguna reduced-motion. | Ikuti `modern-web-guidance` `motion`: hapus blok wildcard `0.01ms !important` dan bungkus animasi gerak (`translate`, `scale`, `scroll-behavior: smooth`, animasi carousel) di dalam `@media (prefers-reduced-motion: no-preference)`, sambil tetap menjaga transisi `color`/`background-color`/`border-color` yang halus. |
| DS-5 | **Forced Colors Mode belum punya fallback eksplisit untuk state berbasis background/shadow** (`frontend/css/tokens.css:12-27`, `frontend/css/product.css:274-278`) | Pada Windows High Contrast, kartu terpilih yang mengandalkan `background-color` tint dan shadow bisa kehilangan indikasi aktif. | Tambahkan penegasan `border-width: 2px` + ikon centang pada state aktif/terpilih dan pastikan `@media (forced-colors: active)` mempertahankan `outline: 2px solid Highlight` pada item terpilih (`color` guide). |

---

### B. Storefront & Hero (`index.html`, `storefront.css`, `storefrontNav.css`, `script.js`)

| # | Masalah Visual/UX (`file:baris`) | Dampak ke Kesan / Konversi | Rekomendasi Perbaikan Konkret |
| --- | --- | --- | --- |
| SF-1 | **Hero datar tanpa visual banner/carousel & tombol sekunder duplikat** (`frontend/index.html:143-155`; `frontend/css/storefront.css:3-61`) | Kesan pertama langsung terasa seperti template admin generik; tidak ada highlight promo aktif yang memancing klik cepat; `Cek Transaksi` duplikat dengan Left Icon Rail (`index.html:127`). | Ubah `.hero-section` menjadi **Hero Showcase Split / Promo Banner Carousel**: di kiri/atas copy ringkas + ambient radial glow subtil (`radial-gradient(circle at 85% 20% var(--in-oklab), color-mix(in oklab, var(--accent) 22%, transparent), transparent 60%)`) + pola titik geometris halus (`visual-effects` pattern), dipadukan dengan **Carousel Banner Promo 2–3 slide** berbasis CSS scroll-snap (`overscroll-behavior-x: contain`, tombol prev/next `<button>`, marker dot ber-indikator lebar+warna, tanpa auto-play paksa atau wajib tombol Pause sesuai `carousel` & `motion` guide). |
| SF-2 | **Tidak ada Trust Strip cepat di atas lipatan (above-the-fold)** (`frontend/index.html:143-155`) | Pembeli baru yang pertama kali mendarat harus menebak kecepatan proses, keamanan akun, dan dukungan CS; konversi ragu-ragu pada transaksi pertama. | Tambahkan baris **Trust Strip** 4 micro-item tepat di bawah Hero (`grid-template-columns: repeat(4, minmax(0, 1fr))` desktop, 2×2 mobile): `Proses 1–30 Detik`, `Cek Nickname Otomatis`, `Harga Reseller & H2H`, `Garansi Refund Gagal`. Pakai permukaan `--surface` tipis + ikon aksen `16px` tanpa teks panjang. |
| SF-3 | **Kartu Flash Sale tidak menampilkan badge hemat `%`, format harga memakai `,00` berlebih, dan track minus `overscroll-behavior-x`** (`frontend/script.js:338-346`; `frontend/css/storefront.css:149-233`) | Pembeli tidak langsung menangkap besarnya diskon (menurunkan urgensi klik); `,00` membuat angka `Rp 15.000,00` tampak sempit & berantakan; geser mentok di HP bisa memicu back-navigation browser. | (1) Hitung `discountPct = Math.round((1 - discount / original) * 100)` dan tampilkan pill badge **`-XX%`** di sudut kanan atas `.flash-sale-media` (`background: var(--danger)` atau `var(--warning)` + teks kontras tinggi). (2) Hapus `{ withDecimals: true }` agar harga tampil bersih `Rp 15.000`. (3) Tambahkan `overscroll-behavior-x: contain` pada `.flash-sale-track` dan progress bar kuota tipis bila `max_uses` tersedia. |
| SF-4 | **Fallback gambar game hanya kotak abu-abu polos berisi 2 huruf (`ML`, `GI`)** (`frontend/script.js:47-70, 134`; `frontend/css/storefront.css:308-337`) | Katalog terlihat seperti dummy/wireframe apabila admin belum mengunggah semua thumbnail game. | Buat sistem **Category-Themed Fallback Art** memakai CSS murni + `data-category` (mis. `mobile`: gradasi cyan-indigo, `pc`: gradasi violet-slate, `voucher`: gradasi emerald-teal) dengan pola diagonal/radial halus, watermark ikon kategori (`fa-gamepad`/`fa-desktop`/`fa-ticket`) ber-opacity `0.08`, emblem monogram berbingkai, serta pill kategori kecil. Pada kartu yang punya gambar asli, tambahkan scrim bawah halus (`linear-gradient(to top, rgba(11,15,23,0.75), transparent 55%)`) + hover lift (`translate: 0 -3px`) dan image zoom (`scale: 1.04`, di dalam `@media (prefers-reduced-motion: no-preference)`). |
| SF-5 | **Bar filter kategori kurang menonjol & tidak sticky saat scroll katalog panjang** (`frontend/index.html:176-184`; `frontend/css/storefront.css:236-278`) | Saat katalog tumbuh >12 game, pembeli harus scroll balik ke atas untuk ganti kategori; chip terasa datar tanpa ikon visual pembeda. | Tambahkan ikon kecil pada tiap `.category-chip`, beri state aktif bayangan lembut `--shadow-accent`, dan jadikan `.catalog-controls` sticky di bawah navbar (`position: sticky; top: var(--navbar-height, 60px); z-index: 20; backdrop-filter: blur(8px)`) sesuai standar §2 `miku-store-pro-standar`. |

---

### C. Halaman Checkout (`product.html`, `product.css`, `validation.js`)

| # | Masalah Visual/UX (`file:baris`) | Dampak ke Kesan / Konversi | Rekomendasi Perbaikan Konkret |
| --- | --- | --- | --- |
| CO-1 | **Header game `#game-info` datar, tanpa atmosfer/cover & badge polos** (`frontend/product.html:120-130`; `frontend/css/product.css:70-126`) | Perpindahan dari storefront ke halaman beli terasa "kering"; tidak ada konteks visual game dan kurang memberi rasa aman sebelum input User ID. | Ubah `#game-info` menjadi **Game Hero Header** dengan `position: relative; overflow: clip; isolation: isolate;` + subtle radial backdrop glow di sudut kiri atas (diambil dari aksen brand), bingkai `.game-hero-thumb` `88×88px` dengan shadow elevasi, ubah `.game-badge` menjadi pill ber-ikon (`Proses Otomatis 24/7`), dan tambah 2 micro-badge kepercayaan (`Validasi ID Real-Time`, `Refund Otomatis Jika Gagal`). |
| CO-2 | **Kartu nominal memotong teks bonus dengan elipsis (`-webkit-line-clamp: 2`) & terlalu sempit** (`frontend/css/product.css:239-291`; `frontend/js/product/validation.js:211-236`) | Informasi krusial bagi gamer seperti `(234 + 23 Bonus)` atau `Weekly Diamond Pass` terpotong `...` sehingga pembeli ragu apakah nominal yang dipilih benar-benar menyertakan bonus. | (1) Perlebar grid desktop dari `minmax(150px, 1fr)` menjadi `minmax(172px, 1fr)` (mobile tetap `repeat(2, minmax(0, 1fr))` yang rapi). (2) Hapus pemotongan agresif pada nama nominal (atau pecah teks `(...)` secara otomatis di `validation.js` menjadi `<span class="product-card-bonus">...</span>` berwarna aksen lembut di bawah nama utama) agar bonus 100% terbaca. (3) Naikkan `min-height: 90px` dan padding `12px 14px`. |
| CO-3 | **Kartu nominal minus ikon item, minus checkmark terpilih, dan tag Flash Sale terlalu kecil** (`frontend/css/product.css:252-323`; `frontend/js/product/validation.js:224-231`) | State terpilih hanya mengandalkan perubahan warna latar/border (kurang kontras bentuk / WCAG 1.4.1); Flash Sale hanya tulisan miring `0.7rem` tanpa badge `%`. | Tambahkan badge centang kecil di pojok kanan atas saat `.product-card-selectable.selected` (`border: 2px solid var(--accent)` + `box-shadow: 0 0 0 1px var(--accent) inset`), tambahkan ikon currency/diamond subtil (`fa-gem` / `fa-bolt` untuk flash sale), dan ganti `<em class="product-tag">Flash Sale</em>` menjadi pill hemat `-XX%` kontras tinggi di sudut atas kartu. |
| CO-4 | **Tombol CTA `#submit-order-btn` kurang tegas & tidak menunjukkan progres kelengkapan langkah** (`frontend/product.html:213-214`; `frontend/css/product.css:504-540`) | Saat seluruh langkah sudah valid, tombol `Bayar Sekarang` secara visual masih datar dan kurang memberi sinyal "siap transaksi aman". | Tingkatkan `#submit-order-btn:not(:disabled)`: `min-height: 50px`, `font-size: var(--text-base)`, tambah ikon gembok/petir (`fa-shield-halved` / `fa-bolt`), elevasi `box-shadow: var(--shadow-accent)`, subtle top specular border, serta `:active { scale: 0.985 }`. Pada `#payment-info`, perkuat baris `.total-payment` dengan latar subtle `--surface-2` & padding internal agar total bayar menonjol seketika. |

---

### D. Dashboard Member (`dashboard.html`, `dashboard.css`, `dashboardOverview.css`, `portal.css`, `overview.js`)

| # | Masalah Visual/UX (`file:baris`) | Dampak ke Kesan / Konversi | Rekomendasi Perbaikan Konkret |
| --- | --- | --- | --- |
| DB-1 | **Kartu Saldo `.balance-summary` datar seperti kartu biasa** (`frontend/dashboard.html:104-118`; `frontend/css/dashboardOverview.css:29-81`) | Area terpenting member & reseller (uang/saldo) tidak terasa premium dan tidak membedakan fungsi dompet dari kartu profil di sebelahnya. | Desain `.balance-summary` sebagai **Premium Digital Wallet Card**: latar gradasi subtil gelap-ke-cyan (`linear-gradient(135deg var(--in-oklab), var(--surface) 0%, color-mix(in oklab, var(--accent) 14%, var(--surface)) 100%)`), aksen radial glow lembut di kanan atas, garis pola halus CSS, top rim highlight `inset 0 1px 0 rgba(255,255,255,0.08)`, badge status `Dompet Aktif`, serta tombol `Top Up Saldo` dengan elevasi `--shadow-accent`. |
| DB-2 | **Tautan `Kembali ke Toko` ganda di layar desktop** (`frontend/dashboard.html:40-43` di header DAN `frontend/dashboard.html:68` di sidebar; `frontend/css/dashboard.css:382`) | Kebisingan visual (3 tautan ke `index.html` berdekatan termasuk logo), plus menyia-nyiakan `46px` tinggi sidebar desktop. | Sembunyikan `.sidebar-store-link` pada desktop (`@media (min-width: 769px) { .sidebar-store-link { display: none; } }`) dan tampilkan hanya di drawer mobile (`<= 768px`), tempat `.header-back-home` memang disembunyikan. |
| DB-3 | **Label `Member` hardcoded tidak sinkron dengan role `Admin` / `Partner` / `Gold`** (`frontend/dashboard.html:50, 61, 98`; `frontend/js/dashboard/overview.js:85-110`) | Saat akun `Admin` atau reseller `PARTNER`/`GOLD` masuk dashboard, header tetap menulis `Member` sementara kartu profil menulis `Admin`/`PARTNER` — terlihat seperti bug/kurang profesional. | Tambahkan `id="header-user-role"` pada `dashboard.html:50` dan perbarui di `overview.js` memakai `data.role`; ubah heading generik ke `Dashboard Akun` (atau `Area Akun` di badge sidebar), dan tampilkan tombol pintas `Panel Admin` di sidebar/header khusus bila `String(data.role).toLowerCase() === 'admin'`. |
| DB-4 | **Tinggi sidebar desktop memotong tombol `Keluar Akun` pada layar laptop `768px–900px` (tinggi viewport `640px–768px`)** (`frontend/css/portal.css:16-24`; `frontend/css/dashboard.css:107-182`; `frontend/dashboard.html:59-91`) | Total tinggi isi sidebar (`~636px`) melebihi `calc(100dvh - 61px)` pada layar laptop 13"–14", sehingga tombol `Keluar Akun` terdorong keluar layar/terpotong tanpa indikator scroll. | (1) Hilangkan link `Kembali ke Toko` ganda di desktop (`-46px`). (2) Di `@media (min-width: 769px)`, turunkan tinggi item `.sidebar-nav a` ke `min-height: 38px` (`padding: 6px 12px`) dan rapatkan `.sidebar-group-title` (`padding: 8px 12px 2px`) — tetap `44px` pada mobile/`(pointer: coarse)`. (3) Jadikan `.sidebar-nav` area scroll internal (`flex: 1 1 auto; min-height: 0; overflow-y: auto;`) dan pin `.sidebar-member-card` (`flex-shrink: 0`) di bawah sidebar dengan `top: 73px; height: calc(100dvh - 85px);` agar `Keluar Akun` selalu terlihat utuh. |
| DB-5 | **Kartu KPI status pesanan & daftar transaksi terbaru masih terlalu datar** (`frontend/css/dashboardOverview.css:267-335`) | Status `Berhasil`, `Pending`, `Perlu Review`, `Gagal` tampak seperti 4 kotak identik berjarak longgar. | Beri garis aksen atas tipis `2px` atau ikon berwadah lingkaran lembut (`var(--success-soft)`, `var(--info-soft)`, `var(--warning-soft)`, `var(--danger-soft)`) pada `.stat-icon` agar tiap metrik langsung terbaca secara periferal tanpa mewarnai seluruh kartu (tetap patuh §1.1 `miku-store-pro-standar`). |

---

### E. Halaman Publik (`leaderboard.html`, `compare-prices.html`, `cek-transaksi.html`, `validate.html`, `publicPages.css`)

| # | Masalah Visual/UX (`file:baris`) | Dampak ke Kesan / Konversi | Rekomendasi Perbaikan Konkret |
| --- | --- | --- | --- |
| PB-1 | **Leaderboard tidak punya diferensiasi podium Top 3** (`frontend/leaderboard.html:32-55`; `frontend/css/publicPages.css:374-495`) | Peringkat #1–#3 terlihat seperti baris list datar biasa sehingga kehilangan unsur prestise & daya tarik kompetitif bagi pelanggan setia. | Tambahkan gaya **Top-3 Podium Highlight** pada `.lb-entry.rank-1/2/3` berupa subtle gradient wash (`color-mix(in oklab, var(--warning) 10%, var(--surface))` untuk Rank #1) + ikon mahkota/medali + elevasi lembut, sambil menjaga daftar #4–#10 tetap ringkas dan netral. |
| PB-2 | **Tabel Compare Prices tidak menyorot keuntungan margin tier reseller** (`frontend/compare-prices.html:51-68`; `frontend/css/publicPages.css:148-196`) | Calon reseller tidak langsung melihat selisih harga hemat antara Bronze vs Gold/Partner. | Beri highlight lembut pada kolom tier tertinggi / `Partner` (`background: color-mix(in oklab, var(--accent) 6%, transparent)`) + label kecil `Populer Reseller` pada header kolom, serta tambahkan baris ringkasan singkat di atas tabel. |
| PB-3 | **Halaman Cek Transaksi & Validasi ID terlalu polos (header teks mentah)** (`frontend/cek-transaksi.html:34-37`; `frontend/validate.html:46-49`; `frontend/css/publicPages.css:9-26`) | Terlihat seperti form admin internal, kurang memberi ketenangan kepada pembeli yang sedang cemas mengecek pesanan. | Bungkus `.public-page-header` dengan aksen ikon berwadah (`40×40px` soft accent tile) + garis aksen subtil, dan tingkatkan `.trx-submit-btn` / `#validate-form button[type="submit"]` dengan elevasi + `:active` micro-interaction. |

> **Peringatan Batas Ukuran File (`publicPages.css` = 744/800 baris):**  
> `frontend/css/publicPages.css` saat ini sudah **744 baris** (hanya tersisa 56 baris sebelum batas keras `800`). Sebelum menerapkan polish PB-1 & PB-2, ekstrak styling khusus Leaderboard (`publicPages.css:319-540`) ke file terpisah `frontend/css/leaderboard.css` (`~240` baris) agar `publicPages.css` turun ke `~520` baris dan tetap aman `limit_warnings=0`.

---

## 3. Rencana Upgrade Visual 3 Fase

Seluruh fase dirancang **incremental, zero-breaking-change**, 100% patuh CSP (`script-src 'self'`), dan menjaga setiap file di bawah batas keras (`CSS <= 800`, `JS <= 600`).

### Fase 1 — Quick Wins Berdampak Terbesar (~1 Jam Kerja)
**Target:** Menghapus kesan "template SaaS datar" seketika di seluruh situs lewat kedalaman surface, pairing tipografi, kartu dompet saldo, perbaikan sidebar dashboard, dan micro-interaction dasar.

| Item Perubahan | File yang Disentuh | Estimasi Baris Akhir | Batas |
| --- | --- | ---: | ---: |
| Tambah token elevasi (`--surface-elevated`, `--shadow-card`, `--shadow-accent`, `--in-oklab`, `--font-display`) | `frontend/css/tokens.css` | ~110 | 800 |
| Pairing `Plus Jakarta Sans` (display) + `Inter` (body) via `<link>` di HTML utama, perbaiki `prefers-reduced-motion` scoped (hapus wildcard `0.01ms`) | `frontend/css/base.css` | ~140 | 800 |
| Terapkan `--shadow-card` halus pada `.card`, tambah `:active` tactile press + hover elevasi pada tombol primer/sekunder | `frontend/css/components.css` | ~685 | 800 |
| Upgrade `.balance-summary` jadi Digital Wallet Hero Card + ikon berwadah pada KPI status | `frontend/css/dashboardOverview.css` | ~515 | 800 |
| Perbaiki tinggi sidebar laptop (`min-height: 38px` desktop, `.sidebar-nav` scroll internal, `Keluar Akun` selalu tampil) & hilangkan duplikasi `Kembali ke Toko` di desktop | `frontend/css/portal.css`, `frontend/css/dashboard.css` | ~225 / ~435 | 800 |
| Sinkronkan label role header (`id="header-user-role"` vs `Admin`/`Partner`) & tombol pintas `Panel Admin` khusus Admin | `frontend/dashboard.html`, `frontend/js/dashboard/overview.js` | ~665 / ~265 | — / 600 |

### Fase 2 — Polish Kartu Katalog, Flash Sale & Checkout Konversi (~1.5–2 Jam Kerja)
**Target:** Meningkatkan konversi langsung di alur belanja (`index.html` → `product.html`) lewat visual game fallback yang profesional, badge `%` hemat, kartu nominal anti-potong bonus, dan CTA bayar dominan.

| Item Perubahan | File yang Disentuh | Estimasi Baris Akhir | Batas |
| --- | --- | ---: | ---: |
| Game fallback artwork bertema kategori (CSS gradient/pattern + ikon watermark + badge kategori), scrim & hover lift pada kartu game, sticky `.catalog-controls` + ikon chip | `frontend/css/storefront.css`, `frontend/script.js` | ~485 / ~495 | 800 / 600 |
| Badge diskon `-XX%` di Flash Sale, hapus `,00` desimal berlebih, tambah `overscroll-behavior-x: contain` & bar kuota tipis bila `max_uses` ada | `frontend/css/storefront.css`, `frontend/script.js` | *(termasuk di atas)* | 800 / 600 |
| Game Hero Header ber-backdrop glow + trust pills di `product.html`; perlebar grid nominal, tampilkan teks bonus utuh (tanpa terpotong elipsis), tambah checkmark terpilih + badge `-XX%` + CTA `#submit-order-btn` dominan | `frontend/product.html`, `frontend/css/product.css`, `frontend/js/product/validation.js` | ~348 / ~745 / ~415 | — / 800 / 600 |

### Fase 3 — Hero Promo Banner Carousel, Halaman Publik & Micro-interaction Lanjutan (~2 Jam Kerja)
**Target:** Memberikan identitas storefront gaming kelas komersial dan memoles halaman pendukung (Leaderboard & Pricelist).

| Item Perubahan | File yang Disentuh | Estimasi Baris Akhir | Batas |
| --- | --- | ---: | ---: |
| Hero Promo Banner Carousel (scroll-snap native, ambient `oklab` glow, prev/next + marker aksesibel, tanpa auto-play mengganggu) + 4-item Trust Strip di bawah Hero | `frontend/index.html`, `frontend/css/storefront.css`, `frontend/js/shared/heroCarousel.js` *(baru, `<script defer>`)* | ~375 / ~615 / ~130 | — / 800 / 250 |
| Aset SVG/WebP promo banner lokal ringan (`frontend/assets/banners/`) — 100% CSP `img-src 'self'` & `< 40KB` per aset dengan `width`/`height` eksplisit (anti-CLS) | `frontend/assets/banners/*` | — | — |
| Ekstrak styling Leaderboard agar `publicPages.css` turun ke ~520 baris, lalu tambahkan Podium Top-3 Highlight & penyorotan kolom tier Reseller pada Compare Prices | `frontend/css/publicPages.css`, `frontend/css/leaderboard.css` *(baru)*, `frontend/leaderboard.html`, `frontend/compare-prices.html` | ~540 / ~280 | 800 / 800 |
| Polish transisi masuk dropdown/modal dengan `@starting-style` / `transition-behavior: allow-discrete` (progressive enhancement dalam `prefers-reduced-motion: no-preference`) | `frontend/css/modalsAndForms.css`, `frontend/css/storefrontNav.css` | ~285 / ~665 | 800 / 800 |

---

## 4. Checklist Verifikasi Setiap Fase (Wajib Setelah Eksekusi)

- `cd backend && npm.cmd run check` → `exit 0`, `limit_warnings=0`, `0` broken CSS/JS refs.
- `cd backend && npm.cmd test` → `222/222` lulus.
- `node scripts/check-route-overlap.js` → `88/88` identik.
- Uji visual & reflow pada `360px`, `390px`, `768px`, `1280×720` (khusus cek tinggi sidebar `Keluar Akun`), dan `1440×900` tanpa horizontal scroll (`scrollWidth <= innerWidth`), plus uji keyboard `Tab`/`Escape` dan kontras teks >= 4.5:1.
