# Rencana Perombakan UI (Gelombang UI-1: Design System + Storefront + Produk 4 Langkah)

Branch: `feat/ui-pro-standar` (dari `main` setelah merge `refactor/frontend`).
Prinsip: `miku-store-pro-standar` + `miku-store-code-structure` + `modern-web-guidance`.
Batasan keras:
- Tidak mengubah file apa pun di bawah `backend/` (hanya menjalankan `npm run check` & `npm test` sebagai verifikasi regresi).
- Menjaga kontrak API backend (`POST /api/order`, `/api/games`, `/api/public/flash-sales`, `/api/products/:id/validate`, `/api/promos/validate`, `/api/auth/*`, `/api/user/*`, `/api/public/notifications`) beserta key payload & `Idempotency-Key` tetap identik.
- Batas ukuran file: `JS <= 600` baris, `CSS <= 800` baris, `0` `limit_warnings` pada `scripts/check-frontend-assets.js`.
- Seluruh file berformat **LF murni** (`i/lf w/lf`).
- Tidak ada migrasi database pada gelombang ini.

---

## 1. Audit "AI Slop" & Inkoherensi Token (`frontend/css/*` & Markup UI-1)

| Kategori Temuan | Lokasi & Baris Aktual | Masalah Saat Ini | Rencana Perbaikan UI-1 |
| :--- | :--- | :--- | :--- |
| **Gradien tombol, kartu, & background** | `tokens.css:10` (`--primary-gradient`), `base.css:61-62` (`radial-gradient` pada `body`), `components.css:35,301,321,337`, `modalsAndForms.css:112`, `storefront.css:80,88,210,222,235,261,371`, `product.css:424,429,439,465` | Pemakaian gradien ganda biru-cyan (`135deg`, radial background glow, teks logo gradient-fill, gradien overlay berat pada kartu game & step checkout) membuat hierarki visual bising | Hapus gradien dekoratif & background radial; pakai permukaan solid bertingkat (`--bg` -> `--surface` -> `--surface-2`), `border: 1px solid var(--border)`, dan 1 aksen solid `--accent` (`#22B8CF`) dengan teks kontras tinggi `--accent-fg` (`#06222A`). Alias kompatibilitas `--primary-gradient` untuk halaman Gelombang 2 diarahkan ke `var(--accent)` tanpa gradien ganda |
| **Glow, drop-shadow & blur berlebih** | `index.html:71,80-99` (`.miku-hero-bg-glow` + SVG gamepad 120px gradient), `components.css:324,328,334`, `storefront.css:60,225,263,295,360,405`, `product.css:85,156,457,467`, `productStepNav.css:21-22` (`backdrop-filter`) | Efek cyan glow di tombol/kartu/banner, `drop-shadow` pada SVG dekoratif besar, dan glow ring hover | Hapus elemen `.miku-hero-bg-glow` dan SVG dekoratif hero; ganti hover state ke kontras warna border/surface + transisi `150ms`; jaga `:focus-visible` dengan `outline: 2px solid var(--accent); outline-offset: 2px` |
| **Radius berlebih (>10px)** | `storefrontNav.css:23` (`25px`), `L175` (`9999px`), `storefront.css:15` (`12px`), `L224` (`16px`), `L255` (`9999px`), `L365` (`12px`), `components.css:91` (`15px`), `L333` (`12px`) | Sudut pil besar pada search bar (`25px`/`9999px`), banner `16px`, kartu `12px`, dan badge pill | Standarisasi token radius: `--radius-sm: 6px` (input, tombol, chip kompak), `--radius-md: 10px` (kartu & panel), `--radius-pill: 999px` khusus avatar/badge status kompak |
| **Warna hex / literal di luar `tokens.css`** | `components.css:27,32,87,94,102,108,317,323,338,441`, `modalsAndForms.css:47,113`, `storefrontNav.css:16,258`, `storefront.css:98,173,222,262,268,275`, `product.css:39,97,132,164-171,191,196,225,254,283,288,300,425,440`, `productStepNav.css:15,35,43,55,67`, `script.js:218,280,295` | Banyak hex light-theme tersisa (`#e6ffed`, `#ffe6e6`, `#ccc`), teks muted berbeda-beda (`#888`, `#aaa`, `#a7a9be`, `#9ca3af`), serta literal `white` / `red` inline | Konsolidasi seluruh palet ke skala netral 6 level di `tokens.css` (`--bg: #0B0F17`, `--surface: #121826`, `--surface-2: #1A2233`, `--border: #263043`, `--text: #E6EAF2`, `--text-muted: #8B95A7`) dan 4 warna status (`--success: #22C55E`, `--warning: #F59E0B`, `--danger: #EF4444`, `--info: #60A5FA`), termasuk versi soft tint `color-mix()` / token transparan untuk badge/alert inline |
| **Z-index tidak terstandarisasi** | `components.css:225` (`toast: 1000`), `L344` (`header: 100`), `modalsAndForms.css:17` (`modal: 100`), `storefrontNav.css:37,76,142` (`200`), `L251` (`header: 999`), `productStepNav.css:14` (`90`) | `header` & `.modal-overlay` sama-sama `100` (atau header storefront `999` menutupi modal `100`!) | Standarisasi token di `tokens.css`: `--z-navbar: 50`, `--z-dropdown: 60`, `--z-modal: 70`, `--z-toast: 80` |
| **Marquee / duplikasi DOM Flash Sale & Kartu** | `script.js:169-182` (clone span judul), `L395-400` (duplikasi kartu Flash Sale), `storefront.css:134,440-483` (`@keyframes`) | Kartu Flash Sale diduplikasi untuk marquee tak terbatas dan judul panjang digandakan | Hapus kloning kartu Flash Sale & marquee gerak otomatis; gunakan rail scroll horizontal manual (`overflow-x: auto; scroll-snap-type: x mandatory`) dengan lebar kartu tetap & `hidden` bila 0 item |
| **Tipografi angka & hierarki heading** | `index.html:24` (`<h1 class="logo">` + `hero h2`), `product.html:20` (`<h1 class="logo">` + `h2#game-name`), tanpa `font-variant-numeric: tabular-nums` pada harga/countdown | Beberapa `<h1>` di header vs konten; angka nominal/countdown bisa bergeser lebarnya saat tick | Ganti logo navbar ke `<a><span>MIKU Store</span></a>`, jadikan judul utama konten `<h1>` (`1` `<h1>` per halaman); terapkan `font-variant-numeric: tabular-nums` pada harga, saldo, diskon, total, dan countdown |

