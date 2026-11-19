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
