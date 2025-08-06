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

// --- FUNGSI UTAMA ---

// Fungsi untuk mengirim menu utama (Start dan Menu)
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

// Fungsi untuk menampilkan daftar harga produk (yang sebelumnya /produk)
const sendPriceList = async (chatId, gameName) => {
    try {
        await bot.sendMessage(chatId, `⏳ Mencari produk untuk *${gameName}*...`, { parse_mode: 'Markdown' });
        const response = await axios.get(`${apiUrl}/api/public/bot-products/${encodeURIComponent(gameName)}`);
        
        if (response.data && response.data.success) {
            const products = response.data.data;
            if (products.length === 0) {
                return bot.sendMessage(chatId, `ℹ️ Tidak ada produk untuk *${gameName}*.`, { parse_mode: 'Markdown' });
            }

            let productMessage = `✅ *Daftar Harga untuk ${gameName}*\n\n`;
            products.forEach(p => {
                const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(p.price);
                productMessage += `▪️ ${p.name}\n   └ *${formattedPrice}*\n`;
            });
            await bot.sendMessage(chatId, productMessage, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            await bot.sendMessage(chatId, `❌ Game *${gameName}* tidak ditemukan.`, { parse_mode: 'Markdown' });
        } else {
            console.error(`Error saat sendPriceList untuk ${gameName}:`, error.message);
            await bot.sendMessage(chatId, '❌ Terjadi kesalahan saat mengambil harga.');
        }
    }
};

// --- LISTENER PERINTAH ---

bot.onText(/\/start|\/menu/, (msg) => {
    sendMainMenu(msg.chat.id, msg.from.first_name);
});

bot.onText(/\/ceksaldo/, async (msg) => {
    // Kode /ceksaldo Anda yang sudah ada, tidak perlu diubah
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

// Perintah /produk manual masih bisa digunakan
bot.onText(/\/produk (.+)/, (msg, match) => {
    sendPriceList(msg.chat.id, match[1]);
});


// --- LOGIKA TOMBOL INTERAKTIF (INLINE KEYBOARD) ---

// 1. Menampilkan Kategori Game saat perintah /pricelist
bot.onText(/\/pricelist/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const response = await axios.get(`${apiUrl}/api/public/bot-games`);
        const groupedGames = response.data.data;
        const categories = Object.keys(groupedGames);

        const keyboard = categories.map(category => ([{
            text: category,
            callback_data: `category_${category}` // Data yang dikirim saat tombol ditekan
        }]));

        await bot.sendMessage(chatId, 'Silakan pilih kategori game:', {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } catch (error) {
        console.error("Error mengambil kategori game:", error.message);
        await bot.sendMessage(chatId, "Gagal memuat kategori game.");
    }
});

// 2. Menangani saat tombol ditekan (callback_query)
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data; // Data dari tombol, misal: "category_Mobile Game"

    // Jawab callback query agar tombol tidak loading terus
    bot.answerCallbackQuery(callbackQuery.id);

    // Jika yang ditekan adalah tombol kategori
    if (data.startsWith('category_')) {
        const category = data.replace('category_', '');
        
        try {
            const response = await axios.get(`${apiUrl}/api/public/bot-games`);
            const gamesInCategory = response.data.data[category];

            const keyboard = gamesInCategory.map(gameName => ([{
                text: gameName,
                callback_data: `game_${gameName}`
            }]));
            
            // Tambahkan tombol kembali
            keyboard.push([{ text: '« Kembali ke Kategori', callback_data: 'back_to_categories' }]);

            // Edit pesan yang ada untuk menampilkan daftar game
            await bot.editMessageText(`Pilih game dari kategori *${category}*:`, {
                chat_id: chatId,
                message_id: msg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } catch (error) {
            console.error("Error mengambil game:", error.message);
            await bot.sendMessage(chatId, "Gagal memuat daftar game.");
        }
    }
    
    // Jika yang ditekan adalah tombol game
    else if (data.startsWith('game_')) {
        const gameName = data.replace('game_', '');
        // Hapus tombol-tombol dari pesan sebelumnya
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId,
            message_id: msg.message_id
        });
        // Panggil fungsi untuk mengirim pricelist
        await sendPriceList(chatId, gameName);
    }
    
    // Jika yang ditekan adalah tombol kembali
    else if (data === 'back_to_categories') {
        // Logika ini sama dengan /pricelist, kita panggil ulang untuk menampilkan kategori
        const response = await axios.get(`${apiUrl}/api/public/bot-games`);
        const groupedGames = response.data.data;
        const categories = Object.keys(groupedGames);

        const keyboard = categories.map(category => ([{
            text: category,
            callback_data: `category_${category}`
        }]));

        await bot.editMessageText('Silakan pilih kategori game:', {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    }
});

console.log('Bot Telegram MIKU Store berjalan...');