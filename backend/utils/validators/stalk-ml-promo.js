const axios = require("axios");
const mobapayTrackedPromoTitles = [ 
    "50+50", "150+150", "250+250", "500+500" 
]; 

// KITA HAPUS 'mobapayTrackedSmallPromos' KARENA SUDAH TIDAK DIPERLUKAN

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
                // KITA HAPUS 'smallPromo' DARI SINI
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
        // KITA HAPUS 'smallPromo' DARI SINI
        errors: [] 
    }; 

    // --- Panggilan API 1: Toko Utama (untuk Nickname, DD, Cek Region Bayar) --- 
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

                    // KITA HAPUS SELURUH BLOK LOGIKA 'PROMO DIAMOND KECIL' DARI SINI

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

    return { status: true, message: "Pengambilan data selesai.", data: combinedResults }; 
}

// ============================================================
// PHASE 5C-2A — Mobapay MLBB Eligibility Engine
// ============================================================

// SKU real dari audit Mobapay API (app_id=100000)
const MOBAPAY_SKU = {
    WDP:          'com.moonton.diamond_mt_id_one_time_weekly_diamond',
    WEEKLY_ELITE: 'com.moonton.skin_69_mt_id',
    MONTHLY_EPIC: 'com.moonton.skin_70_mt_id',
    // Double Diamond — dicek dari shelf_location bukan good_list
    DD_TITLES: { '50+50': true, '150+150': true, '250+250': true, '500+500': true },
};

const VALID_DD_TARGETS = Object.keys(MOBAPAY_SKU.DD_TITLES);
const VALID_CHECKS     = ['wdp_available', 'double_diamond', 'weekly_elite', 'monthly_epic', 'payment_channel', 'region_id'];

/**
 * Tentukan apakah satu item Mobapay tersedia untuk dibeli.
 * @param {object} item - Satu produk dari good_list atau goods di shelf
 * @returns {boolean}
 */
function isItemAvailable(item) {
    if (!item) return false;
    if (item.game_can_buy === false) return false;
    if (item.goods_limit && item.goods_limit.reached_limit === true) return false;
    return true;
}

/**
 * Cek apakah akun memiliki payment channel yang cocok dengan negara yang diizinkan.
 * HANYA dipanggil jika checks mengandung "payment_channel".
 * @param {object} shopInfo - shop_info dari respons Mobapay
 * @param {string[]} allowedCountries - Array country code uppercase, contoh ["ID"]
 * @returns {boolean} true jika channel ditemukan
 */
function detectPaymentChannelCountry(shopInfo, allowedCountries) {
    if (!shopInfo || !allowedCountries || allowedCountries.length === 0) return false;

    const INDO_DIRECT = ['dana', 'ovo', 'gopay', 'shopeepay', 'qris', 'linkaja'];
    const goodList = shopInfo.good_list;
    if (!goodList || !Array.isArray(goodList) || goodList.length === 0) return false;

    // Ambil 3 produk diamond reguler sebagai sampel
    const samples = goodList
        .filter(g => g.sku && g.sku.startsWith('com.moonton.diamond_mt_id_'))
        .slice(0, 3);
    if (samples.length === 0) return false;

    for (const product of samples) {
        const channels = product.pay_channel_sub;
        if (!Array.isArray(channels) || channels.length === 0) continue;
        for (const pcs of channels) {
            if (pcs.active !== 1) continue;
            for (const country of allowedCountries) {
                const cc = country.toLowerCase();
                if (cc === 'id') {
                    if (INDO_DIRECT.includes((pcs.direct_channel || '').toLowerCase())) return true;
                    if ((pcs.cus_code || '').toLowerCase().includes('_id_')) return true;
                } else {
                    if ((pcs.cus_code || '').toLowerCase().includes(`_${cc}_`)) return true;
                }
            }
        }
    }
    return false;
}

/**
 * Engine eligibility Mobapay MLBB untuk order flow.
 *
 * Memanggil Mobapay API satu kali, lalu menjalankan hanya check yang diminta.
 * Tidak pernah memanggil API untuk produk tanpa config.
 * Tidak throw untuk eligibility gagal — return { success: false, message }.
 * Throw untuk network fatal agar server.js bisa ubah ke pesan aman.
 *
 * @param {string} userId     - targetGameId (MLBB User ID)
 * @param {string|null} zoneId - targetServerId (MLBB Zone ID)
 * @param {string[]} checks   - Array nama check, contoh ["wdp_available"]
 * @param {object}   rules    - Rules dari config, contoh { target: "50+50" }
 * @param {object}   options  - { country: "ID", timeout: 10000 }
 * @returns {{ success: boolean, message: string, data: object }}
 * @throws {Error} Hanya jika network/API fatal (agar server.js ubah ke pesan aman)
 */