---

## 2. Audit Lebar Kontainer, Grid & Responsif (`360px`, `768px`, `1280px`)

1. **Ketidaksejajaran `.container`**:
   - `base.css` memuat 3 aturan `.container` bertumpuk (`L12: 95% / 1200px`, `L50: min(94%, 100% - 1rem)`, `L79-80: 94% / 1180px`), sedangkan `components.css:351` & `L474` menimpa `.header-container` dengan padding berbeda (`0 0.75rem`, `0.55rem 0.85rem`).
   - `product.css` menimpa `.order-page-wrapper` menjadi `920px` (`L17`), lalu `1060px` (`L526`), lalu `1080px !important` (`L571`), tidak sejajar dengan `<header>` dan `<footer>`.
   - **Perbaikan**: Satu definisi tunggal `.container { width: 100%; max-width: 1200px; margin-inline: auto; padding-inline: var(--space-4); }` (`16px` mobile) dan `padding-inline: var(--space-6)` (`24px` desktop `>= 769px`). Header, hero, grid, wrapper 2-kolom `product.html`, dan footer semua memakai `.container` yang sama tanpa override lebar sempit di `.order-page-wrapper`.

2. **Viewport & Zoom Aksesibilitas**:
   - `index.html:5` dan `product.html:5` masih memakai `maximum-scale=1.0, user-scalable=no` (menghambat WCAG 1.4.4). Diganti ke `<meta name="viewport" content="width=device-width, initial-scale=1.0">` sambil memastikan kontrol form memiliki `font-size: max(1rem, 1em)` (`>= 16px`) agar iOS tidak auto-zoom saat fokus.

