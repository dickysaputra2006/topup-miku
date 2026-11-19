# Rencana Perbaikan Temuan QA (`topup-miku`)

## Batch 1 — Integritas Harga, Flash Sale, & Keamanan Provider (`fix/pricing-and-provider-safety`)

- **Branch:** `fix/pricing-and-provider-safety` (dari `main` `@ 2404baa` pasca-merge `qa/audit`)
- **Cakupan Bug:** `BUG-026`, `BUG-007`, `BUG-024`, `BUG-004`, `BUG-003`, `BUG-006`
- **Migrasi Database:** **Tidak ada migrasi skema SQL baru** (`001`–`012` tetap utuh). Khusus DB lokal sandbox, `npm run seed` perlu dijalankan ulang pasca-Commit 2 untuk menyelaraskan harga flash sale seed `DUMMY-ML-86` (`17500` -> `19500`).

---

### 1. Audit Pemanggil & Batas Ukuran File

| File | Baris Saat Ini | Batas Keras | Rencana Perubahan & Dampak Ukuran |
|---|---|---|---|
| `backend/services/orderService.js` | `595` | `<= 600` | Pindahkan `fetchRealtimeFoxyCostForOrder` ke `foxyClient.js` (-25 baris); perketat cek respons Fase (b) (+5 baris) → estimasi **~575 baris** (`<= 600`). |
| `backend/services/foxyClient.js` | `125` | `<= 600` | Tambah opsi `{ bypassCache = false }` di `getFoxyProducts` + pindahkan `fetchRealtimeFoxyCostForOrder` (validasi fail-closed `Number.isFinite(cost) && cost >= 0`, `bypassCache: true`) → estimasi **~165 baris**. |
| `backend/services/priceService.js` | `290` | `<= 600` | Filter kuota flash sale `(max_uses IS NULL OR uses_count < max_uses)` dan cek `flashPrice > 0 && flashPrice < normalPrice` di `calculateCatalogProducts` & `getGameProductsCatalog` → estimasi **~300 baris**. |
| `backend/routes/admin/flashSales.routes.js` | `113` | `<= 400` | Cek `products.price` sebelum `INSERT flash_sales`; tolak `400` jika `discount_price < modal` kecuali `allow_below_cost === true` (flag subsidi eksplisit) → estimasi **~135 baris**. |
| `backend/routes/h2h.routes.js` | `187` | `<= 400` | Filter `(max_uses IS NULL OR uses_count < max_uses)` dan cek `flashPrice > 0 && flashPrice < normalPrice` di `GET /h2h/products` → estimasi **~195 baris**. |
| `backend/routes/public.routes.js` | `376` | `<= 400` | Filter kuota flash sale pada `/api/public/compare-prices`; ubah join `/api/public/flash-sales` dari `r.id = 1` ke baseline storefront `LOWER(r.name) = 'bronze'` + filter produk/game aktif & `discount_price < original_price` → estimasi **~385 baris**. |
| `backend/jobs/pendingTransactions.js` | `285` | `<= 600` | Hapus hardcode `FOXY_BASE_URL`/`PROVIDER_TIMEOUT_MS`; impor dari `../config/constants.js` → estimasi **~285 baris**. |
| `backend/jobs/productSync.js` | `156` | `<= 600` | Impor `FOXY_BASE_URL` & `PROVIDER_TIMEOUT_MS` dari `../config/constants.js`; tambah guard `SEC-018` tolak array kosong `providerProducts.length === 0` agar tidak menonaktifkan seluruh katalog, dan fallback aman untuk `category_type` null/kosong → estimasi **~168 baris**. |
| `backend/scripts/seed_local_dummy.js` | `389` | script | Ubah harga flash sale seed `DUMMY-ML-86` dari `17500` ke `19500` (`>= modal 19000`, `< normal BRONZE 21281`). |
| `backend/tests/integration/pricingAndProviderGuards.test.js` | baru | `<= 800` | Tes regresi unit/integrasi untuk seluruh 6 bug Batch 1 (~300–450 baris). |

