require('dotenv').config(); // Pastikan dotenv dipanggil di sini
const { runAllCronJobs } = require('./utils/cronUtils.js'); 
const axios = require('axios'); // Kita butuh axios untuk mengirim notifikasi

// --- FUNGSI NOTIFIKASI MANDIRI ---
async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;

    if (!token || !adminId) {
        console.error("Token bot atau ID admin tidak ditemukan di .env untuk notifikasi.");
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
        chat_id: adminId,
        text: message,
        parse_mode: 'Markdown'
    };

    try {
        await axios.post(url, payload);
        console.log('Notifikasi berhasil dikirim ke admin.');
    } catch (error) {
        console.error('Gagal mengirim notifikasi Telegram:', error.response ? error.response.data : error.message);
    }
}
// --- AKHIR FUNGSI NOTIFIKASI ---


// Jalankan fungsi utama dan kirim notifikasi berdasarkan hasilnya
runAllCronJobs()
    .then(() => {
        console.log('Main Cron job finished successfully.');
        // Jika berhasil, kirim notifikasi sukses
        sendTelegramNotification('✅ Semua cron job (Cek Transaksi & Sinkronisasi Produk) berhasil dijalankan tanpa error.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Main Cron job failed:', error);
        // Buat pesan error yang detail
        const errorMessage = `🚨 **Cron Job GAGAL!** 🚨\n\nSebuah tugas otomatis di server gagal dijalankan.\n\n**Detail Error:**\n\`\`\`\n${error.message}\n\`\`\``;
        // Jika gagal, kirim notifikasi error
        sendTelegramNotification(errorMessage);
        process.exit(1);
    });