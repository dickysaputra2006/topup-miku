const mobapayTrackedPromoTitles = [ 
     "50+50", "150+150", "250+250", "500+500" 
 ]; 
 const mobapayTrackedSmallPromos = [ 
     { sku: "com.moonton.firstcharge_mt_id_11", name: "22 Diamond" }, 
     { sku: "com.moonton.firstcharge_mt_id_17", name: "34 Diamond" }, 
     { sku: "com.moonton.firstcharge_mt_id_25", name: "50 Diamond" }, 
 ];

 async function checkAllMobapayPromosML(userId, zoneId, countryCode = "ID") { 
     if (!userId || !zoneId) { 
         return { 
             status: false, 
             message: 'User ID dan Zone ID wajib diisi.', 
             data: { 
                 nickname: "Tidak Diketahui", 
                 userId: userId, 
                 zoneId: zoneId, 
                 isIdInvalid: false, 
                 isPaymentRegionMismatch: false, 
                 doubleDiamond: { statusText: "Data tidak dimuat.", items: [] }, 
                 smallPromo: { statusText: "Data tidak dimuat.", items: [] }, 
                 errors: ['User ID dan Zone ID wajib diisi.'] 
             } 
         }; 
     } 

     const apiUrl = 'https://api.mobapay.com/api/app_shop'; 
     const headers = { 
         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36', 
         'Accept': 'application/json, text/plain, */*', 
         'Referer': 'https://www.mobapay.com/', 
         'Origin': 'https://www.mobapay.com', 
     }; 

     let combinedResults = { 
         nickname: "Tidak Diketahui", 
         userId: userId, 
         zoneId: zoneId, 
         isIdInvalid: false, 
         isPaymentRegionMismatch: false, 
         doubleDiamond: { statusText: "Promo Double Diamond tidak termuat.", items: [] }, 
         smallPromo: { statusText: "Promo Diamond Kecil tidak termuat.", items: [] }, 
         errors: [] 
     }; 

     // --- Panggilan API 1: Toko Utama (untuk Nickname, DD, Small Promos, Cek Region Bayar) --- 
     try { 
         const mainShopParams = { 
             app_id: '100000', game_user_key: userId, game_server_key: zoneId, 
             country: countryCode, language: 'en', network: '', net: '', coupon_id: '', shop_id: '' 
         }; 
         console.log(`[checkAllMobapayPromosML] Requesting Main Shop API: ${apiUrl} with params: ${JSON.stringify(mainShopParams)}`); 
         const mainResponse = await axios.get(apiUrl, { params: mainShopParams, headers, timeout: 20000 }); 
         const mainResult = mainResponse.data; 

         if (mainResponse.status === 200 && mainResult && typeof mainResult.code !== 'undefined') { 
             if (mainResult.code === 0) { 
                 if (mainResult.data && mainResult.data.user_info) { 
                     const userInfo = mainResult.data.user_info; 
                     if (userInfo.code === 0) { 
                         if (userInfo.user_name && userInfo.user_name.trim() !== "") { 
                             combinedResults.nickname = userInfo.user_name; 
                         } else { 
                             console.warn(`[checkAllMobapayPromosML] Nickname kosong meskipun user_info.code (0) dan mainResult.code (0) sukses. UserID: ${userId}`); 
                         } 
                     } else { 
                         combinedResults.nickname = "Tidak Diketahui"; 
                         combinedResults.isIdInvalid = true; 
                         const userApiMessage = userInfo.message || "Tidak ada pesan dari API user_info"; 
                         console.warn(`[checkAllMobapayPromosML] ID/Zone kemungkinan salah berdasarkan user_info.code: ${userInfo.code} (${userApiMessage}). UserID: ${userId}`); 
                         combinedResults.errors.push(`Kesalahan info pengguna: Kode ${userInfo.code} (${userApiMessage})`); 
                     } 
                 } else { 
                     combinedResults.nickname = "Tidak Diketahui"; 
                     const errorMsg = "Struktur data API tidak sesuai (user_info hilang setelah panggilan berhasil)."; 
                     combinedResults.errors.push(errorMsg); 
                     console.error(`[checkAllMobapayPromosML] ${errorMsg} UserID: ${userId}`); 
                 } 

                 if (mainResult.data && mainResult.data.shop_info) { 
                     const shopInfo = mainResult.data.shop_info; 
                     let isPaymentRegionMismatch = false; 
                     const commonIndoPaymentDirectChannels = ["dana", "ovo", "gopay", "shopeepay", "qris", "linkaja"]; 
                     if (shopInfo.good_list && Array.isArray(shopInfo.good_list) && shopInfo.good_list.length > 0) { 
                         const sampleProducts = shopInfo.good_list.filter(g => g.sku && g.sku.startsWith("com.moonton.diamond_mt_id_")).slice(0, 3); 
                         if (sampleProducts.length > 0) { 
                             let productsWithActiveIDChannels = 0; 
                             for (const product of sampleProducts) { 
                                 if (product.pay_channel_sub && Array.isArray(product.pay_channel_sub) && product.pay_channel_sub.length > 0) { 
                                     const hasActiveIDChannel = product.pay_channel_sub.some(pcs => 
                                         pcs.active === 1 && 
                                         (commonIndoPaymentDirectChannels.includes(pcs.direct_channel?.toLowerCase()) || pcs.cus_code?.toLowerCase().includes("_id_")) 
                                     ); 
                                     if (hasActiveIDChannel) { 
                                         productsWithActiveIDChannels++; 
                                         break; 
                                     } 
                                 } 
                             } 
                             if (productsWithActiveIDChannels === 0) { 
                                 isPaymentRegionMismatch = true; 
                                 console.log(`[checkAllMobapayPromosML] Indikasi mismatch region pembayaran: Tidak ada channel pembayaran ID aktif ditemukan untuk produk sampel.`); 
                             } else { 
                                 console.log(`[checkAllMobapayPromosML] Cek region pembayaran: Ditemukan channel ID aktif untuk produk sampel.`); 
                             } 
                         } else { 
                             console.log("[checkAllMobapayPromosML] Tidak ada produk sampel (diamond reguler) di good_list untuk cek region pembayaran."); 
                             if (mainResult.data.app_info && Array.isArray(mainResult.data.app_info.app_pay_channel_sub_list) && mainResult.data.app_info.app_pay_channel_sub_list.length > 0) { 
                                 const hasAnyActiveIDChannelInApp = mainResult.data.app_info.app_pay_channel_sub_list.some(pcs => { 
                                     return pcs.cus_code?.toLowerCase().includes("_id_") || commonIndoPaymentDirectChannels.some(ch => pcs.pay_channel_sub_name?.toLowerCase().includes(ch)); 
                                 }); 
                                 if (!hasAnyActiveIDChannelInApp) { 
                                     console.log(`[checkAllMobapayPromosML] Fallback cek region: app_pay_channel_sub_list ada, tapi tidak terdeteksi channel ID aktif.`); 
                                 } 
                             } 
                         } 
                     } else { 
                         console.log("[checkAllMobapayPromosML] good_list tidak tersedia atau kosong untuk cek region pembayaran."); 
                         isPaymentRegionMismatch = true; 
                     } 
                     combinedResults.isPaymentRegionMismatch = isPaymentRegionMismatch; 

                     // 1. Double Diamond Check 
                     if (shopInfo.shelf_location && Array.isArray(shopInfo.shelf_location)) { 
                         const ddShelf = shopInfo.shelf_location.find( 
                             shelf => shelf.title && shelf.title.toLowerCase().includes("double diamonds on first recharge") 
                         ); 
                         if (ddShelf && ddShelf.goods && Array.isArray(ddShelf.goods)) { 
                             let availableCount = 0; 
                             let trackedCount = 0; 
                             for (const targetTitle of mobapayTrackedPromoTitles) { 
                                 const apiProduct = ddShelf.goods.find(good => good.title === targetTitle); 
                                 if (apiProduct) { 
                                     trackedCount++; 
                                     const isAvailable = apiProduct.game_can_buy !== false && 
                                         (apiProduct.goods_limit ? apiProduct.goods_limit.reached_limit === false : true); 
                                     combinedResults.doubleDiamond.items.push({ name: targetTitle, available: isAvailable }); 
                                     if (isAvailable) availableCount++; 
                                 } 
                             } 
                             if (trackedCount === 0) combinedResults.doubleDiamond.statusText = "Tidak ada item Double Diamond (yang dilacak) ditemukan."; 
                             else if (availableCount === trackedCount && trackedCount > 0) combinedResults.doubleDiamond.statusText = "Semua item Double Diamond (yang dilacak) tersedia."; 
                             else if (availableCount > 0) combinedResults.doubleDiamond.statusText = "Beberapa item Double Diamond tersedia (pembelian terbatas)."; 
                             else combinedResults.doubleDiamond.statusText = "Semua item Double Diamond (yang dilacak) telah terpakai/limit."; 
                         } else { 
                             combinedResults.doubleDiamond.statusText = "Shelf 'Double Diamonds on First Recharge' tidak ada atau kosong."; 
                             console.log("[checkAllMobapayPromosML] Double Diamond shelf not found or no goods in main shop response."); 
                         } 
                     } else { 
                         combinedResults.doubleDiamond.statusText = "Data shelf_location tidak ada untuk Double Diamond."; 
                         console.log("[checkAllMobapayPromosML] shelf_location missing for Double Diamond in main shop response."); 
                     } 

                     // 2. Promo Diamond Kecil 
                     if (shopInfo.good_list && Array.isArray(shopInfo.good_list)) { 
                         let availableCount = 0; 
                         let trackedCount = 0; 
                         for (const trackedPromo of mobapayTrackedSmallPromos) { 
                             const apiProduct = shopInfo.good_list.find(good => good.sku === trackedPromo.sku); 
                          if (apiProduct) { 
                                 trackedCount++; 
                                 const isAvailable = apiProduct.game_can_buy !== false && 
                                     (apiProduct.goods_limit ? apiProduct.goods_limit.reached_limit === false : true); 
                                 combinedResults.smallPromo.items.push({ name: trackedPromo.name, available: isAvailable }); 
                                 if (isAvailable) availableCount++; 
                             } 
                         } 
                         if (trackedCount === 0) combinedResults.smallPromo.statusText = "Tidak ada item promo kecil (yang dilacak) ditemukan."; 
                         else if (availableCount === trackedCount) combinedResults.smallPromo.statusText = "Semua item promo kecil (yang dilacak) tersedia."; 
                         else if (availableCount > 0) combinedResults.smallPromo.statusText = "Beberapa item promo kecil tersedia (pembelian terbatas)."; 
                         else combinedResults.smallPromo.statusText = "Semua item promo kecil (yang dilacak) telah terpakai/limit."; 
                     } else { 
                         combinedResults.smallPromo.statusText = "Daftar produk utama (good_list) tidak ditemukan untuk cek promo kecil."; 
                     } 

                 } else if (mainResult.code === 0) { 
                     const errorMsg = "Struktur data API tidak sesuai (shop_info hilang setelah panggilan berhasil)."; 
                     combinedResults.errors.push(errorMsg); 
                     console.error(`[checkAllMobapayPromosML] ${errorMsg} UserID: ${userId}`); 
                 } 
             } else { 
                 combinedResults.nickname = "Tidak Diketahui"; 
                 const apiMessage = mainResult.message || "Tidak ada pesan dari API"; 
                 const invalidIdErrorCodes = [ 
                     10003, 10004, 20001, 30002, 30003, 30004, 30005, 30006, 30007, 30008, 30009, 30010, 70001 
                 ]; 
                 if (invalidIdErrorCodes.includes(mainResult.code)) { 
                     combinedResults.isIdInvalid = true; 
                 } 
                 const errorMsg = `Gagal mengambil data utama Mobapay: Code API ${mainResult.code} (${apiMessage})`; 
                 console.warn(`[checkAllMobapayPromosML] ${errorMsg}. UserID: ${userId}. isIdInvalid: ${combinedResults.isIdInvalid}`); 
                 combinedResults.errors.push(errorMsg); 
                 combinedResults.isPaymentRegionMismatch = true; 
             } 
         } else { 
             combinedResults.nickname = "Tidak Diketahui"; 
             const errorMsg = `Gagal memproses respons API utama. Status HTTP: ${mainResponse.status}. Respons awal: ${JSON.stringify(mainResult || "No response data").substring(0, 200)}`; 
             console.error(`[checkAllMobapayPromosML] Main Shop API Response Error: ${errorMsg}. UserID: ${userId}`); 
             combinedResults.errors.push(errorMsg); 
             combinedResults.isPaymentRegionMismatch = true; 
         } 
     } catch (error) { 
         console.error(`[checkAllMobapayPromosML] Error pada panggilan API Toko Utama:`, error.message, error.stack); 
         combinedResults.errors.push(`Error Toko Utama: ${error.message}`); 
         combinedResults.nickname = "Tidak Diketahui"; 
         combinedResults.isPaymentRegionMismatch = true; 
     } 

     // Panggilan API untuk Voucher of Flame (Naruto) telah dihapus 

     return { status: true, message: "Pengambilan data selesai.", data: combinedResults }; 
 }

 module.exports = {
  checkAllMobapayPromosML, 
};