#### Audit Pemanggil Eksisting
- **`getFoxyProducts()`:** Dipanggil di `orderService.js` (akan dipindah ke `foxyClient.js` dengan `{ bypassCache: true }`) dan `priceService.js:183` (`/api/promos/validate`, tetap kompatibel default cache 5m).
- **`fetchRealtimeFoxyCostForOrder()`:** Dipanggil di `orderService.js:396` (`executeWebOrder`) dan `orderService.js:502` (`executeH2HOrder`).
- **Query `flash_sales`:**
  - `orderService.js:184` & `priceService.js:140`: sudah memfilter `(max_uses IS NULL OR uses_count < max_uses)` dan `flashPrice < effectivePrice`.
  - `priceService.js:93`, `h2h.routes.js:70`, `public.routes.js:90`: **belum** memfilter kuota habis; `priceService.js:21` & `h2h.routes.js:95` **belum** mengecek `flashPrice < normalPrice`.
  - `public.routes.js:151`: masih `LEFT JOIN roles r ON r.id = 1` (`User` 10%) alih-alih `BRONZE` (12%) dan belum menyaring `p.status = 'Active' AND g.status = 'Active'`.
- **`FOXY_BASE_URL`:** `config/constants.js:27` sudah memakai `process.env.FOXY_BASE_URL`, namun `jobs/pendingTransactions.js:15` & `jobs/productSync.js:4` masih hardcode `https://api.foxygamestore.com`.

---

### 2. Analisis Risiko Pembayaran, Saldo, & Provider

1. **Bypass cache pada `fetchRealtimeFoxyCostForOrder` (`BUG-026`):** Setiap order memanggil `GET ${FOXY_BASE_URL}/v1/products` langsung sebelum Fase (a) (tetap di luar transaksi DB, tidak menahan koneksi pool). Risiko latensi ~50–300 ms terkompensasi karena melindungi toko dari kerugian langsung saat harga supplier naik. Fungsi `invalidateFoxyProductCache()` tetap diekspor agar 100% kompatibel dengan `orderPriceGuardAndLock.test.js`.
2. **Fail-closed `NaN`/negatif (`BUG-007`):** Jika Foxy mengembalikan `product_price` non-numerik (`"NOT_A_NUMBER"`, `null`, `""`, `< 0`), order ditolak `HTTP 400` dengan pesan aman `'Harga produk sedang diperbarui, silakan coba lagi nanti.'` sebelum memotong saldo.
3. **Validasi modal Flash Sale (`BUG-024`):** Memblokir pembuatan flash sale rugi di `POST /api/admin/flash-sales` bila `discount_price < product.price` (kecuali `allow_below_cost === true`). Pastikan tidak memecah tes skema `authAndSchemaHardening.test.js` (yang menguji input negatif & `end_at <= start_at` sebelum query DB).
4. **Pengetatan respons Fase (b) `/v1/order` (`BUG-006`):** Hanya menerima respons HTTP 200 bila `foxyRes.data` adalah plain object non-null dengan `foxyRes.data.status === true`. Respons HTML/Cloudflare challenge atau tanpa `status === true` diperlakukan sebagai penolakan eksplisit dan di-refund aman di Fase (c) (`rollbackTransactionResources`), tanpa mengubah logika timeout (`ECONNABORTED`/502/503/504 -> tetap `Pending`).

---

### 3. Rencana 4 Commit Batch 1

- **COMMIT 1 (`fix(pricing): ...`):** `BUG-026` & `BUG-007` — tambah `{ bypassCache }` di `foxyClient.js`, pindahkan `fetchRealtimeFoxyCostForOrder` ke `foxyClient.js` dengan `bypassCache: true` & validasi fail-closed `Number.isFinite(cost) && cost >= 0`, perbarui `orderService.js` agar memanggil helper dari `foxyClient.js`.
- **COMMIT 2 (`fix(pricing): ...`):** `BUG-024` & `BUG-004` — validasi modal `products.price` di `admin/flashSales.routes.js`, filter kuota & `flashPrice < normalPrice` di `priceService.js`, `h2h.routes.js`, dan `public.routes.js`, selaraskan baseline `BRONZE` di `/api/public/flash-sales`, serta ubah seed `DUMMY-ML-86` ke `19500` di `seed_local_dummy.js`.
- **COMMIT 3 (`fix(provider): ...`):** `BUG-003` & `BUG-006` — selaraskan `FOXY_BASE_URL` & `PROVIDER_TIMEOUT_MS` di `jobs/pendingTransactions.js` & `jobs/productSync.js`, tambah guard array kosong `SEC-018` & fallback `category_type` null di `productSync.js`, serta perketat validasi respons HTTP 200 `/v1/order` (`plain object && status === true`) di `orderService.js`.
- **COMMIT 4 (`fix(provider): ...`):** Tambah `backend/tests/integration/pricingAndProviderGuards.test.js`, perbarui `docs/refactor-baseline-tests.txt`, `QA_REPORT.md`, dan `docs/qa-fix-plan.md`.

