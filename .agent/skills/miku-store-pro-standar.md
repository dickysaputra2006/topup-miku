---
name: miku-store-pro-standard
description: Standar profesional untuk web top up game + H2H (MIKU Store). Gunakan setiap kali mengubah atau membuat UI/UX, halaman storefront, dashboard member, admin panel, alur pembayaran/deposit, integrasi provider (Foxy), API H2H, atau apapun yang menyentuh saldo, harga, dan data user. Wajib dibaca sebelum menulis kode.
---

# MIKU Store: Standar Profesional (UI, UX, Security, Simplicity)

Skill ini adalah aturan kerja untuk agent (Hydrogen, Argon, Orchestrator) yang mengerjakan proyek top up game dan H2H reseller. Ikuti urutan prioritas ini jika ada konflik:

1. **Security & integritas uang** (saldo, harga, transaksi)
2. **Kejelasan UX** (user tahu apa yang terjadi, tidak bisa salah bayar)
3. **Simplicity** (lebih sedikit kode, lebih sedikit elemen)
4. **Estetika** (rapi dan konsisten, bukan dekoratif)

Jangan pernah mengorbankan nomor 1 demi nomor 4.

---

## 0. Cara Kerja Agent

### Orchestrator
- Pecah tugas per area: `storefront`, `member`, `admin`, `api-h2h`, `payment`, `design-system`.
- Sebelum delegasi, tulis **definisi selesai** (acceptance criteria) yang bisa dicek.
- Tugas yang menyentuh uang/saldo/auth **wajib** melewati checklist Security (bagian 5) sebelum dianggap selesai.
- Satu agent satu area. Jangan biarkan dua agent mengedit file yang sama.
- Setelah semua selesai, jalankan checklist akhir (bagian 9).

### Hydrogen / Argon (implementer)
- Baca file yang ada dulu, **ikuti pola yang sudah ada**. Jangan menulis ulang seluruh file jika hanya perlu mengubah satu bagian.
- Ubah sekecil mungkin. Satu commit = satu tujuan.
- Jangan menambah library baru tanpa alasan tertulis. Cek dulu apakah bisa dengan HTML/CSS/JS bawaan atau library yang sudah terpasang.
- Jangan pernah menulis secret, API key, token, atau password di kode. Pakai environment variable.
- Jika tidak yakin, tanya. Jangan mengarang endpoint, SKU, atau struktur database.

---

## 1. Design System (satu sumber kebenaran)

Semua warna, spacing, radius, font didefinisikan **sekali** sebagai CSS variable di satu file (`tokens.css` atau `:root`). Dilarang hardcode hex/px di komponen.

### 1.1 Palet warna: hentikan "AI slop"

Ciri tampilan AI generik yang **harus dihindari**:
- Gradient biru-cyan di mana-mana (tombol, kartu, background, teks).
- Glow/blur radial di sudut kartu.
- Semua kartu memakai border tipis berpendar + radius besar + background semi-transparan.
- Ikon dekoratif besar tanpa fungsi (lingkaran putus-putus + ikon gamepad di hero).
- Semua heading tebal dan sangat besar, semua label KAPITAL dengan letter-spacing.
- Placeholder gradient dengan nama game sebagai teks (bukan gambar asli).

Aturan pengganti:
- **Satu warna aksen** saja (pilih satu, misal cyan `#22B8CF` atau biru `#3B82F6`, tidak keduanya). Dipakai untuk: tombol primer, link, fokus, item nav aktif.
- **Netral** untuk 90% permukaan. Skala abu-abu 6 tingkat saja:
  ```css
  :root {
    --bg:        #0B0F17;  /* halaman */
    --surface:   #121826;  /* kartu */
    --surface-2: #1A2233;  /* input, hover */
    --border:    #263043;
    --text:      #E6EAF2;
    --text-muted:#8B95A7;

    --accent:    #22B8CF;  /* satu-satunya aksen */
    --accent-fg: #06222A;  /* teks di atas aksen */

    --success:#22C55E; --warning:#F59E0B; --danger:#EF4444; --info:#60A5FA;
  }
  ```
