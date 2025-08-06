require('dotenv').config(); // Untuk membaca token dari file .env
const TelegramBot = require('node-telegram-bot-api');

// Ambil token dari environment variable
const token = process.env.TELEGRAM_BOT_TOKEN;

// Cek apakah token sudah diatur
if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN tidak diatur di file .env!');
    process.exit(1); // Hentikan aplikasi jika token tidak ada
}

// Buat instance bot baru
const bot = new TelegramBot(token, { polling: true });

// Listener untuk perintah /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name;
  
  const welcomeMessage = `
Halo, ${firstName}! 👋

Selamat datang di MIKU Store Bot.
Saya siap membantu Anda untuk kebutuhan top-up.

Ketik /menu untuk melihat perintah yang tersedia.
  `;
  
  bot.sendMessage(chatId, welcomeMessage);
});

// Pesan konfirmasi di terminal bahwa bot sudah berjalan
console.log('Bot Telegram MIKU Store berjalan...');