3. **Grid Responsif 360px / 768px / 1280px**:
   - `360px`: Dengan `padding-inline: 16px`, lebar konten efektif adalah `328px`. Memakai `grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr))` dan `gap: 12px` menghasilkan 2 kolom bersih (`(328 - 12) / 2 = 158px >= 150px`) tanpa overflow horizontal.
   - `768px` (tablet) & `1280px` (desktop): Grid otomatis mengisi 4 hingga 6 kolom proporsional dengan rasio kartu seragam (`aspect-ratio: 3 / 4` pada thumbnail + footer judul 1–2 baris rapi).
   - Fallback gambar gagal: Hapus total URL `https://via.placeholder.com/...` di `product.html:58` dan `script.js:172,226`. Pakai fallback DOM inisial game (`.game-thumb-fallback` / `.product-thumb-fallback`) saat `image_url` kosong atau event `error` memicu penggantian tampilan yang aman via DOM (`escapeHtml` / `textContent`). Tambah `loading="lazy"` pada gambar kartu grid game dan Flash Sale, serta prioritaskan hero/logo game di `product.html` (`fetchpriority="high"` tanpa `loading="lazy"`).

---

## 3. Audit Storefront, Navbar (`<= 7` Item), & Footer (`index.html`, `storefront*.css`, `script.js`)

- **Konsolidasi Navbar (`index.html` + `storefrontNav.css` + `script.js`)**:
  - Desktop bar maksimal **6 item sejajar** (`<= 7`): Brand `MIKU Store`, `<search>` kotak cari game (`#search-input` dengan hint shortcut `/` dan debounce `250ms`), tautan `Cek Transaksi`, menu dropdown `"Lainnya"` (`<button type="button" aria-expanded="false" aria-controls="more-nav-menu">` memuat `Validasi ID`, `Pricelist`, `Leaderboard`), tombol Notifikasi (`<button type="button" id="notification-toggle-btn">` minimal `44x44px`, `aria-label="Notifikasi"`, `aria-expanded="false"`), dan tombol Akun/Masuk (`#user-auth-button`).
  - Mobile (`<= 768px`): `#hamburger-btn` (`>= 44x44px`, `aria-label`, `aria-expanded`, `aria-controls="dropdown-menu"`) membuka panel drawer/popover `#dropdown-menu` rapi tanpa bertabrakan dengan search bar (`order` CSS tetap mengikuti urutan DOM agar tab order logis).
  - Keyboard & aksesibilitas popup: `Escape` menutup search dropdown, menu `"Lainnya"`, dan panel notifikasi; teks dinamis dari API pada `#search-results` dan `#notification-list` di-escape lewat `escapeHtml()` (`MikuShared.dom`).

- **Hero Ringkas + Filter Kategori Nyata**:
  - Hero 1 blok kompak tanpa SVG hiasan & glow, judul singkat `<h1>Top Up Game Instan & Terpercaya</h1>` + 1 baris subjudul.
  - Chip/tab kategori sejajar di atas grid (`Semua`, `Mobile Game`, `PC Game`, `Voucher Digital`) dengan state `aria-pressed` / filter langsung di `script.js` agar memilih tab memfokuskan katalog tanpa menyembunyikan kategori backend (`Special MLBB` tergabung di `Mobile Game`, `Life Style` di `Voucher Digital`, dan jumlah hasil tersaji jelas).

- **Flash Sale & Footer Profesional**:
  - `#flash-sale-section`: Sembunyi (`.hidden`) jika `/api/public/flash-sales` kosong. Kartu memiliki lebar tetap (`210px` mobile / `228px` desktop) di lintasan `overflow-x: auto; scroll-snap-type: x mandatory`, countdown dengan `tabular-nums`, tanpa kloning kartu ganda.
  - Footer multi-kolom bersih dalam `.container`: Brand + Jam Operasional CS (`Otomatis 24/7`, respon admin `1x24 jam`), Tautan Layanan (`/cek-transaksi.html`, `/validate.html`, `/compare-prices.html`, `/leaderboard.html`), serta Bantuan & Kebijakan (`/syarat-ketentuan.html`, `/kebijakan-refund.html`, `/kontak.html`) — semua link menunjuk ke halaman yang benar-benar ada (`0` broken link).

