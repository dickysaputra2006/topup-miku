require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios'); // <-- BARU: Kita tambahkan axios

// Ambil token dan variabel lain dari .env
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminApiKey = process.env.ADMIN_API_KEY; // <-- BARU: API Key khusus untuk admin
const apiUrl = 'http://localhost:3000'; // <-- BARU: Alamat API backend Anda

if (!token || !adminApiKey) {
    console.error('Error: Pastikan TELEGRAM_BOT_TOKEN dan ADMIN_API_KEY sudah diatur di file .env!');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Listener untuk perintah /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name;
  
  const welcomeMessage = `
Halo, ${firstName}! 👋

Selamat datang di MIKU Store Bot.
Ini adalah bot administrasi pribadi Anda.

Perintah yang tersedia:
/ceksaldo - Untuk melihat sisa saldo H2H Anda.
  `;
  
  bot.sendMessage(chatId, welcomeMessage);
});

// --- LOGIKA BARU UNTUK CEK SALDO ---
bot.onText(/\/ceksaldo/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        // Beri tahu pengguna bahwa kita sedang memproses
        bot.sendMessage(chatId, '⏳ Sedang mengecek saldo Anda...');

        // Konfigurasi untuk request ke API H2H kita
        const config = {
            headers: {
                'x-api-key': adminApiKey // Menggunakan API Key dari .env
            }
        };

        // Lakukan request ke endpoint /h2h/profile
        const response = await axios.get(`${apiUrl}/h2h/profile`, config);

        // Jika request berhasil dan mendapat data
        if (response.data && response.data.success) {
            const userProfile = response.data.data;
            const balance = userProfile.balance;
            const formattedBalance = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(balance);

            const balanceMessage = `
✅ Saldo Anda saat ini:
**${formattedBalance}**
            `;
            
            // Kirim pesan saldo ke pengguna (gunakan parse_mode 'Markdown' jika ingin tebal)
            bot.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });

        } else {
            // Jika API merespons tapi dengan pesan error
            bot.sendMessage(chatId, `❌ Gagal mengambil saldo: ${response.data.message}`);
        }

    } catch (error) {
        // Jika terjadi error saat request (misalnya server mati atau API key salah)
        console.error('Error saat /ceksaldo:', error.message);
        bot.sendMessage(chatId, '❌ Terjadi kesalahan. Tidak dapat terhubung ke server.');
    }
});


console.log('Bot Telegram MIKU Store berjalan...');