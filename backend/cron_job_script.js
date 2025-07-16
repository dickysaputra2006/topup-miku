
const { checkPendingTransactions } = require('./utils/cronUtils'); 

// Panggil fungsi utama
checkPendingTransactions()
    .then(() => {
        console.log('Cron job finished successfully.');
        process.exit(0); // Keluar dengan kode sukses
    })
    .catch(error => {
        console.error('Cron job failed:', error);
        process.exit(1); // Keluar dengan kode error
    });