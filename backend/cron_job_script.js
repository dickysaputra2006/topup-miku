require('dotenv').config({ path: require('path').resolve(__dirname, './.env') });
const { runAllCronJobs } = require('./utils/cronUtils.js');
const axios = require('axios');

async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!token || !adminId) return;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        await axios.post(url, { chat_id: adminId, text: message, parse_mode: 'Markdown' });
        console.log('Notifikasi terkirim ke admin.');
    } catch (error) {
        console.error('Gagal mengirim notifikasi.');
    }
}

runAllCronJobs()
    .then(() => {
        console.log('Main Cron job finished successfully.');
        sendTelegramNotification('✅ Cron job berhasil dijalankan.');
        process.exit(0);
    })
    .catch(error => {
        console.error('Main Cron job failed:', error);
        const errorMessage = `🚨 Cron Job GAGAL!\n\n**Error:**\n\`\`\`\n${error.message}\n\`\`\``;
        sendTelegramNotification(errorMessage);
        process.exit(1);
    });