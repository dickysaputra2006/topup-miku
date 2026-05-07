# NEXT_PHASE_ROADMAP.md — topup-miku

> **Tanggal Audit:** 2026-05-07  
> **Status Production:** ✅ Live di `https://mikutopup.my.id`  
> **Test Order:** ✅ `TRX-17781619937353` berhasil  
> **Backend Tests:** ✅ 12/12 pass | **Syntax Check:** ✅ All pass

---

## 1. Ringkasan Kondisi Production

| Item | Status |
|---|---|
| VPS Deploy (PM2 + Nginx + HTTPS) | ✅ |
| PostgreSQL SumoBase (DB_SSL=false) | ✅ |
| Foxy API dari VPS | ✅ |
| Cron: pending check (5 min) + product sync (4 jam) | ✅ |
| Admin user + Real test order + callback | ✅ |
| CORS root/www + Lock file cleanup | ✅ |

**DB:** 15 tabel, 21 index, 4 unique constraint.  
**Frontend:** 11 HTML, 2 CSS, 7 JS. **Backend:** server.js (2469 baris).

---

## 2. Audit UI/UX — Masalah Ditemukan

### 2.1 Product Page (`product.html`)
- **HIGH:** Di PC, `order-page-wrapper` max-width 920px → terlalu sempit, banyak whitespace.
- **HIGH:** Di HP, product card bisa keluar garis jika nama produk panjang.
- **MEDIUM:** Tidak ada sticky "Buy Now" bar di mobile.

### 2.2 Compare Prices (`compare-prices.html`)
- **HIGH:** Nama produk panjang membuat cell tabel memanjang vertikal, scrollbar horizontal tenggelam.
- **HIGH:** Scrollbar horizontal di mobile tidak terlihat saat banyak role.
- **MEDIUM:** Kolom "Nama Game" redundan (sudah dipilih via dropdown).

### 2.3 Admin Panel (`admin.html`)
- **HIGH:** Tidak ada pagination/search untuk list produk besar (800+ produk).
- **MEDIUM:** Tidak ada tombol reject deposit (hanya approve).
- **LOW:** Sidebar duplikat `id="menu-toggle-btn"`.

### 2.4 Dashboard (`dashboard.html`)
- **HIGH:** Deposit tab instruksi payment hardcoded placeholder ("Bank ABC 123-456-7890").
- **MEDIUM:** Tidak ada riwayat deposit user.

### 2.5 Homepage (`index.html`)
- **MEDIUM:** Hero banner gambar Pexels placeholder, bukan branding MIKU.
- **MEDIUM:** Flash sale card tidak ada countdown timer.
- **LOW:** Footer copyright "2025".

### 2.6 Invoice, Validate, Login/Register
- **MEDIUM:** Invoice hanya bisa diakses user login (tidak ada cek publik).
- **HIGH:** Register: nomor telepon tanpa country code picker.
- **MEDIUM:** Modal login/register di-duplikasi di 2 file HTML.

---

## 3. Audit Fitur Produk & Admin

| Fitur | Status |
|---|---|
| On/off produk & game | ✅ Ada |
| Needs Server ID per game | ✅ Ada |
| Validation config per produk + bulk | ✅ Ada |
| Manual price per produk per role | ✅ Ada |
| Margin global + per game | ✅ Ada |
| Flash sale + Promo codes | ✅ Ada |
| `target_id_label` per game | ⚠️ Kolom ada tapi tidak di admin UI |
| Pagination/search produk admin | ❌ Tidak ada |
| Reject deposit | ❌ Tidak ada |

---

## 4. Audit Validasi ID Game

**Sudah ada:**
- Admin bisa pilih validator per produk via `validation_config` JSON.
- Bulk validation: set ke semua produk game sekaligus.
- Region rules (allowed/disallowed).
- "Tidak perlu validasi" option.

**Rekomendasi:**
1. Tambah `default_validator` di tabel `games` → auto-apply ke produk baru saat sync.
2. Dropdown validator lebih jelas di admin dengan preview.

---

## 5. Audit Uniqueness Register

| Field | DB Unique | Backend | Frontend |
|---|---|---|---|
| `username` | ✅ | ✅ Catch 23505 | ❌ No pre-check |
| `email` | ✅ | ✅ Catch 23505 | ❌ No pre-check |
| `nomor_wa` | ❌ **TIDAK ADA** | ❌ | ❌ |

**KRITIS:** `nomor_wa` tidak ada unique constraint. User bisa daftar dengan nomor WA sama berkali-kali.

**Fix:** Migration `ALTER TABLE users ADD CONSTRAINT uq_users_nomor_wa UNIQUE (nomor_wa)` (cek duplikat dulu di production). Tambah frontend pre-check availability.

---

## 6. Audit Register Phone Country Code

**Saat ini:** Input text biasa, placeholder "62812...".

**Rekomendasi:** Dropdown `[+62 ▼]` + input sisa nomor. Backend normalisasi: strip leading 0, prepend code, simpan `+628xxxxx`. Validasi panjang per country.

---

## 7. Audit Deposit Manual

**Saat ini:** Instruksi hardcoded placeholder, tidak ada pilihan metode, tidak ada reject.