---

### 4. Status Eksekusi Batch 1

- [x] **COMMIT 1 (`dd8e9f0` — `BUG-026`, `BUG-007`):** Realtime cost bypass cache & validasi fail-closed di `foxyClient.js` (`164` baris); `orderService.js` turun ke `569` baris.
- [x] **COMMIT 2 (`a0f7fb8` — `BUG-024`, `BUG-004`):** Validasi modal flash sale di `admin/flashSales.routes.js` (`128` baris), filter kuota & `flashPrice < normalPrice` di `priceService.js` (`293` baris), `h2h.routes.js` (`183` baris), `public.routes.js` (`382` baris) + baseline `BRONZE`, serta seed `DUMMY-ML-86` = `19500`.
- [x] **COMMIT 3 (`de5d9e1` — `BUG-003`, `BUG-006`):** `FOXY_BASE_URL` & `PROVIDER_TIMEOUT_MS` dari `constants.js` di `pendingTransactions.js` (`284` baris) & `productSync.js` (`172` baris) + guard array kosong `SEC-018` & fallback `category_type` null, serta validasi respons Fase (b) `plain object && status === true` di `orderService.js` (`579` baris).
- [x] **COMMIT 4 (Tes Regresi & Dokumentasi):** Tambah `backend/tests/integration/pricingAndProviderGuards.test.js` (`6` tes baru -> `211/211` lulus), perbarui `docs/refactor-baseline-tests.txt` (`211` entri), `QA_REPORT.md`, dan `docs/qa-fix-plan.md`. Verifikasi Playwright Batch 1 (`BUG-026`, `BUG-007`, `BUG-024`, `BUG-004`, `BUG-003`, `BUG-006`) seluruhnya **`PASS`**.

---

## Batch 2A — Revokasi JWT, Email Cascade, Validasi Saldo/IP, & Compare Prices (`fix/sec-batch-2a`)

- **Branch:** `fix/sec-batch-2a` (dari `main` `@ a89f8d2`)
- **Cakupan Bug:** `BUG-008`, `BUG-011`, `BUG-005`, `BUG-009`, `BUG-015`
- **Migrasi Database:** **`migrations/013_auth_revocation_and_email_cascade.sql`** (idempoten, aditif/non-destruktif):
  1. Memperbarui FK `fk_password_resets_email` pada `password_resets(email)` agar memiliki `ON DELETE CASCADE ON UPDATE CASCADE` (`BUG-008`).
  2. Menambahkan kolom `users.token_version INTEGER NOT NULL DEFAULT 1` (`BUG-011`).

### Risiko & Desain Singkat
- **Revokasi JWT (`BUG-011`):** `protect` di `backend/middleware/auth.js` memverifikasi `users.token_version` terhadap klaim `tokenVersion` (default `1` untuk token lama sebelum migrasi 013). Jika mock unit test lama tidak mengembalikan kolom `token_version`, cek dilewati agar 211 tes eksisting tetap hijau. Login memakai `LOWER(u.email) = LOWER($2)` agar email huruf campuran lulus tanpa user enumeration.
- **Profile Email Update (`BUG-008`):** Migrasi 013 menambah `ON UPDATE CASCADE` pada `fk_password_resets_email`; `PUT /api/user/profile` tetap aman meski user memiliki baris aktif di `password_resets`.
- **Admin Balance (`BUG-005`):** Validasi `getBodyObject`, `requireString`, & `requirePositiveInt` dijalankan sebelum `pool.connect()` sehingga `"1e5"`, `0.5`, dan payload invalid langsung dibalas `HTTP 400`.
- **IP Whitelist (`BUG-009`):** `PUT /api/user/whitelisted-ips` memakai `getBodyObject` dan menolak `HTTP 400` jika ada elemen bukan string atau string kosong pada array `ips` (tidak menghapus whitelist menjadi `[]`).
- **Compare Prices (`BUG-015`):** `GET /api/public/compare-prices` memfilter `AND g.status = 'Active'` dan menghapus field internal `base_price` dari respons publik.

