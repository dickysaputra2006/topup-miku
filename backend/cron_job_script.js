// Membutuhkan dotenv untuk membaca CRON_SECRET
require('dotenv').config(); 
const { runAllCronJobs } = require('./utils/cronUtils.js'); 
const axios = require('axios'); // Kita butuh axios untuk memanggil API

const CRON_SECRET = process.env.CRON_SECRET;
const NOTIFY_URL = 'http://localhost:3000/api/internal/notify-admin';

// Fungsi baru untuk mengirim notifikasi via API
async function notifyAdmin(message) {
    try {
        await axios.post(NOTIFY_URL, {
            message: message,
            secret: CRON_SECRET
        });
    } catch (error) {
        console.error('Gagal mengirim notifikasi via API:', error.message);
    }
}

// Jalankan fungsi utama
runAllCronJobs()
    .then(() => {
        console.log('Main Cron job finished successfully.');
        // Kirim notifikasi sukses via API
        notifyAdmin('✅ Cron job (Cek Transaksi & Sinkronisasi Produk) berhasil dijalankan.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Main Cron job failed:', error);
        const errorMessage = `🚨 **Cron Job GAGAL!** 🚨\n\n**Error:**\n\`\`\`\n${error.message}\n\`\`\``;
        // Kirim notifikasi error via API
        notifyAdmin(errorMessage);
        process.exit(1);
    });