- **Tanpa gradient** pada tombol dan kartu. Gradient hanya boleh di satu tempat (misal banner promo), dan subtil.
- Warna status (success/warning/danger) hanya untuk **status**, bukan dekorasi. Pada kartu statistik: angka dan ikon kecil berwarna, background kartu tetap netral (bukan seluruh kartu diwarnai).
- Kontras teks minimal WCAG AA (4.5:1). Cek `--text-muted` di atas `--surface`.
- Sediakan tema terang jika memungkinkan; minimal pastikan semua warna lewat variable agar mudah ditambah.

### 1.2 Tipografi
- Satu keluarga font (Inter atau system-ui). Maksimal 2 bobot (400 dan 600).
- Skala: 12, 14, 16, 20, 24, 32 px. Tidak ada ukuran di luar skala.
- Body 14-16px. **Heading halaman 24px**, bukan 40px. Hero maksimal 32-36px.
- Label dan eyebrow: huruf kecil/sentence case, 12px, warna muted. Hindari ALL CAPS kecuali singkatan.
- Angka uang pakai `font-variant-numeric: tabular-nums` agar sejajar.

### 1.3 Spacing, radius, shadow
- Spacing kelipatan 4: `4, 8, 12, 16, 24, 32, 48`.
- Radius: `6px` (input, tombol), `10px` (kartu). Tidak ada radius 20px+ kecuali avatar/pill.
- Shadow: nyaris tidak ada. Pakai border 1px + perbedaan warna surface untuk kedalaman.
- Efek hover: perubahan warna/border 150ms. Tanpa scale, tanpa glow, tanpa animasi berulang.

### 1.4 Komponen inti (buat sekali, pakai ulang)
`Button` (primary, secondary, ghost, danger), `Input`, `Select`, `Card`, `Badge`, `Table`, `Modal`, `Toast`, `EmptyState`, `Skeleton`, `Pagination`.
Tidak boleh ada dua gaya tombol berbeda untuk fungsi yang sama.

### 1.5 Ikon
- Satu set ikon (Lucide atau Heroicons), stroke konsisten.
- **Tidak mencampur emoji dan ikon vektor.**
- Ikon selalu disertai label kecuali tombol ikon yang punya `aria-label` dan tooltip.

---

## 2. Layout & Elemen Sticky

Masalah yang terlihat saat ini: navbar, sidebar, dan area aksi tidak konsisten menempel saat scroll. Terapkan:

| Elemen | Perilaku |
|---|---|
| Navbar storefront | `position: sticky; top: 0; z-index: 50` dengan background solid (bukan transparan penuh) dan border bawah |
| Sidebar member & admin | `position: sticky; top: <tinggi-navbar>; height: calc(100vh - <tinggi-navbar>); overflow-y: auto` |
| Header tabel admin | `thead th { position: sticky; top: <tinggi-navbar> }` |
| Ringkasan pesanan (halaman produk) | Desktop: kolom kanan sticky. Mobile: bar bawah sticky berisi total harga + tombol "Bayar" |
| Tombol simpan di form panjang admin | Footer sticky di bawah form: "Simpan" dan "Batal" |
| Filter/tab kategori | Sticky di bawah navbar saat daftar game panjang |

Aturan z-index (jangan sembarang angka): `navbar 50`, `dropdown 60`, `modal 70`, `toast 80`.

### Grid dan lebar
- Container maksimal `1200px`, padding horizontal `16px` mobile, `24px` desktop. **Samakan lebar container di navbar, konten, dan footer** (saat ini navbar dan konten terlihat tidak sejajar).
- Grid game: `repeat(auto-fill, minmax(150px, 1fr))`. Jangan biarkan kartu menumpuk di kiri dengan ruang kosong besar.
- Flash Sale: baris horizontal scroll (`overflow-x: auto; scroll-snap-type: x`) dengan kartu lebar tetap, **dan disembunyikan total jika tidak ada item aktif**. Tampilkan hitung mundur yang nyata.
- Mobile-first. Uji di 360px, 768px, 1280px. Tidak boleh ada scroll horizontal pada halaman.

---

## 3. UX: Alur Utama

### 3.1 Storefront
- Halaman utama = **cari dan pilih game secepat mungkin**. Hero maksimal 1 baris judul + 1 baris deskripsi + search. Hapus elemen dekoratif yang tidak membantu keputusan.
- Kartu game memakai **gambar/ikon resmi** (upload atau URL tervalidasi), rasio tetap (1:1 atau 3:4), `loading="lazy"`, dengan fallback inisial jika gambar gagal.
- Kategori sebagai tab/chip: Populer, Mobile Game, PC, Voucher, Pulsa, dll.
- Pencarian: debounce 250ms, hasil instan, tombol `/` untuk fokus.

