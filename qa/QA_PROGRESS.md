# QA Progress Log (`topup-miku`)

- **Target:** `http://localhost:3000` (lokal)
- **Branch:** `qa/audit` (dari `main` `@ 794431e`)
- **Tanggal Mulai:** 17 November 2026

## Tahap 0 — Pre-Flight & Safety Gate: **PASS**

- [x] **Konfigurasi Environment (`backend/.env` tanpa nilai secret):**
  - `PORT=3000`, `APP_BASE_URL=http://localhost:3000`, `CORS_ORIGINS=http://localhost:3000`
  - `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_NAME=topup_miku_local`, `DB_SSL=false`
  - `FOXY_BASE_URL=http://127.0.0.1:4010` (mengarah ke mock lokal, bukan produksi)
  - `FOXY_CALLBACK_URL=http://localhost:3000/api/foxy/callback`
  - `FOXY_API_KEY`, `JWT_SECRET`, `FOXY_CALLBACK_SECRET`, `WA_BOT_ADMIN_TOKEN` seluruhnya nilai dummy/placeholder lokal.
  - `PGS_KEY`, `PGS_API_KEY`, `BREVO_API_KEY` kosong (`len=0`).
- [x] **Branch Kerja:** `qa/audit` aktif (terpisah dari `main`).
- [ ] **Snapshot DB Lokal:** Sedang disiapkan di `qa/artifacts/` (di-gitignore agar tidak ter-commit).
- [ ] **Mock Foxy (`127.0.0.1:4010`) & Server Lokal (`localhost:3000`):** Belum dinyalakan (disiapkan di Tahap 3).

## Status Tahap Berikutnya
- Tahap 1 — Project Discovery: **IN PROGRESS**
- Tahap 2 — Static Code Audit: **PENDING**
- Tahap 3 — Mock & Infrastruktur Test (`qa/`): **PENDING**
- Tahap 4–9 — Dynamic Exploratory, Top-Up, H2H, DB, Security, Resilience: **PENDING**
- Tahap 10 — Automated Regression Suite (`qa/tests/`): **PENDING**
- Tahap 11 — Laporan Akhir (`QA_REPORT.md`): **PENDING**