### Rencana & Status Eksekusi 3 Commit Batch 2A
- [x] **COMMIT 1 (`8f2f80e` — `BUG-008`, `BUG-011`):** `migrations/013_auth_revocation_and_email_cascade.sql` (`34` baris, sudah diterapkan ke DB lokal `topup_miku_local`), `migrations/README.md` (`265` baris), `backend/middleware/auth.js` (`107` baris), `backend/routes/auth.routes.js` (`268` baris), `backend/routes/user.routes.js` (`253` baris), serta penyesuaian kompatibilitas tes (`--test-force-exit` & mock `token_version`).
- [x] **COMMIT 2 (`a3ddd27` — `BUG-005`, `BUG-009`, `BUG-015`):** `backend/routes/admin/balance.routes.js` (`158` baris), `backend/routes/userApiKey.routes.js` (`188` baris), `backend/routes/public.routes.js` (`382` baris).
- [x] **COMMIT 3 (`fa5e866` — Tes Regresi & Dokumentasi):** Tambah `backend/tests/integration/securityBatch2aFixes.test.js` (`6` tes baru -> `217/217` lulus), perbarui `docs/refactor-baseline-tests.txt` (`217` entri), `QA_REPORT.md` (status `FIXED (Batch 2A)` untuk 5 bug), dan pembaruan status `docs/qa-fix-plan.md`.

---

## Batch 2B — Concurrency Deposit, Callback Retry, Audit Log, Hapus `/api/test`, & Status H2H (`fix/sec-batch-2b`)

- **Branch:** `fix/sec-batch-2b` (dari `main` `@ f009661`)
- **Cakupan Bug:** `BUG-013`, `BUG-012`, `BUG-014`, `BUG-001`, `BUG-010`
- **Migrasi Database:** Tidak ada migrasi skema baru (`001`–`013` tetap utuh).

### Pemetaan Kontrak & Risiko
- **`BUG-013` (`backend/routes/deposit.routes.js`, saat ini `290` baris):** Tambah `SELECT id FROM users WHERE id = $1 FOR UPDATE` segera setelah `BEGIN` pada `POST /api/deposit/request` sebelum menghitung jumlah deposit `Pending` (`>= 2` -> `HTTP 429`). Mengserialisasi request paralel per user tanpa mengubah respons atau mengganggu pre-check `Idempotency-Key`.
- **`BUG-012` (`backend/routes/foxyCallback.routes.js`, saat ini `313` baris):** Hapus key `trx_id` dari `callbackVerificationCooldown` pada blok `catch` saat `axios.get('/v1/status/...')` gagal (5xx/timeout) agar retry segera setelah provider pulih tidak tertahan cooldown 5 detik. Cooldown tetap aktif ketika verifikasi berhasil dijangkau.
- **`BUG-014` (`products.routes.js` `312` baris, `promos.routes.js` `123` baris, `flashSales.routes.js` `128` baris, `waBot.routes.js` `330` baris, & wiring `app.js`):** Teruskan `recordAdminAuditLog` dan catat secara fail-safe pada seluruh aksi mutasi produk (`create`, `status`, `validation`, `bulk-validation`, `sync-products`), promo (`create`, `toggle`), flash sale (`create`, `delete`), serta WA Bot (`approve`, `reject` menggunakan `client` pasca-`COMMIT` agar fail-safe sekaligus kompatibel dengan mock pool). Semua file route tetap `<= 400` baris.
- **`BUG-001` (`backend/routes/admin/games.routes.js`, saat ini `271` baris):** Hapus endpoint debug publik `POST /api/test` (`404 Not Found`).
- **`BUG-010` (`backend/routes/h2h.routes.js`, saat ini `183` baris):** Tambah dua endpoint read-only bermiddleware `protectH2HIp, protectH2H, h2hUserLimiter`:
  1. `GET /h2h/transactions` (paginasi `page`/`limit` maks `50`, filter `status` opsional ter-whitelist, `WHERE t.user_id = $1`).
  2. `GET /h2h/order/:refOrInvoiceId` (`WHERE t.user_id = $1 AND (t.invoice_id = $2 OR t.ref_id = $2)` -> `404` bila tidak ditemukan atau milik user lain).