### 3.2 Halaman produk (alur 4 langkah, satu halaman)
1. **Masukkan ID** (User ID + Zone ID jika perlu). Validasi inline dan tampilkan **nickname hasil cek ID** sebelum bayar.
2. **Pilih nominal**: grid kartu, tampilkan harga akhir, harga coret hanya jika benar-benar promo.
3. **Pilih metode pembayaran**: tampilkan biaya admin jika ada.
4. **Konfirmasi**: ringkasan (game, ID, nickname, item, total) lalu tombol "Bayar".

Aturan:
- Tombol "Bayar" nonaktif sampai semua langkah valid, dengan alasan jelas ("Pilih nominal dulu").
- Cegah dobel klik: disable tombol + spinner saat proses.
- Tampilkan **harga final** sejak awal. Tidak ada biaya kejutan di akhir.
- Setelah bayar: halaman status dengan nomor invoice, status, instruksi, tombol salin, dan auto-refresh/polling status.

### 3.3 Dashboard member
- Hierarki: **Saldo** (paling menonjol) → aksi utama (Top Up Saldo) → transaksi terbaru → statistik.
- Kartu statistik ringkas (angka 24px, label 12px). Hapus teks status raksasa seperti "BERHASIL/PENDING" di ukuran judul.
- Duplikasi dihapus: tombol "Top Up Saldo" jangan muncul 3 kali di satu layar; "Cek Pesanan/Mutasi/API H2H" jangan ada di sidebar **dan** kartu akses cepat sekaligus. Pilih satu.
- Kondisi kosong yang berguna: "Belum ada transaksi. Mulai top up pertamamu" + tombol, bukan angka 0 saja.
- Info sensitif (email, WhatsApp) tampil sebagian (`m***@gmail.com`, `+62 8**-***-7964`) dengan tombol "tampilkan".

### 3.4 Admin panel
- Admin panel = alat kerja, bukan etalase. **Padat, cepat, jelas.**
- Sidebar: label tidak boleh terpotong ("Manajemen Flash S..." → "Flash Sale"). Pakai nama pendek, tambahkan badge jumlah untuk "Persetujuan Deposit" yang menunggu.
- Halaman "Produk & Game": jangan menaruh dua form panjang berdampingan di atas daftar. Susun: **tabel daftar dulu**, tombol "Tambah Game" / "Tambah Produk" membuka modal atau drawer.
- Tabel: pencarian, filter, sort, pagination, aksi per baris (edit/nonaktifkan), toggle aktif/nonaktif langsung.
- **Sinkronisasi produk (margin %)**: tampilkan pratinjau perubahan ("128 produk akan diperbarui, harga rata-rata naik 10%") dan **modal konfirmasi** sebelum eksekusi. Tampilkan hasil dan log terakhir sinkronisasi.
- Operasi destruktif (hapus, nonaktifkan massal) = konfirmasi eksplisit; sebisa mungkin soft-delete dan bisa dibatalkan.
- Persetujuan deposit: tampilkan bukti, nominal, pengirim, waktu, dan riwayat; tombol Setujui/Tolak dengan alasan wajib untuk penolakan.

### 3.5 Umpan balik sistem
- Setiap aksi punya 4 keadaan: **idle, loading, sukses, error**. Gunakan skeleton untuk data, toast untuk hasil aksi, pesan inline untuk validasi.
- Pesan error dalam bahasa manusia dan memberi langkah: "Saldo tidak cukup. Kurang Rp 12.500. [Isi saldo]". Jangan tampilkan stack trace atau pesan provider mentah.
- Teks antarmuka: Bahasa Indonesia, nada konsisten (pakai "kamu" atau "Anda" saja, jangan campur). Format uang `Rp 17.500` via `Intl.NumberFormat('id-ID')`, tanggal zona waktu WIB dan jelas.

### 3.4 Aksesibilitas (wajib)
- Semua kontrol bisa dioperasikan keyboard; fokus terlihat (`outline` 2px aksen).
- `label` terhubung ke input, `aria-label` pada tombol ikon, `alt` pada gambar.
- Target sentuh minimal 44x44px di mobile.
- Hormati `prefers-reduced-motion`.

---

## 4. Simplicity

