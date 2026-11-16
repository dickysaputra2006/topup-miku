const axios = require("axios");

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
 * Throw untuk network fatal agar pemanggil bisa ubah ke pesan aman.
 *
 * @param {string} userId     - targetGameId (MLBB User ID)
 * @param {string|null} zoneId - targetServerId (MLBB Zone ID)
 * @param {string[]} checks   - Array nama check, contoh ["wdp_available"]
 * @param {object}   rules    - Rules dari config, contoh { target: "50+50" }
 * @param {object}   options  - { country: "ID", timeout: 10000 }
 * @returns {{ success: boolean, message: string, data: object }}
 * @throws {Error} Hanya jika network/API fatal (agar pemanggil ubah ke pesan aman)
 */
async function checkMobapayMlbbEligibility(userId, zoneId, checks = [], rules = {}, options = {}) {
    const country = (options.country && typeof options.country === 'string') ? options.country.toUpperCase() : 'ID';
    const timeout = (typeof options.timeout === 'number' && options.timeout > 0) ? Math.min(options.timeout, 10000) : 10000;

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

    // Throw sengaja agar pemanggil tangkap dan ubah ke pesan aman
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
        // Kode lain yang tidak dikenal → lempar sebagai fatal
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
    checkMobapayMlbbEligibility,
    _internal: { isItemAvailable, detectPaymentChannelCountry, MOBAPAY_SKU, VALID_DD_TARGETS, VALID_CHECKS },
};
