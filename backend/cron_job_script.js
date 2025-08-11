// 1. Impor fungsi utama dari cronUtils
const { runAllCronJobs } = require('./utils/cronUtils.js'); 

// 2. Impor fungsi notifikasi dari bot (dengan path yang benar)
const { sendAdminNotification } = require('./utils/botTele.js'); 

// 3. Jalankan fungsi dan tangani hasilnya
runAllCronJobs()
    .then(() => {
        console.log('Main Cron job finished successfully.');
        // Jika berhasil, kirim notifikasi sukses
        sendAdminNotification('✅ Semua cron job (Cek Transaksi & Sinkronisasi Produk) berhasil dijalankan tanpa error.');
        // Keluar dengan kode sukses
        process.exit(0); 
    })
    .catch(error => {
        console.error('Main Cron job failed:', error);
        // Buat pesan error yang detail
        const errorMessage = `🚨 **Cron Job GAGAL!** 🚨\n\nSebuah tugas otomatis di server gagal dijalankan.\n\n**Detail Error:**\n\`\`\`\n${error.message}\n\`\`\``;
        // Jika gagal, kirim notifikasi error
        sendAdminNotification(errorMessage);
        // Keluar dengan kode error
        process.exit(1); 
    });