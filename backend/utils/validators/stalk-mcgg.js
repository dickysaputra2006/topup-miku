
const axios = require("axios");
const { URLSearchParams } = require('url');

const BASE_URL_MOBAPAY = "https://api.mobapay.com/api/app_shop";
const APP_ID_MCGG = "124526"; // App ID untuk Magic Chess: Go Go

// Daftar produk promo yang ingin Anda lacak secara spesifik
const TRACKED_PROMO_TITLES_MCGG = [
  "50+50", 
  "150+150", 
  "250+250", // Perhatikan, contoh Anda menyebut "350+250", saya asumsikan maksudnya "250+250" sesuai data JSON
  "500+500"
];


async function cekPromoMcggMobapay(gameUserId, gameServerId) { // Nama fungsi diubah agar lebih spesifik
  const params = new URLSearchParams({
    app_id: APP_ID_MCGG,
    game_user_key: gameUserId,
    game_server_key: gameServerId,
    country: "ID",
    language: "en",
  });
  const apiUrl = `${BASE_URL_MOBAPAY}?${params.toString()}`;

  try {
    console.log(`[MCGG_DD] Mengirim permintaan untuk ID: ${gameUserId}, Server: ${gameServerId}`);
    const response = await axios.get(apiUrl, {
      headers: { 
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
       }
    });

    // console.log(`[MOBAPAY_MCGG_PROMO] Respons API Data Lengkap:`, JSON.stringify(response.data, null, 2)); // Untuk debugging

    if (response.data && response.data.code === 0 && response.data.data) {
      const userInfo = response.data.data.user_info;
      const shopInfo = response.data.data.shop_info;
      let nickname = null;

      if (userInfo && userInfo.code === 0 && userInfo.user_name && userInfo.user_name.trim() !== "") {
        nickname = userInfo.user_name;
      } else if (userInfo && (userInfo.user_name === "" || userInfo.code !== 0)) {
         return { 
            success: false, 
            message: userInfo.message || "User ID atau Server ID tidak valid (berdasarkan info pengguna dari API).",
            id: gameUserId,
            server: gameServerId,
        };
      }
      if (!nickname && userInfo) {
          console.warn(`[MCGG_DD] Nickname tidak terdeteksi atau kosong dari user_info. UserID: ${gameUserId}`);
      }
      
      const promoProductsResult = [];
      let foundShelf = false;

      if (shopInfo && shopInfo.shelf_location && Array.isArray(shopInfo.shelf_location)) {
        // Cari shelf yang berisi "Double Diamonds on First Recharge"
        const ddShelf = shopInfo.shelf_location.find(
            shelf => shelf.title && shelf.title.toLowerCase().includes("double diamonds on first recharge")
        );

        if (ddShelf && ddShelf.goods && Array.isArray(ddShelf.goods)) {
            foundShelf = true;
            TRACKED_PROMO_TITLES_MCGG.forEach(targetTitle => {
                const product = ddShelf.goods.find(good => good.title === targetTitle);
                if (product) {
                    const isAvailable = product.game_can_buy !== false && 
                                        (product.goods_limit ? product.goods_limit.reached_limit === false : true);
                    promoProductsResult.push({
                        name: product.title, // Menggunakan title dari goods di shelf
                        price: product.price_local_show,
                        currency: product.currency,
                        isAvailable: isAvailable,
                        // Tambahkan detail lain jika perlu, misalnya dari product.label atau product.description
                    });
                } else {
                    // Jika produk yang dilacak tidak ditemukan di shelf promo
                    promoProductsResult.push({
                        name: targetTitle,
                        price: "N/A",
                        currency: "",
                        isAvailable: false,
                        message: "Item promo tidak ditemukan di shelf."
                    });
                }
            });
        }
      }
      
      if (!foundShelf && promoProductsResult.length === 0) {
        // Jika shelf "Double Diamonds" tidak ada, atau produk tidak ada di sana
         console.log("[MCGG_DD] Shelf 'Double Diamonds on First Recharge' tidak ditemukan atau kosong.");
      }
      
      if (nickname) {
        return {
          success: true,
          message: "Akun ditemukan.",
          nickname: nickname,
          id: gameUserId,
          server: gameServerId,
          promoProducts: promoProductsResult, // Hanya produk promo yang dilacak
          rawData: response.data // Tetap sertakan untuk fleksibilitas
        };
      } else {
        // Nickname tidak ditemukan, tetapi mungkin ada data promo jika ID/Server valid untuk API
        return { 
            success: false, 
            message: userInfo?.message || "Nickname tidak ditemukan.", 
            id: gameUserId, 
            server: gameServerId, 
            promoProducts: promoProductsResult, 
            rawData: response.data 
        };
      }
    } else {
      return { 
        success: false, 
        message: response.data.message || "Gagal mendapatkan data akun.",
        id: gameUserId,
        server: gameServerId,
        promoProducts: [], // Kembalikan array kosong jika API utama gagal
        rawData: response.data
      };
    }
  } catch (error) {
    console.error(`[MCGG_DD] Exception saat request API:`, error.response ? JSON.stringify(error.response.data) : error.message);
    let errorMessage = `Terjadi kesalahan.`;
     if (error.response) {
        errorMessage = `Error API: ${error.response.status} - ${error.response.data?.message || error.response.data?.error || "Tidak ada pesan error spesifik."}`;
        if (typeof error.response.data === 'string' && error.response.data.toLowerCase().includes('<html')) {
             errorMessage = `Error API: ${error.response.status} - Server mengembalikan halaman HTML, kemungkinan permintaan diblokir.`;
        }
    } else if (error.message) {
        errorMessage = error.message;
    }
    return { success: false, message: errorMessage, id: gameUserId, server: gameServerId, promoProducts: [] };
  }
}

module.exports = {
  cekPromoMcggMobapay, 
};