**Rekomendasi:**
- Tabel `payment_methods` baru (GoPay, DANA, ShopeePay, SeaBank).
- Admin CRUD metode pembayaran.
- User pilih metode → deposit pending → admin approve/reject.
- Warning: "Deposit manual diproses admin dalam 1x24 jam."
- Riwayat deposit user.

---

## 8. Audit Bot WA / Admin API

**Rekomendasi desain (belum implement):**
- Endpoint: `POST /api/bot/balance/add`, `GET /api/bot/deposits/pending`, `POST /api/bot/deposits/approve|reject`.
- Auth: `X-Admin-API-Key` header, 64-char hex dari env `ADMIN_BOT_API_KEY`.
- IP whitelist optional dari env.
- Rate limit 30 req/min.
- Audit log tabel `admin_audit_log`.
- TIDAK pakai JWT user biasa.

---

## 9. Audit Cek Transaksi Publik

**Rekomendasi:**
- `GET /api/public/check-transaction?invoice=TRX-xxxxx` — return data tersensor.
- `GET /api/public/recent-transactions?limit=10` — 10 terbaru: tanggal, game, produk, harga, invoice tersensor, status.
- **TIDAK return:** target_game_id, username, provider_sn, data sensitif.
- Halaman baru `check-transaction.html`.

---

## 10. Audit Leaderboard

**Rekomendasi:**
- Tipe: Top Spender, Top Transaction Count, Top Game, Top Product.
- Periode: Harian / Mingguan / Bulanan.
- Username disensor: `dic***ra`.
- `GET /api/public/leaderboard?type=spender&period=weekly&limit=10`.
- Cache/materialized view, TTL 15 menit.

---

## 11. Prioritas Implementasi

### 🔴 HIGH
| # | Task | Risk |
|---|---|---|
| 1 | Fix product page width desktop | None |
| 2 | Fix product card overflow mobile | None |
| 3 | Fix compare-prices scroll/truncate | None |
| 4 | Fix register `nomor_wa` unique constraint | Low (cek duplikat) |
| 5 | Country code picker register | Low |
| 6 | Fix deposit manual UI (metode + reject) | Medium (balance) |

### 🟡 MEDIUM
| # | Task | Risk |
|---|---|---|
| 7 | Admin produk pagination + search | None |
| 8 | Cek transaksi publik | Low |
| 9 | Admin bot API | Medium (security) |
| 10 | Leaderboard | Low |

### 🟢 LOW
| # | Task | Risk |
|---|---|---|
| 11 | Flash sale countdown timer | None |
| 12 | Invoice share/download | None |
| 13 | Dashboard chart | None |
| 14 | Default validator per game | Low |
| 15 | Custom hero banner | None |

---

## 12. Urutan Implementasi

1. **Phase 2A** — UI/UX Quick Fixes (CSS-only): product width, card overflow, compare scroll, fix duplicate IDs
2. **Phase 2B** — Registration: nomor_wa unique, country code picker, pre-check availability
3. **Phase 2C** — Deposit Manual: tabel payment_methods, CRUD admin, update flow, reject, riwayat
4. **Phase 2D** — Public Features: cek transaksi publik, leaderboard
5. **Phase 2E** — Bot API: middleware, endpoints, audit log

---

## 13. Jangan Dilakukan Dulu

| ❌ Jangan | Alasan |
|---|---|
| Midtrans/payment gateway | Modal terbatas |
| Refactor server.js jadi modular | Risiko regresi tinggi |
| `npm audit fix --force` | Bisa break Express 4 |
| Ganti database/hosting | Production stabil |
| SSR / Next.js migration | Overkill |

---

## 14. Schema Migration Baru (Preview)

```sql
-- 005_next_phase.sql
-- 1. nomor_wa unique (CEK DUPLIKAT DULU!)
-- ALTER TABLE users ADD CONSTRAINT uq_users_nomor_wa UNIQUE (nomor_wa);

-- 2. Payment methods
CREATE TABLE IF NOT EXISTS payment_methods (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    account_number VARCHAR(100),
    account_name VARCHAR(255),
    instructions TEXT,
    is_active BOOLEAN DEFAULT true,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Deposits upgrade
-- ALTER TABLE deposits ADD COLUMN payment_method_id INT REFERENCES payment_methods(id);
-- ALTER TABLE deposits ADD COLUMN admin_note TEXT;

-- 4. Admin audit log
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id SERIAL PRIMARY KEY,
    admin_user_id INT,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),
    target_id VARCHAR(255),
    details JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

---

## 15. Security Notes

- ❌ Jangan commit `.env`, token, API key, secret
- ❌ Jangan log API key/token di console
- ❌ Jangan expose `target_game_id` di API publik
- ❌ Jangan `npm audit fix --force` tanpa review
- ✅ Provider logging tetap pakai `safeAxiosError()`
- ✅ Bot API key di env, bukan DB
- ✅ Semua endpoint baru pakai rate limiter
- ✅ Deposit approve/reject dalam DB transaction + `FOR UPDATE`

---

## 16. Hasil Verifikasi

```
npm run check  → ✅ All syntax OK
npm test       → ✅ 12/12 pass, 0 fail
```

Tidak ada file yang diubah (read-only audit). Hanya `NEXT_PHASE_ROADMAP.md` baru.

---

*Dibuat oleh Antigravity — 2026-05-07. Siap review sebelum Phase 2A.*
