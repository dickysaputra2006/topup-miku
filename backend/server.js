const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware dasar
app.use(cors());
app.use(express.json());

console.log('--- SERVER MINIMALIS TELAH DIMULAI ---');
console.log('Mendaftarkan rute GET /api/ping dan POST /api/test');

// Rute GET sederhana untuk memastikan server hidup
app.get('/api/ping', (req, res) => {
    console.log('SUKSES: Rute GET /api/ping berhasil diakses!');
    res.status(200).json({ message: 'Server hidup dan merespons GET!' });
});

// Rute POST sederhana yang sama seperti tes sebelumnya
app.post('/api/test', (req, res) => {
    console.log('SUKSES: Rute POST /api/test berhasil diakses!');
    res.status(200).json({ message: 'Server berhasil merespons POST!' });
});

// Middleware penanganan 404 untuk rute yang tidak ditemukan
app.use((req, res, next) => {
    console.log(`GAGAL: Rute tidak ditemukan - ${req.method} ${req.path}`);
    res.status(404).send(`Cannot ${req.method} ${req.path}`);
});

app.listen(PORT, () => {
    console.log(`Server minimalis berjalan di port ${PORT}`);
});