---

## 4. Audit Alur Produk 4 Langkah & Bar Aksi Sticky Mobile (`product.html`, `product*.css`, `js/product/*`)

- **Kelemahan Saat Ini**:
  1. `validation.js:19-20` & `L74-75` langsung mengaktifkan `#submit-order-btn` (`disabled = false`) saat kartu nominal diklik meski User ID kosong / belum tervalidasi.
  2. `#order-step-3` hanya promo, sementara pemilihan metode pembayaran pasif di Step 4.
  3. Di mobile (`<= 768px`), tidak ada bar aksi sticky bawah untuk langsung melihat total dan menekan tombol Bayar saat berada di Step mana pun.
  4. Kartu nominal `<div class="product-card-selectable">` tidak fokus-able via keyboard.

- **Perbaikan Alur 4 Langkah (`product.html`, `js/product/*`, `product.css`, `productStepNav.css`)**:
  1. **Langkah 1 (`#order-step-1`)**: Input `#target-game-id` berlabel eksplisit `<label for="target-game-id">User ID</label>`, `#server-input-container` kondisional (`Zone / Server ID`), feedback validasi inline `#validation-result` (`aria-live="polite"`) menampilkan nickname/region. Mengedit ID/Server otomatis membatalkan status validasi sebelumnya & menyinkronkan tombol bayar. Juga menambahkan event `change` pada `<select id="target-server-id">` dan fallback bila produk "tidak memerlukan validasi".
  2. **Langkah 2 (`#order-step-2`)**: Grid kartu `<button type="button" class="product-card-selectable" aria-pressed="false">` (`min-height: 56px`), angka harga `tabular-nums`, label Flash Sale / harga coret hanya dirender saat `isFlashSale` dan harga asli lebih tinggi dari harga diskon.
  3. **Langkah 3 (`#order-step-3`)**: Pilihan metode pembayaran interaktif (kartu pilih `Saldo Akun` dengan info biaya `Rp 0` — dapat diklik/toggle state `selectedPaymentMethod = 'balance'`), plus form opsional Kode Promo (`#promo-form`, `#promo-code-input`, `#apply-promo-btn`, `#promo-result`) tepat di bawahnya.
  4. **Langkah 4 (`#order-step-4`)**: Ringkasan pesanan lengkap (`Game`, `Tujuan / Nickname`, `Nominal`, `Metode Pembayaran`, `Potongan Promo` jika aktif, dan `#total-price` `tabular-nums`). State machine terpusat `app.checkout.syncActionState()` menyinkronkan `#submit-order-btn` (desktop) dan `#mobile-submit-order-btn` (mobile sticky bar) + `#mobile-total-price`:
     - Saat submit berjalan -> `disabled = true`, `"Memproses..."` + spinner inline (cegah double-click).
     - Saat User ID kosong -> `disabled = true`, `"Masukkan User ID dulu"`.
     - Saat Server ID diwajibkan dan kosong -> `disabled = true`, `"Lengkapi Server ID dulu"`.
     - Saat produk belum dipilih -> `disabled = true`, `"Pilih nominal dulu"`.
     - Saat validasi belum sukses -> `disabled = true`, `"Validasi User ID dulu"` (atau `"Periksa ulang User ID"` bila gagal).
     - Saat metode pembayaran belum dipilih -> `disabled = true`, `"Pilih metode pembayaran dulu"`.
     - Semua valid -> `disabled = false`, `"Bayar Sekarang"`. Klik membuka `#order-confirmation-modal` (atau `#auth-modal` bila belum login) dengan kontrak `POST /api/order` & `Idempotency-Key` tetap utuh.
  5. **Mobile Sticky Action Bar (`#mobile-checkout-bar`)**: Tampil di `<= 768px` (`position: fixed; inset-inline: 0; inset-block-end: 0; z-index: var(--z-navbar)`), menampilkan total harga `#mobile-total-price` dan `#mobile-submit-order-btn` (`>= 44x44px`), dengan `padding-bottom` tambahan pada `body`/`main` agar footer terbawah tidak tertutup. `#mobile-step-nav` di atas memakai `top` sticky yang solid (tanpa `backdrop-filter` / transparansi buram) dengan indikator 4 langkah: `1. ID`, `2. Produk`, `3. Metode`, `4. Bayar`.