- **Baseline Route Resmi:** Perbarui `docs/routes.baseline.txt`, `docs/layers.baseline.txt`, dan `docs/effective-chain.baseline.txt` (`87 - 1 + 2 = 88` route) via `scripts/dump-routes.js` dan verifikasi `scripts/check-route-overlap.js` (`88/88`, `overlap_conflicts=0`).

### Rencana & Status Eksekusi 3 Commit Batch 2B
- [x] **COMMIT 1 (`3100350` — `BUG-013`, `BUG-012`, `BUG-014`):** `deposit.routes.js` (`292` baris), `foxyCallback.routes.js` (`314` baris), `admin/products.routes.js` (`351` baris), `admin/promos.routes.js` (`157` baris), `admin/flashSales.routes.js` (`161` baris), `waBot.routes.js` (`351` baris), `app.js` (`110` baris).
- [x] **COMMIT 2 (`fe89718` — `BUG-001`, `BUG-010`, & Route Baseline):** `admin/games.routes.js` (`266` baris), `h2h.routes.js` (`302` baris), pembaruan `docs/routes.baseline.txt`, `docs/layers.baseline.txt`, dan `docs/effective-chain.baseline.txt` (`88/88`, `overlap_conflicts=0`).
- [x] **COMMIT 3 (Tes Regresi & Dokumentasi):** Tambah `backend/tests/integration/securityBatch2bFixes.test.js` (`5` tes baru -> `222/222` lulus), perbarui `docs/refactor-baseline-tests.txt` (`222` entri), `QA_REPORT.md` (status `FIXED (Batch 2B)` untuk 5 bug), `AUDIT_SECURITY.md`, dan `docs/qa-fix-plan.md`.

---

## Batch 3 — Perbaikan Frontend & UI/UX (`fix/ui-batch-3`)

- **Branch:** `fix/ui-batch-3` (dari `main` bersih pasca-merge Batch 2B)
- **Cakupan Bug:** `BUG-002`, `BUG-016`, `BUG-021`, `BUG-022`, `BUG-017`, `BUG-018`, `BUG-023`, `BUG-019`, `BUG-020`, `BUG-025`, serta `BUG-UI-01` & `BUG-UI-02`
- **Batas Ukuran File & Kebijakan:** Tidak ada perubahan di `backend/`. Semua JS `<= 600` baris (`frontend/script.js` dijaga `<= 595` baris), CSS `<= 800` baris (`admin.css` & `publicPages.css` dijaga `<= 780` baris), `limit_warnings=0`.

### Pemetaan Perbaikan & Target File
- **Admin Panel (`COMMIT 1`):**
  - `BUG-002` (`admin/state.js`, `admin/validationAndPrices.js`, `qa/tests/01-ui-exploratory.spec.js`): hapus role `'Admin'` dari `ADMIN_PRICE_ROLE_ORDER`, filter hanya role komersial (`bronze`, `partner`, `silver`, `gold`), dan refresh tabel produk pasca-simpan harga manual.
  - `BUG-016` (`admin/promosAndFlashSales.js`): baca `#promo-max-discount` dan kirim sebagai `rules.max_discount_amount` jika positif.
  - `BUG-021` (`admin/state.js`): cek `GET /api/user/profile` di `initAdminPage()` sebelum memuat `/api/admin/*`; redirect `401`/error ke `index.html` dan non-admin ke `dashboard.html`; tutup sidebar otomatis saat resize `> 768px`.
  - `BUG-022` (`admin.html`): ubah `maxlength="300"` pada `#reject-reason-input` menjadi `maxlength="200"`.
