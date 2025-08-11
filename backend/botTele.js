require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminApiKey = process.env.ADMIN_API_KEY;
const apiUrl = 'http://localhost:3000';

if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN tidak diatur!');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const ITEMS_PER_PAGE = 10;

// --- FUNGSI UTAMA ---
const sendMainMenu = (chatId, firstName) => {
    const menuMessage = `
Halo, ${firstName}! 👋
Silakan gunakan perintah di bawah ini:

👤 *Perintah Akun*
/ceksaldo - Melihat sisa saldo H2H Anda.

📦 *Daftar Harga*
/pricelist - Menampilkan daftar harga interaktif.
    `;
    bot.sendMessage(chatId, menuMessage, { parse_mode: 'Markdown' });
};

const sendAdminNotification = async (message) => {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!adminId) {
        console.error("ADMIN_TELEGRAM_ID tidak diatur. Tidak bisa mengirim notifikasi.");
        return;
    }
    try {
        await bot.sendMessage(adminId, `🚨 **Peringatan Sistem** 🚨\n\n${message}`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`Gagal mengirim notifikasi ke admin: ${error.message}`);
    }
};


const sendPaginatedPriceList = async (chatId, gameName, page = 1, messageId = null) => {
    try {
        const response = await axios.get(`${apiUrl}/api/public/bot-products/${encodeURIComponent(gameName)}`);
        
        if (!response.data.success) {
            return bot.sendMessage(chatId, `❌ Gagal mengambil data: ${response.data.message}`);
        }
        
        const products = response.data.data;
        if (products.length === 0) {
            return bot.sendMessage(chatId, `ℹ️ Tidak ada produk untuk *${gameName}*.`, { parse_mode: 'Markdown' });
        }

        const totalPages = Math.ceil(products.length / ITEMS_PER_PAGE);
        const start = (page - 1) * ITEMS_PER_PAGE;
        const end = start + ITEMS_PER_PAGE;
        const paginatedProducts = products.slice(start, end);

        let productMessage = `✅ *Daftar Harga untuk ${gameName}* (Hal ${page}/${totalPages})\n\n`;
        paginatedProducts.forEach(p => {
            const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(p.price);
            productMessage += `▪️ ${p.name}\n   └ *${formattedPrice}*\n`;
        });

        const keyboard = [];
        const row = [];
        if (page > 1) {
            row.push({ text: '◀ Hal Sebelumnya', callback_data: `pricelist_${gameName}_${page - 1}` });
        }
        if (page < totalPages) {
            row.push({ text: 'Hal Berikutnya ▶', callback_data: `pricelist_${gameName}_${page + 1}` });
        }
        if(row.length > 0) keyboard.push(row);
        
        const options = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        };

        if (messageId) {
            await bot.editMessageText(productMessage, { ...options, chat_id: chatId, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, productMessage, options);
        }

    } catch (error) {
        // --- PERBAIKAN: Tangkap error 'message is not modified' ---
        if (error.response && error.response.body && error.response.body.description.includes('message is not modified')) {
            // Abaikan error ini, karena artinya pengguna mengklik tombol halaman yang sama. Tidak perlu melakukan apa-apa.
            console.log("Diabaikan: Pesan tidak diubah.");
        } else {
            console.error(`Error saat sendPaginatedPriceList untuk ${gameName}:`, error.message);
            await bot.sendMessage(chatId, '❌ Terjadi kesalahan saat mengambil harga.');
        }
    }
};

// --- LISTENER PERINTAH ---
bot.onText(/\/start|\/menu/, (msg) => sendMainMenu(msg.chat.id, msg.from.first_name));

bot.onText(/\/ceksaldo/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await bot.sendMessage(chatId, '⏳ Sedang mengecek saldo Anda...');
        const config = { headers: { 'x-api-key': adminApiKey } };
        const response = await axios.get(`${apiUrl}/h2h/profile`, config);
        if (response.data && response.data.success) {
            const userProfile = response.data.data;
            const formattedBalance = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(userProfile.balance);
            const balanceMessage = `✅ Saldo Anda saat ini:\n*${formattedBalance}*`;
            await bot.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengambil saldo: ${response.data.message}`);
        }
    } catch (error) {
        console.error('Error saat /ceksaldo:', error.message);
        await bot.sendMessage(chatId, '❌ Terjadi kesalahan. Tidak dapat terhubung ke server.');
    }
});

bot.onText(/\/produk (.+)/, (msg, match) => sendPaginatedPriceList(msg.chat.id, match[1]));

bot.onText(/\/pricelist/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const response = await axios.get(`${apiUrl}/api/public/bot-games`);
        const groupedGames = response.data.data;
        const categories = Object.keys(groupedGames);
        const keyboard = categories.map(category => ([{ text: category, callback_data: `category_${category}` }]));
        await bot.sendMessage(chatId, 'Silakan pilih kategori game:', { reply_markup: { inline_keyboard: keyboard } });
    } catch (error) {
        console.error("Error mengambil kategori game:", error.message);
        await bot.sendMessage(chatId, "Gagal memuat kategori game.");
    }
});

// --- HANDLER UNTUK CALLBACK QUERY (TOMBOL) ---
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    bot.answerCallbackQuery(callbackQuery.id);

    try { // --- PERBAIKAN: Bungkus semua logika callback dalam try...catch ---
        if (data.startsWith('pricelist_')) {
            const parts = data.split('_');
            const gameName = parts.slice(1, -1).join('_');
            const page = parseInt(parts[parts.length - 1], 10);
            await sendPaginatedPriceList(chatId, gameName, page, msg.message_id);
        } else if (data.startsWith('category_')) {
            const category = data.replace('category_', '');
            const response = await axios.get(`${apiUrl}/api/public/bot-games`);
            const gamesInCategory = response.data.data[category];
            const keyboard = gamesInCategory.map(gameName => ([{ text: gameName, callback_data: `game_${gameName}` }]));
            keyboard.push([{ text: '« Kembali ke Kategori', callback_data: 'back_to_categories' }]);
            await bot.editMessageText(`Pilih game dari kategori *${category}*:`, {
                chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else if (data.startsWith('game_')) {
            const gameName = data.replace('game_', '');
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msg.message_id });
            await sendPaginatedPriceList(chatId, gameName);
        } else if (data === 'back_to_categories') {
            const response = await axios.get(`${apiUrl}/api/public/bot-games`);
            const groupedGames = response.data.data;
            const categories = Object.keys(groupedGames);
            const keyboard = categories.map(category => ([{ text: category, callback_data: `category_${category}` }]));
            await bot.editMessageText('Silakan pilih kategori game:', {
                chat_id: chatId, message_id: msg.message_id,
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (error) {
        // --- PERBAIKAN: Tangkap error 'message is not modified' di sini juga ---
        if (error.response && error.response.body && error.response.body.description.includes('message is not modified')) {
            console.log("Diabaikan: Pesan tidak diubah (dari callback).");
        } else {
            console.error("Error saat memproses callback_query:", error.message);
        }
    }
});

console.log('Bot Telegram MIKU Store berjalan...');
module.exports = { sendAdminNotification };