---

## 5. Peta 3 Commit Gelombang UI-1

| Commit | Pesan Commit | File yang Diubah | Verifikasi Wajib |
| :--- | :--- | :--- | :--- |
| **UI-1a (Commit 1)** | `feat(ui): terapkan design system token, base layout, dan komponen UI-1a` | `docs/ui-overhaul-plan.md`, `frontend/css/tokens.css`, `frontend/css/base.css`, `frontend/css/components.css`, `frontend/css/modalsAndForms.css` | `node scripts/check-frontend-assets.js`, `cd backend && npm run check && npm test`, `node backend/scripts/check-route-overlap.js`, cek batas baris & EOL |
| **UI-1b (Commit 2)** | `feat(ui): perbarui storefront, navigasi sticky, dan grid game UI-1b` | `frontend/index.html`, `frontend/css/storefrontNav.css`, `frontend/css/storefront.css`, `frontend/script.js` | `check-frontend-assets.js`, Node VM smoke test `script.js`, cek EOL & batas baris (`script.js <= 600`, CSS `<= 800`), `backend` checks |
| **UI-1c (Commit 3)** | `feat(ui): terapkan alur topup 4 langkah dan bar aksi mobile sticky UI-1c` | `frontend/product.html`, `frontend/css/product.css`, `frontend/css/productStepNav.css`, `frontend/js/product/state.js`, `frontend/js/product/validation.js`, `frontend/js/product/checkout.js`, `frontend/js/product/mobileStepNav.js` | `check-frontend-assets.js`, Node VM smoke test `MikuProduct` (5 state validasi + promo + retry idempotency + mobile sticky sync), cek EOL & batas baris, `git diff --name-only main..HEAD` (`0` file backend), `backend` full suite |

Catatan ukuran target pasca UI-1:
- Semua file CSS di `frontend/css/` tetap jauh di bawah `800` baris (target ~30–450 baris per modul).
- `frontend/script.js` dan modul `frontend/js/product/*.js` masing-masing tetap di bawah `600` baris (`script.js <= 590`, modul produk `<= 320` baris).


---

# Rencana Perombakan UI (Gelombang UI-2: Dashboard Member & Integrasi Reseller API H2H)