- **Hapus sebelum menambah.** Setiap elemen UI harus menjawab: "Apa yang user lakukan dengannya?" Jika tidak ada jawaban, hapus.
- Satu halaman = satu tujuan utama, satu tombol primer.
- Maksimal 7 item di navigasi utama. Navbar storefront saat ini terlalu penuh: gabungkan "Validasi ID", "Pricelist", "Cek Transaksi", "Leaderboard" ke menu "Lainnya" atau footer; sisakan Cari, Cek Pesanan, dan Akun.
- Hindari pengaturan tersembunyi dan opsi yang jarang dipakai. Default yang masuk akal lebih baik daripada konfigurasi.
- Kode: fungsi pendek (<40 baris), nama jelas, tanpa duplikasi, tanpa kode mati, tanpa `console.log` tersisa, tanpa komentar yang hanya mengulang kode.
- Struktur folder per fitur, bukan per jenis file, jika framework mengizinkan.
- Jangan membuat abstraksi untuk satu pemakaian.

---

## 5. Security (WAJIB, tidak boleh dilewati)

Proyek ini mengelola **uang dan saldo**. Perlakukan setiap input sebagai tidak tepercaya.

### 5.1 Integritas harga dan saldo
- **Harga dihitung di server** dari database. Jangan pernah menerima harga, margin, atau total dari klien.
- Pembayaran dengan saldo, deposit, dan refund dijalankan dalam **transaksi database atomik** dengan row lock (`SELECT ... FOR UPDATE`) atau operasi `UPDATE ... SET saldo = saldo - ? WHERE saldo >= ?` agar tidak terjadi race condition/double spend.
- Simpan uang sebagai **integer (rupiah)** atau `DECIMAL`, bukan float.
- Semua perubahan saldo tercatat di tabel **ledger append-only** (mutasi): `id, user_id, tipe, jumlah, saldo_sebelum, saldo_sesudah, ref, waktu`. Saldo = hasil yang bisa direkonsiliasi dari ledger.
- **Idempotency**: order dan deposit punya `idempotency_key`/`invoice_id` unik. Request ulang tidak boleh membuat transaksi ganda. Callback yang diterima dua kali tidak boleh memproses dua kali.
- Mesin status transaksi eksplisit: `pending → processing → success | failed | refunded`. Transisi ilegal ditolak. Refund otomatis idempoten ketika provider gagal.

### 5.2 Autentikasi dan sesi
- Hash password dengan **Argon2id** atau bcrypt (cost ≥ 12). Tidak ada MD5/SHA1/plain.
- Cookie sesi: `HttpOnly; Secure; SameSite=Lax` (atau `Strict`). Regenerasi session ID setelah login. Timeout idle dan absolut.
- Rate limit dan penguncian sementara pada login, register, lupa password, cek ID, dan pembuatan order (per IP **dan** per akun).
- Pesan error login generik ("Email atau password salah"), tidak membocorkan apakah email terdaftar.
- Reset password: token acak, hash di DB, sekali pakai, kedaluwarsa ≤ 30 menit.
- **Admin wajib 2FA (TOTP)**. Pertimbangkan pemisahan path/subdomain admin dan allowlist IP.

### 5.3 Otorisasi
- Cek peran dan kepemilikan **di server pada setiap endpoint**. Menyembunyikan menu di UI bukan keamanan.
- Hindari IDOR: setiap query data user menyertakan `WHERE user_id = <user sesi>`. Jangan percaya `user_id` dari body/query.
- Prinsip hak akses minimum: `member`, `reseller`, `admin` dipisah jelas. Endpoint admin pakai middleware khusus, deny by default.
- Aksi admin sensitif (ubah margin, setujui deposit, ubah saldo manual) dicatat ke **audit log** (siapa, kapan, sebelum/sesudah, IP).

