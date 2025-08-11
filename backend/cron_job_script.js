const { runAllCronJobs } = require('./utils/cronUtils.js'); 

runAllCronJobs()
    .then(() => {
        console.log('Main Cron job finished successfully.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Main Cron job failed:', error);
        process.exit(1);
    });