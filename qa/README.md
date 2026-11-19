# Topup Miku — Suite QA & Automated Audit (`qa/`)

Suite audit dan regresi otomatis terisolasi untuk `http://localhost:3000` (tanpa mengubah kode sumber aplikasi di `backend/` maupun `frontend/`).

---

## Prasyarat & Keamanan Lokal

1. Pastikan `backend/.env` mengarah ke environment lokal/mock:
   - `DB_HOST=127.0.0.1`, `DB_NAME=topup_miku_local`, `DB_SSL=false`
   - `FOXY_BASE_URL=http://127.0.0.1:4010`
   - `FOXY_CALLBACK_URL=http://localhost:3000/api/foxy/callback`
   - `FOXY_API_KEY` bernilai dummy lokal (`PGS_KEY`/`PGS_API_KEY`/`BREVO_API_KEY` kosong)
2. Pastikan PostgreSQL lokal sudah termigrasi (`001`–`012`) dan terisi data QA:
   ```powershell
   cd backend
   npm.cmd run seed
   ```

---

## Menjalankan Mock & Server Lokal

1. **Terminal 1 — Mock Provider Foxy (`127.0.0.1:4010`):**
   ```powershell
   cd qa
   npm.cmd run mock:foxy
   ```
   Kontrol mode mock tersedia di `POST http://127.0.0.1:4010/__mock/mode` (`orderBehavior`, `defaultStatus`, `statusBehavior`, `priceOverrides`, `autoCallbackDelayMs`) dan reset di `POST /__mock/reset`.

2. **Terminal 2 — Backend & Frontend Lokal (`localhost:3000`):**
   ```powershell
   cd backend
   npm.cmd start
   ```

3. **Simulasi Callback Foxy Manual (opsional):**
   ```powershell
   cd qa
   node mocks/callbackSender.js <provider_trx_id> --status=SUCCESS
   ```

---

## Menjalankan Semua Automated Test (Satu Perintah)

Pastikan mock (`127.0.0.1:4010`) dan server (`localhost:3000`) sudah berjalan, lalu jalankan dari folder `qa/`:

```powershell
cd qa
npm.cmd test
```

- Menggunakan Microsoft Edge lokal (`channel: 'msedge'`).
- Tes berawalan **`PASS:`** menguji alur inti yang diharapkan tetap lulus.
- Tes bertag **`@bug-BUG-XXX`** menguji perilaku yang *seharusnya* benar terhadap bug terbukti; saat ini sengaja gagal (*expected-to-fail*) sebagai bukti regresi, dan akan berubah menjadi hijau setelah bug diperbaiki.
- Laporan HTML/JSON & trace/screenshot kegagalan otomatis tersimpan di:
  - `qa/artifacts/playwright-report/index.html`
  - `qa/artifacts/playwright-results.json`
  - `qa/test-results/`

---

## Restore Snapshot DB Pre-Audit

Backup awal PostgreSQL lokal sebelum pengujian disimpan (secara lokal / tidak di-commit) di `qa/artifacts/db_pre_audit.sql`. Untuk memulihkan kondisi awal setelah audit:

```powershell
# Drop & recreate DB lokal lalu restore (atau gunakan clean seed sesuai kebutuhan)
psql -h 127.0.0.1 -U <DB_USER> -d topup_miku_local -f qa/artifacts/db_pre_audit.sql
```