async function checkMobapayMlbbEligibility(userId, zoneId, checks = [], rules = {}, options = {}) {
    const country = (options.country && typeof options.country === 'string') ? options.country.toUpperCase() : 'ID';
    const timeout = (typeof options.timeout === 'number' && options.timeout > 0) ? options.timeout : 10000;

    if (!userId) {
        return { success: false, message: 'User ID wajib diisi.', data: {} };
    }

    // Tidak ada check yang diminta → lulus
    if (!Array.isArray(checks) || checks.length === 0) {
        return { success: true, message: 'Tidak ada eligibility check.', data: {} };
    }

    // Normalise: region_id adalah alias lama → payment_channel dengan allowedPaymentCountries=["ID"]
    const normalizedChecks = checks.map(c => (c === 'region_id' ? 'payment_channel' : c));

    // Panggil Mobapay (throw jika network fatal — intentional)
    const apiUrl = 'https://api.mobapay.com/api/app_shop';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.mobapay.com/',
        'Origin': 'https://www.mobapay.com',
    };
    const params = {
        app_id: '100000',
        game_user_key: userId,
        game_server_key: zoneId || '',
        country: country,
        language: 'en',
        network: '', net: '', coupon_id: '', shop_id: '',
    };

    console.log(`[MobapayEligibility] Requesting API for userId=${userId} country=${country} checks=${normalizedChecks.join(',')}`);

    // Throw sengaja agar server.js tangkap dan ubah ke pesan aman
    const resp = await axios.get(apiUrl, { params, headers, timeout });
    const raw = resp.data;

    if (!raw || typeof raw.code === 'undefined') {
        throw new Error('Respons API Mobapay tidak valid.');
    }

    // Error-level code dari API → ID tidak valid
    const INVALID_ID_CODES = [10003, 10004, 20001, 30002, 30003, 30004, 30005, 30006, 30007, 30008, 30009, 30010, 70001];
    if (raw.code !== 0) {
        if (INVALID_ID_CODES.includes(raw.code)) {
            return { success: false, message: 'User ID atau Zone ID tidak valid.', data: { apiCode: raw.code } };
        }
        // Kode lain yang tidak dikenal → lempar ke server.js sebagai fatal
        throw new Error(`Mobapay API code ${raw.code}: ${raw.message || 'Unknown error'}`);
    }

    const apiData   = raw.data || {};
    const userInfo  = apiData.user_info || {};
    const shopInfo  = apiData.shop_info || {};
    const goodList  = Array.isArray(shopInfo.good_list) ? shopInfo.good_list : [];
    const shelfList = Array.isArray(shopInfo.shelf_location) ? shopInfo.shelf_location : [];

    // Cek user_info.code untuk invalid ID
    if (userInfo.code !== undefined && userInfo.code !== 0) {
        return { success: false, message: 'User ID atau Zone ID tidak valid.', data: { userInfoCode: userInfo.code } };
    }

    // Jalankan setiap check
    for (const check of normalizedChecks) {
        switch (check) {

            case 'wdp_available': {
                const item = goodList.find(g => g.sku === MOBAPAY_SKU.WDP);
                if (!item || !isItemAvailable(item)) {
                    return { success: false, message: 'WDP untuk ID ini sudah penuh atau tidak tersedia.', data: { check } };
                }
                break;
            }

            case 'double_diamond': {
                const target = rules && rules.target;
                if (!target || !MOBAPAY_SKU.DD_TITLES[target]) {
                    // Config tidak lengkap — reject order aman
                    return { success: false, message: 'Konfigurasi Double Diamond tidak valid (target tidak dikenal).', data: { check, target } };
                }
                const ddShelf = shelfList.find(s => s.title && s.title.toLowerCase().includes('double diamonds on first recharge'));
                const ddGoods = (ddShelf && Array.isArray(ddShelf.goods)) ? ddShelf.goods : [];
                const item    = ddGoods.find(g => g.title === target);
                if (!item || !isItemAvailable(item)) {
                    return { success: false, message: 'Promo Double Diamond untuk ID ini sudah tidak tersedia.', data: { check, target } };
                }
                break;
            }

            case 'weekly_elite': {
                const item = goodList.find(g => g.sku === MOBAPAY_SKU.WEEKLY_ELITE);
                if (!item || !isItemAvailable(item)) {
                    return { success: false, message: 'Bundle Weekly Elite tidak tersedia untuk ID ini.', data: { check } };
                }
                break;
            }

            case 'monthly_epic': {
                const item = goodList.find(g => g.sku === MOBAPAY_SKU.MONTHLY_EPIC);
                if (!item || !isItemAvailable(item)) {
                    return { success: false, message: 'Bundle Monthly Epic tidak tersedia untuk ID ini.', data: { check } };
                }
                break;
            }

            case 'payment_channel': {
                const allowed = (rules && Array.isArray(rules.allowedPaymentCountries) && rules.allowedPaymentCountries.length > 0)
                    ? rules.allowedPaymentCountries
                    : [country];
                const found = detectPaymentChannelCountry(shopInfo, allowed);
                if (!found) {
                    return { success: false, message: 'Metode pembayaran akun tidak sesuai untuk produk ini.', data: { check, allowed } };
                }
                break;
            }

            default:
                // Unknown check → skip (tidak blocking)
                console.warn(`[MobapayEligibility] Check tidak dikenal dilewati: ${check}`);
        }
    }

    return { success: true, message: 'Eligibility check lulus.', data: { userId, country } };
}

module.exports = {
    checkAllMobapayPromosML,
    checkMobapayMlbbEligibility,
    // Export untuk unit test
    _internal: { isItemAvailable, detectPaymentChannelCountry, MOBAPAY_SKU, VALID_DD_TARGETS, VALID_CHECKS },
};