- **Checkout, Dashboard, & Publik (`COMMIT 2`):**
  - `BUG-017` (`product/state.js`, `product/validation.js`, `product/checkout.js`, `script.js`): hentikan override harga URL `fsPrice`, hapus `&fsPrice=` pada link flash sale, dan amankan selector `fsProductId` memakai `CSS.escape` / lookup atribut aman.
  - `BUG-018` (`product/checkout.js`, `product/state.js`): reset `appliedPromo` dan panggil `updatePrice()` pada event `input` `#promo-code-input`.
  - `BUG-023` (`product/checkout.js`): jangan toggle-off metode pembayaran bila `paymentCards.length === 1`.
  - `BUG-019` (`frontend/favicon.ico`): tambahkan file ikon binary ICO 32x32 valid (`200 OK`).
  - `BUG-020` (`dashboard.html`): ubah `step="1000"` pada `#amount` menjadi `step="1"`.
  - `BUG-025` (`css/modalsAndForms.css`, `css/publicPages.css`, `reset-password.js`): perbaiki `.password-wrapper` agar toggle mata tetap di sisi kanan dalam input, beri styling `:disabled` kontras, dan panggil `setupPasswordToggles()` sebelum guard `!token`.
- **Table Layout `1440px`, Select Caret, UX Polish & Dokumen (`COMMIT 3`):**
  - `BUG-UI-01` (`css/dashboard.css`, `css/admin.css`, `js/dashboard/{overview,transactions}.js`, `js/admin/{catalog,transactionsAndRoles}.js`): tata ulang tabel `dashboard.html` (`Mutasi Saldo`, `Transaksi Terbaru`, `Riwayat Transaksi`) dan `admin.html` (`Produk & Game`, `Deposit`, `Pembayaran`, `Transaksi`) agar terbaca utuh tanpa bertumpuk di `1440px`.
  - Select caret ganda (`css/portal.css`, `css/product.css`): hapus SVG `background-image` ganda pada `#game-selector-dropdown` dan `#server-input-container select` agar seragam menggunakan 1 panah native dark-mode (`appearance: auto` atau tanpa duplikasi arrow).
  - UX Polish `BUG-UI-01..02` (`index.html`, `script.js`, `product.html`, `js/product/{state,checkout}.js`, `js/dashboard/state.js`, `css/storefront.css`, `css/modalsAndForms.css`): empty state kategori storefront, tutup auth modal pada klik backdrop, inline login error + trim username, sembunyikan link Dashboard drawer saat logged out, judul Flash Sale 2 baris, tampilkan saldo wallet pada ringkasan checkout, dan auto-tutup drawer dashboard saat resize `> 768px`.
  - Perbarui `QA_REPORT.md` & `docs/qa-fix-plan.md`.

### Rencana & Status Eksekusi 3 Commit Batch 3
- [x] **COMMIT 1 (`6c472d3` — `BUG-002`, `BUG-016`, `BUG-021`, `BUG-022`):** `admin/state.js` (`358` baris), `admin/validationAndPrices.js` (`389` baris), `admin/promosAndFlashSales.js` (`321` baris), `admin.html` (`729` baris), `qa/tests/01-ui-exploratory.spec.js` (`344` baris), `docs/qa-fix-plan.md`.
- [x] **COMMIT 2 (`078d832` — `BUG-017`, `BUG-018`, `BUG-023`, `BUG-019`, `BUG-020`, `BUG-025`):** `product/state.js` (`314` baris), `product/validation.js` (`371` baris), `product/checkout.js` (`377` baris), `script.js` (`582` baris), `favicon.ico` (`4.286` byte), `dashboard.html` (`660` baris), `css/modalsAndForms.css` (`241` baris), `css/publicPages.css` (`744` baris), `reset-password.js` (`58` baris).
- [x] **COMMIT 3 (`BUG-UI-01..02`, Tabel `1440px`, Select Caret, & Dokumen):** `css/dashboard.css` (`391` baris), `css/admin.css` (`745` baris), `css/portal.css` (`197` baris), `css/product.css` (`628` baris), `css/storefront.css` (`448` baris), `css/modalsAndForms.css` (`253` baris), `js/dashboard/{state,overview,transactions}.js`, `js/admin/{catalog,transactionsAndRoles}.js`, `index.html`, `script.js`, `product.html`, `js/product/{state,checkout}.js`, `QA_REPORT.md`, `docs/qa-fix-plan.md`.
