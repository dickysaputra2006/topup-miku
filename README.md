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
