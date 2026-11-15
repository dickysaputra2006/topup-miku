# Topup Miku

Aplikasi topup reseller berbasis Express 4 + PostgreSQL + static HTML/CSS/JS frontend.

## Konfigurasi Keamanan Webhook Callback Foxy (`SEC-001`)

Endpoint `POST /api/foxy/callback` beroperasi dalam mode **fail-closed** dan **Zero-Trust**:
- Pada `NODE_ENV=production`, server **menolak start** jika `FOXY_CALLBACK_SECRET` kosong.
- Token diverifikasi menggunakan `crypto.timingSafeEqual` dari query string `?token=` (untuk Foxy yang hanya menyediakan satu kolom Webhook URL) atau header `X-Callback-Token`.
- Di lingkungan lokal/non-production saja, pengecekan secret dapat dilewati sementara dengan mengatur `ALLOW_INSECURE_CALLBACK=true` (selalu diabaikan saat `NODE_ENV=production`).
- Payload callback hanya dipakai untuk membaca `trx_id`; status akhir, serial number (`sn`), dan validasi kecocokan (`trx_id`, SKU, dan nominal modal provider) selalu diverifikasi ulang langsung ke `GET /v1/status/:trx_id` Foxy.

### 1. Cara Generate Secret Callback

Buat token acak kriptografis minimal 32 byte (64 karakter hex):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Atau menggunakan OpenSSL:

```bash
openssl rand -hex 32
```

### 2. Format URL Webhook Foxy (`?token=`)

Karena dashboard Foxy hanya menyediakan satu kolom **Webhook URL**, tempelkan token sebagai query parameter `?token=` pada URL callback, dan samakan di environment backend:

```env
FOXY_CALLBACK_SECRET=your_generated_hex_secret
FOXY_CALLBACK_URL=https://domain-anda.com/api/foxy/callback?token=your_generated_hex_secret
```

Masukkan nilai lengkap `https://domain-anda.com/api/foxy/callback?token=your_generated_hex_secret` pada pengaturan **Webhook URL** di dashboard Foxy. Jangan pernah menyimpan atau mencetak URL berisi token ke log aplikasi maupun repository.

### 3. Prosedur Rotasi Secret Tanpa Downtime

Gunakan `FOXY_CALLBACK_SECRET_PREVIOUS` saat mengganti secret aktif agar callback yang masih memakai URL lama tidak ditolak (`403`) selama masa transisi:

1. Generate secret baru (`<NEW_SECRET>`).
2. Di `.env` production, pindahkan secret lama ke `FOXY_CALLBACK_SECRET_PREVIOUS` dan pasang `<NEW_SECRET>` ke `FOXY_CALLBACK_SECRET` serta `FOXY_CALLBACK_URL`:
   ```env
   FOXY_CALLBACK_SECRET=<NEW_SECRET>
   FOXY_CALLBACK_SECRET_PREVIOUS=<OLD_SECRET>
   FOXY_CALLBACK_URL=https://domain-anda.com/api/foxy/callback?token=<NEW_SECRET>
   ```
3. Restart backend agar kedua token (`<NEW_SECRET>` dan `<OLD_SECRET>`) diterima secara bersamaan.
4. Perbarui **Webhook URL** di dashboard Foxy menjadi `https://domain-anda.com/api/foxy/callback?token=<NEW_SECRET>`.
5. Setelah memastikan seluruh callback baru sudah memakai token baru, hapus nilai `FOXY_CALLBACK_SECRET_PREVIOUS=` dari `.env` lalu restart backend kembali.

---

## Integrasi & Keamanan API Reseller H2H (`SEC-004`, `SEC-007`, `SEC-008`)