Target: [dashboard.html](file:///d:/DICKY%20BELAJAR/topup-miku/frontend/dashboard.html), [portal.css](file:///d:/DICKY%20BELAJAR/topup-miku/frontend/css/portal.css), [dashboard.css](file:///d:/DICKY%20BELAJAR/topup-miku/frontend/css/dashboard.css), [dashboardOverview.css](file:///d:/DICKY%20BELAJAR/topup-miku/frontend/css/dashboardOverview.css), [dashboardDeposit.css](file:///d:/DICKY%20BELAJAR/topup-miku/frontend/css/dashboardDeposit.css), [dashboardH2H.css](file:///d:/DICKY%20BELAJAR/topup-miku/frontend/css/dashboardH2H.css), dan seluruh modul di `frontend/js/dashboard/*.js`.
Kontrak API backend yang dijaga penuh (tanpa modifikasi folder `backend/`):
- Member & Profil: `GET/PUT /api/user/profile`, `PUT /api/user/password`, `GET /api/user/transaction-summary`, `GET /api/user/transactions`, `GET /api/user/transaction/:invoiceId`, `GET /api/user/balance-history`, `GET /api/user/deposits`.
- Deposit & Metode Pembayaran: `GET /api/payment-methods`, `POST /api/deposit/request` (beserta header `Idempotency-Key` dan semantik rotasi 2xx/4xx vs pertahankan saat 5xx).
- H2H Partner & Security: `GET/DELETE /api/user/apikey`, `POST /api/user/generate-apikey`, `POST /api/user/apikey/regenerate`, `GET /api/user/webhook-secret`, `POST /api/user/webhook-secret/rotate`, `GET/PUT /api/user/whitelisted-ips`, serta endpoint partner `/h2h/products`, `/h2h/order`, `/h2h/profile`, `PUT /h2h/profile/callback` (header `X-API-Key`).

---

## 1. Audit "AI Slop", Duplikasi, Privasi & Kondisi Kosong (Gelombang 2)

| Kategori Temuan | Lokasi & Baris Aktual | Masalah Saat Ini | Rencana Perbaikan UI-2 |
| :--- | :--- | :--- | :--- |
| **Warna hex hardcoded, gradient, glow & radius** | `portal.css:108,194-195,259` (gradient aktif sidebar, `z-index: 300/299/998`), `dashboard.css:61,165-167,182,184,211,237-240,281-287,299,304,460-461`, `dashboardOverview.css:27,42,74,112-153,190-192,221-224,250,264-273,307` (gradient 4 kartu stat warna-warni, radial `.credits-glow`, radius `12px`/`14px`, label ALL CAPS), `dashboardDeposit.css:79,136-150,188,197,225-237,278,328,335,441,448,461`, `dashboardH2H.css:13,28,38,81,88,96` (`#a7a9be`, `#38bdf8`, `20px`) | Pemakaian linear/radial gradient penuh di kartu saldo/deposit/statistik, glow shadow, hex non-token (`#a7a9be`, `#67e8f9`, `#34d399`, `#fbbf24`, `#fb7185`, `#0f172a`), label ALL CAPS (`BERHASIL`, `STATISTIK PESANAN`, `MIKU STORE CREDITS`, `AKSES CEPAT MEMBER`), serta `z-index` melompat (`299/300/998/999`) | Migrasikan seluruh warna/radius/spasi ke `tokens.css`; hapus seluruh gradient & `.credits-glow`; kartu statistik memakai latar netral `var(--surface)` + border `1px var(--border)` dengan warna semantik hanya pada angka (`24px`) & ikon kecil; pakai sentence case untuk label `12px`; standarisasi z-index drawer mobile (`backdrop: 59`, `sidebar: 60` di bawah `modal: 70`) |
| **Duplikasi tombol aksi & navigasi** | `dashboard.html:85` (tombol `.sidebar-cta-btn` `"Top Up Saldo"` di dalam `.sidebar-member-card`), `L179` (`"Top Up Saldo"` di kartu Saldo), `L185-196` (banner `.dashboard-quick-banner` berisi `Mutasi Saldo`, `Cek Pesanan`, `API H2H` yang mengulang menu sidebar `L66-74`) | Tombol primer `"Top Up Saldo"` muncul ganda di sidebar & konten utama pada satu layar; kartu akses cepat mengulang item navigasi sidebar | Hapus `.sidebar-cta-btn` dari `.sidebar-member-card` dan hapus `.dashboard-quick-banner`; pertahankan satu tombol primer `"Top Up Saldo"` langsung di Kartu Saldo utama |
| **Hierarki Overview & Teks Bahasa Indonesia** | `dashboard.html:92-183`, `dashboard.html:6,29,171` (`maximum-scale=1.0, user-scalable=no`, `<h1 class="logo">` di header, `"MIKU STORE CREDITS"`, `"Credits"`, inkonsistensi istilah) | Ringkasan statistik menempati urutan pertama sebelum saldo; tidak ada preview daftar transaksi terbaru di Overview; istilah campur Inggris (`Credits`, `Review`, `User`) | Urutkan Overview: **(1) Kartu Saldo utama** (`tabular-nums` + 1 tombol primer `Top Up Saldo`) + Profil ringkas -> **(2) Daftar Transaksi Terbaru** (5 transaksi terakhir + link ke riwayat penuh) -> **(3) Kartu Statistik Ringkas** (angka `24px`, label `12px` netral). Pindahkan `<h1>` ke judul portal utama dan ganti viewport agar ramah aksesibilitas |
| **Privasi Email & WhatsApp tanpa masking** | `overview.js:28-29`, `dashboard.html:151-165` | Email lengkap dan nomor WhatsApp langsung dirender mentah ke DOM pada muatan awal (`miku@gmail.com`, `+6281234567964`) | Terapkan fungsi masking default (`m***@gmail.com` dan `+62 8**-****-7964`) saat render awal, disertai tombol aksesibel `"Tampilkan"` / `"Sembunyikan"` (`aria-pressed="false"`) per field |
| **Empty state polos & tabel responsif** | `transactions.js:17,24-30,64,71-76` (belum ada tombol aksi saat kosong, `product_name`/`target_game_id`/`description` belum di-escape, tidak ada filter status transaksi, tabel `360px` rentan melebar keluar), `deposit.js:339,372` (`0` deposit polos, form tanpa preset nominal cepat & rincian biaya/kode unik live), `h2hIntegration.js:235` (`"Belum ada IP yang didaftarkan."` polos tanpa empty state terarah, belum ada form Callback URL tervalidasi, kartu referensi cepat H2H, atau toggle secret sesi) | Tabel tanpa filter/scroll-isolation tegas; beberapa field belum di-escape (`transactions.js`); empty state hanya kalimat teks tanpa tombol CTA; form deposit tanpa preset nominal & preview total + kode unik; bagian H2H belum memuat kartu referensi cepat maupun konfigurasi Callback URL | Isolasi scroll horizontal di `.table-container` dengan `tabindex="0"` & `role="region"`; tambah filter status + CTA `"Mulai Top Up Pertama"` saat kosong; escape semua teks dinamis dari API; tambahkan chip nominal cepat + pratinjau nominal/kode unik di form Deposit; lengkapi panel H2H dengan modal tampil-sekali + konfirmasi eksplisit, Webhook Secret toggle/salin sesi + Callback URL tervalidasi, tambah/hapus IP whitelist dengan validasi CIDR/IP inline & empty state jelas, serta kartu referensi cepat H2H (`X-API-Key`, Base URL, payload `ref_id`) |

---

## 2. Peta 3 Commit Gelombang UI-2

| Commit | Ruang Lingkup & File | Fokus Utama |
| :--- | :--- | :--- |
| **UI-2a (Commit 1)** | `docs/ui-overhaul-plan.md`, `frontend/css/portal.css`, `frontend/css/dashboard.css`, `frontend/css/dashboardOverview.css`, `frontend/dashboard.html`, `frontend/js/dashboard/state.js`, `frontend/js/dashboard/overview.js`, `frontend/js/dashboard/profile.js` | Sidebar sticky desktop (`top: 61px; height: calc(100dvh - 61px)`), drawer mobile slide-in + backdrop + `Esc` + target `>= 44x44px`, tata hierarki Overview (`Saldo Utama -> Transaksi Terbaru -> Statistik Ringkas 24px/12px`), hapus duplikasi tombol `Top Up Saldo` & banner akses cepat, masking default email/WA + tombol `Tampilkan`/`Sembunyikan` (`aria-pressed`) |
| **UI-2b (Commit 2)** | `frontend/css/dashboardDeposit.css`, `frontend/js/dashboard/deposit.js`, `frontend/js/dashboard/transactions.js`, `frontend/dashboard.html` | Preset nominal cepat + input `>= 16px`, pratinjau nominal + estimasi kode unik `tabular-nums`, tombol submit disable + spinner (jaga rotasi `Idempotency-Key`), panel instruksi transfer & tombol salin; tabel transaksi & mutasi terisolasi di `.table-container` aman di `360px`, filter status transaksi, escaping XSS, empty state ber-CTA |
| **UI-2c (Commit 3)** | `frontend/css/dashboardH2H.css`, `frontend/js/dashboard/h2hIntegration.js`, `frontend/dashboard.html`, `docs/ui-overhaul-plan.md` | Manajemen API Key (`Prefix` ter-mask, modal tampil sekali saat buat/regenerate + konfirmasi eksplisit Rotate/Revoke), Webhook Secret (status ter-mask, toggle/salin sesi setelah rotasi + konfirmasi Rotate), form Callback URL tervalidasi HTTPS (`PUT /h2h/profile/callback` dengan header `X-API-Key` atau salin snippet siap pakai), form IP/CIDR allowlist dengan validasi inline + list rapi + empty state terarah, dan Kartu Referensi Cepat H2H (`Base URL`, header `X-API-Key`, payload minimal ber-`ref_id` + tombol salin); pembaruan hash commit & ukuran akhir file di `docs/ui-overhaul-plan.md` |

---

## 3. Log Commit & Ukuran Akhir File Gelombang UI-2

- **UI-2a (`b37ab44`)**: `feat(ui): perbarui layout portal sticky, hierarki overview saldo, dan masking profil UI-2a`
- **UI-2b (`3fd89cd`)**: `feat(ui): perbarui UX deposit, preset nominal, filter transaksi, dan empty state UI-2b`
- **UI-2c (`HEAD` pada cabang `feat/ui-pro-standar`)**: `feat(ui): perbarui UX integrasi reseller API H2H dan dokumen rencana UI-2c`

### Catatan Kontrak Backend yang Dijaga Tanpa Modifikasi
- Middleware `protectH2H` (`backend/middleware/h2hAuth.js`) membaca autentikasi reseller secara eksklusif dari header `X-API-Key` (bukan `Authorization: Bearer`), sehingga Kartu Referensi Cepat H2H mendokumentasikan `X-API-Key: <API_KEY_ANDA>` dan `PUT /h2h/profile/callback` mengirimkan header `X-API-Key` sesuai kontrak server aktif.
- Endpoint `GET /api/user/webhook-secret` hanya mengembalikan prefix (`hasWebhookSecret`, `status`, `prefix`); secret penuh hanya dikembalikan satu kali pada respons `POST /api/user/generate-apikey` atau `POST /api/user/webhook-secret/rotate`. Tombol `Tampilkan`/`Sembunyikan` dan `Salin` di panel Webhook Secret menampilkan secret penuh dari state sesi tepat setelah rotasi dan memberi informasi jujur setelah muat ulang halaman.

### Ukuran Akhir File Gelombang UI-2

| File | Jenis | Jumlah Baris | Batas Maksimum | Status |
| :--- | :--- | :---: | :---: | :--- |
| `frontend/css/portal.css` | CSS | 202 | <= 800 | Memenuhi |
| `frontend/css/dashboard.css` | CSS | 323 | <= 800 | Memenuhi |
| `frontend/css/dashboardOverview.css` | CSS | 364 | <= 800 | Memenuhi |
| `frontend/css/dashboardDeposit.css` | CSS | 524 | <= 800 | Memenuhi |
| `frontend/css/dashboardH2H.css` | CSS | 442 | <= 800 | Memenuhi |
| `frontend/js/dashboard/state.js` | JS | 219 | <= 600 | Memenuhi |
| `frontend/js/dashboard/overview.js` | JS | 240 | <= 600 | Memenuhi |
| `frontend/js/dashboard/profile.js` | JS | 135 | <= 600 | Memenuhi |
| `frontend/js/dashboard/deposit.js` | JS | 505 | <= 600 | Memenuhi |
| `frontend/js/dashboard/transactions.js` | JS | 269 | <= 600 | Memenuhi |
| `frontend/js/dashboard/h2hIntegration.js` | JS | 542 | <= 600 | Memenuhi |
| `frontend/dashboard.html` | HTML | 660 | - | Terstruktur rapi |
