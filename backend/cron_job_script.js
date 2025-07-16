
const { runAllCronJobs } = require('./utils/cronUtils'); 

// Panggil fungsi utama
runAllCronJobs()
    .then(() => {
        console.log('Main Cron job finished successfully.');
        process.exit(0); // Keluar dengan kode sukses
    })
    .catch(error => {
        console.error('Main Cron job failed:', error);
        process.exit(1); // Keluar dengan kode error
    });