### 5.4 Input, output, dan serangan web
- Validasi di server dengan skema (Zod/Joi/Pydantic/dll): tipe, panjang, rentang, whitelist nilai.
- **Query berparameter / ORM** saja. Tidak ada string concatenation SQL.
- Escape output untuk mencegah XSS. Jangan memakai `innerHTML`/`v-html`/`dangerouslySetInnerHTML` untuk data user atau nama produk dari provider.
- **CSRF**: token atau `SameSite` + cek `Origin` untuk semua request yang mengubah state.
- Header keamanan: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Strict-Transport-Security`, `frame-ancestors 'none'` (anti-clickjacking).
- **URL Gambar** (admin): validasi skema `https`, batasi domain atau lebih baik **upload dan proses ulang** (cek MIME asli, batas ukuran, hapus metadata). Jangan melakukan fetch URL dari server tanpa perlindungan **SSRF** (blok IP privat/localhost/metadata cloud).
- Upload bukti deposit: whitelist ekstensi + cek magic bytes, batas ukuran, simpan di luar web root dengan nama acak.
- CORS: whitelist origin spesifik, bukan `*`.

### 5.5 Integrasi provider (Foxy) dan webhook
- API key provider hanya di environment/secret manager, **tidak pernah dikirim ke frontend** dan tidak muncul di log.
- Semua panggilan ke provider dilakukan dari server, dengan timeout, retry terbatas (backoff), dan penanganan respons tak terduga.
- **Verifikasi tanda tangan** setiap webhook/callback (HMAC) dan cocokkan nominal serta invoice dengan data di DB. Jangan percaya status dari body callback begitu saja; verifikasi ulang via API provider bila perlu. Pertimbangkan allowlist IP provider.
- Jika respons provider ambigu (timeout), status = `pending/review`, **bukan** langsung gagal/refund. Cek status ulang sebelum memutuskan.
- Pantau saldo provider; beri peringatan admin saat menipis, dan matikan produk otomatis bila provider tidak bisa melayani.

### 5.6 API H2H untuk reseller
- API key: dibuat acak (≥ 32 byte), **hanya ditampilkan sekali**, disimpan sebagai hash. Bisa di-rotate dan dicabut. Beri nama dan scope per key.
- Autentikasi via header (`Authorization: Bearer`/`X-API-Key`), bukan query string.
- **Allowlist IP** per key (opsional tapi disarankan), rate limit per key, dan batas nominal harian.
- Wajib `ref_id` unik dari klien (idempotency). Dokumentasikan kode error dan respons konsisten.
- Callback ke reseller: tanda tangan HMAC, retry dengan backoff, log pengiriman.
- Dokumentasi API publik (OpenAPI) + versi (`/v1`).

### 5.7 Data, secret, dan infrastruktur
- Tidak ada secret di repo atau frontend bundle. `.env` di `.gitignore`, sediakan `.env.example` tanpa nilai nyata. Jika secret pernah ter-commit, **rotate**.
- Enkripsi koneksi (HTTPS di mana-mana, DB tidak terbuka ke publik).
- Minimalkan data pribadi (UU PDP): kumpulkan seperlunya, masking di UI dan log, kebijakan retensi, halaman Kebijakan Privasi dan Syarat & Ketentuan.
- Log terstruktur tanpa data sensitif (password, token, API key, nomor lengkap). Log kejadian keamanan (login gagal, perubahan hak akses).
- Backup database terjadwal dan **pernah diuji restore**.
- `npm audit`/`pip audit` berkala; kunci versi dependensi (lockfile); hapus dependensi tak terpakai.
- Pesan error produksi generik; detail hanya di log server.
- Pasang proteksi bot (Turnstile/hCaptcha) di register, login, dan cek transaksi publik.

### 5.8 Anti-fraud sederhana
- Batas order per IP/akun/menit; deteksi pola (banyak ID berbeda dari satu akun, banyak gagal bayar).
- Status `review` (sudah ada) harus punya antrean admin dengan alasan dan SLA.
- Notifikasi admin untuk transaksi bernilai tinggi atau saldo provider rendah.

---

## 6. Performa dan Keandalan

- Target: LCP < 2,5s di 4G. Gambar WebP/AVIF, ukuran sesuai tampilan, `width/height` eksplisit (hindari layout shift).
- Cache daftar game/produk (server dan CDN) dengan invalidasi saat admin mengubah data.
- Paginasi server-side untuk semua daftar panjang (transaksi, mutasi, produk).
- Indeks database pada kolom pencarian: `invoice_id`, `user_id`, `status`, `created_at`, `sku`.
- Pekerjaan lambat (sinkronisasi produk, callback, retry) dijalankan di **queue/background job**, bukan di request pengguna.
- Halaman error 404/500/offline yang rapi. Tampilan tetap berfungsi saat JS gagal memuat bagian non-kritis.

---

## 7. Kepercayaan dan Kelengkapan (standar toko online profesional)

- Footer: tautan Syarat & Ketentuan, Kebijakan Privasi, Kebijakan Refund, Kontak/WhatsApp CS, jam operasional.
- Halaman "Cek Transaksi" bisa diakses dengan nomor invoice (+ verifikasi tambahan agar data tidak bocor).
- Bukti sosial yang nyata saja (jumlah transaksi, ulasan asli). Tidak ada klaim palsu seperti "tercepat" tanpa dasar.
- Notifikasi status (WhatsApp/email) dengan templat jelas.
- SEO dasar: `<title>` dan meta per halaman, URL bersih (`/mobile-legends`), `sitemap.xml`, `robots.txt` (blok `/admin`, `/member`).
- Favicon, Open Graph, bahasa `lang="id"`, `viewport` benar.

---

## 8. Kualitas Kode dan Proses

- Linter + formatter (ESLint/Prettier atau setara) wajib lolos.
- Tes untuk **jalur uang**: perhitungan harga/margin, pemotongan saldo, idempotency, callback ganda, refund. Minimal unit test + satu tes integrasi alur order.
- Migrasi database berversi; tidak ada perubahan skema manual di produksi.
- Environment terpisah: development, staging, production. Provider sandbox untuk testing.
- Commit kecil dengan pesan jelas. PR berisi: apa, kenapa, cara uji, tangkapan layar sebelum/sesudah untuk perubahan UI.
- Dokumentasi singkat di README: cara menjalankan, variabel env, struktur proyek, alur transaksi.

---

## 9. Checklist Sebelum Selesai

Agent menandai semua poin sebelum menyatakan tugas selesai. Jika ada yang tidak berlaku, tulis alasannya.

**UI**
- [ ] Semua warna/spacing/radius memakai token, tanpa hardcode
- [ ] Hanya satu warna aksen; tidak ada gradient/glow dekoratif
- [ ] Navbar, sidebar, header tabel, dan bar aksi mobile sudah sticky sesuai tabel bagian 2
- [ ] Container sejajar di navbar, konten, footer
- [ ] Label tidak terpotong; tidak ada scroll horizontal di 360px
- [ ] Gambar game nyata dengan fallback, lazy load, rasio tetap

**UX**
- [ ] Alur order 4 langkah dengan validasi ID dan nickname
- [ ] Tombol bayar nonaktif sampai valid, tahan dobel klik
- [ ] State loading/kosong/error ada di setiap daftar dan aksi
- [ ] Aksi destruktif/sinkronisasi massal memakai konfirmasi
- [ ] Teks Indonesia konsisten; format Rp dan tanggal benar
- [ ] Keyboard, fokus terlihat, label/aria lengkap

**Security**
- [ ] Harga dan total dihitung server; saldo diubah secara atomik + ledger
- [ ] Idempotency pada order, deposit, callback
- [ ] Otorisasi server-side di setiap endpoint; tidak ada IDOR
- [ ] Validasi input (skema), query berparameter, output ter-escape
- [ ] CSRF, header keamanan, CORS ketat, rate limit
- [ ] Webhook diverifikasi (HMAC) dan nominal dicocokkan
- [ ] API key provider/reseller tidak bocor ke klien/log; key reseller di-hash
- [ ] Admin: 2FA + audit log
- [ ] Tidak ada secret di repo; `.env.example` tersedia
- [ ] Upload dan URL gambar divalidasi (SSRF/MIME)

**Simplicity & Kualitas**
- [ ] Tidak ada elemen/kode/dependensi yang tidak dipakai
- [ ] Linter dan tes jalur uang lolos
- [ ] README dan catatan perubahan diperbarui

---

## 10. Larangan Mutlak

- Menerima harga/saldo/role dari klien.
- Menyimpan atau menampilkan API key, token, atau password dalam bentuk asli.
- Mengubah saldo tanpa transaksi atomik dan catatan ledger.
- Memproses callback tanpa verifikasi tanda tangan.
- Menambahkan gradient, glow, animasi berlebihan, atau warna aksen baru tanpa persetujuan.
- Menulis ulang seluruh halaman/arsitektur ketika hanya diminta perubahan kecil.
- Mengarang data (ulasan, jumlah transaksi, testimoni) untuk tampilan.
- Mengklaim "selesai" tanpa menjalankan checklist bagian 9.