### 1. Kebijakan API Key & IP Whitelist
- **API Key Tampil Sekali:** API key baru berukuran 32 byte acak (`64` karakter hex) dan hanya ditampilkan satu kali saat dibuat (`POST /api/user/generate-apikey` atau `POST /api/user/apikey/regenerate`). Server hanya menyimpan hash SHA-256 dan 8 karakter `prefix`.
- **Cek Status & Revoke:** `GET /api/user/apikey` hanya mengembalikan `{ hasApiKey, status, prefix }`. Key dapat dicabut kapan saja melalui `DELETE /api/user/apikey` (atau dashboard Integrasi H2H).
- **Transisi Key Lama:** API key lama (48 karakter hex) tetap diterima sementara dan dimigrasi otomatis ke SHA-256 hash pada request `/h2h/*` valid pertama.
- **IP Whitelist & Rate Limit:** Semua endpoint `/h2h/*` (termasuk `/h2h/profile` dan `/h2h/profile/callback`) menegakkan IP whitelist (mendukung IP tunggal maupun CIDR IPv4/IPv6). Rate limit 60 req/menit berlaku per API key dan per `user_id` di seluruh IP sumber.
- **Webhook URL:** URL callback wajib menggunakan `https://`, tidak mengandung kredensial, tidak boleh merespons dengan redirect (`3xx`), serta harus mengarah ke IP publik (non-loopback/non-private/non-CGNAT).

### 2. Verifikasi Signature Webhook H2H (`X-Signature` & `X-Timestamp`)

Setiap pengiriman webhook status transaksi ke `h2h_callback_url` menyertakan header berikut:
- `X-Timestamp`: Unix timestamp pengiriman dalam detik (contoh: `1731670500`).
- `X-Signature`: HMAC-SHA256 heksadesimal atas string **`${X-Timestamp}.${rawBody}`** menggunakan `h2h_webhook_secret` milik reseller (`rawBody` adalah string JSON body mentah sebelum di-parse ulang).

Reseller **wajib**:
1. Memastikan selisih waktu server dengan `X-Timestamp` tidak melebihi **5 menit (300 detik)** untuk mencegah replay attack.
2. Menghitung HMAC-SHA256 atas `${X-Timestamp}.${rawBody}` (bukan hasil `JSON.stringify(req.body)` yang spasi/urutannya bisa berubah).
3. Membandingkan signature dengan perbandingan constant-time (`crypto.timingSafeEqual`).

#### Contoh Verifikasi untuk Reseller (Node.js + Express)

```js
const crypto = require('crypto');
const express = require('express');

const app = express();
const WEBHOOK_SECRET = process.env.MIKU_WEBHOOK_SECRET;
const MAX_TIMESTAMP_AGE_SECONDS = 300; // Tolak webhook lebih tua dari 5 menit

app.post(
  '/webhook/miku',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const timestampHeader = req.get('X-Timestamp');
    const signatureHeader = req.get('X-Signature');
    const rawBody = req.body.toString('utf8');

    // 1. Validasi keberadaan header & format angka timestamp
    if (!timestampHeader || !signatureHeader || !/^\d+$/.test(timestampHeader)) {
      return res.status(401).json({ message: 'Header signature/timestamp tidak valid.' });
    }

    // 2. Tolak timestamp lebih tua dari 5 menit (300 detik) atau terlalu jauh di masa depan
    const timestampSec = Number(timestampHeader);
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestampSec) > MAX_TIMESTAMP_AGE_SECONDS) {
      return res.status(401).json({ message: 'Timestamp webhook kedaluwarsa (> 5 menit).' });
    }

    // 3. Hitung HMAC-SHA256 atas `${timestamp}.${rawBody}`
    const expectedSig = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(`${timestampHeader}.${rawBody}`)
      .digest('hex');

    // 4. Bandingkan secara constant-time (pastikan panjang hex valid sebelum timingSafeEqual)
    const sigBuf = Buffer.from(signatureHeader.toLowerCase(), 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return res.status(403).json({ message: 'Signature webhook tidak cocok.' });
    }

    const payload = JSON.parse(rawBody);
    // Proses update status transaksi berdasarkan payload.invoice_id & payload.status
    console.log('Webhook valid diterima:', payload.invoice_id, payload.status);
    return res.status(200).json({ ok: true });
  }
);
```
