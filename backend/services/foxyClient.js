const axios = require('axios');
const { FOXY_API_KEY } = require('../config/env');
const {
    FOXY_BASE_URL,
    PROVIDER_TIMEOUT_MS,
    FOXY_CACHE_TTL,
} = require('../config/constants');
const { safeAxiosError } = require('../utils/logger');
const { validateGameId } = require('../utils/validators/cek-id-game.js');
const { checkMobapayMlbbEligibility } = require('../utils/validators/stalk-ml-promo.js');

/**
 * Jalankan validasi ID game jika product.validation_config aktif.
 * Dipanggil SEBELUM saldo dipotong.
 * @param {object} product - Baris produk dari DB (harus punya validation_config & needs_server_id)
 * @param {string} targetGameId - User ID game dari request
 * @param {string|null} targetServerId - Server ID dari request (bisa null)
 * @returns {{ skipped: true } | { validated: true }}
 * @throws {Error} Jika validasi gagal atau validator error
 */
async function validateOrderGameIdIfNeeded(product, targetGameId, targetServerId) {
    const config = product.validation_config;
    // Skip jika config tidak ada, enabled !== true, atau validator kosong
    if (!config || config.enabled !== true || !config.validator ||
        typeof config.validator !== 'string' || !config.validator.trim()) {
        return { skipped: true };
    }

    const validatorName = config.validator.trim();
    const zoneId = product.needs_server_id ? (targetServerId || null) : null;

    // === Phase 5C-2A: Mobapay MLBB Eligibility ===
    if (validatorName === 'mobapay-mlbb-eligibility') {
        let mobapayResult;
        try {
            mobapayResult = await checkMobapayMlbbEligibility(
                targetGameId,
                zoneId,
                config.checks || [],
                config.rules || {},
                { country: config.country || 'ID', timeout: 10000 }
            );
        } catch (mobErr) {
            // Network/API fatal — fail-closed: tolak order, saldo tidak dipotong
            console.warn('[validateOrderGameId] Mobapay network error:', mobErr && mobErr.message);
            throw new Error('Pengecekan promo sedang tidak tersedia, coba lagi nanti.');
        }
        if (!mobapayResult.success) {
            const safeMsg = typeof mobapayResult.message === 'string' && mobapayResult.message.length > 0
                ? mobapayResult.message
                : 'Produk tidak tersedia untuk ID ini.';
            throw new Error(safeMsg);
        }
        return { validated: true };
    }

    // === PGS Validator (existing) ===
    let result;
    try {
        result = await validateGameId(
            validatorName,
            targetGameId,
            zoneId,
            config.rules || {}
        );
    } catch (valErr) {
        console.warn('[validateOrderGameId] Validator error:', valErr && valErr.message);
        throw new Error('Validasi ID sedang tidak tersedia, coba lagi nanti.');
    }

    if (!result.success) {
        const safeMsg = typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : 'ID game tidak valid.';
        throw new Error(safeMsg);
    }
    return { validated: true };
}

// === CACHE PRODUK FOXY ===
let foxyProductCache = null;
let foxyCacheTimestamp = null;

function invalidateFoxyProductCache() {
    foxyProductCache = null;
    foxyCacheTimestamp = null;
}

async function getFoxyProducts() {
    const now = Date.now();
    if (foxyProductCache && foxyCacheTimestamp && (now - foxyCacheTimestamp < FOXY_CACHE_TTL)) {
        return foxyProductCache;
    }

    const foxyConfig = {
        headers: {
            'Authorization': FOXY_API_KEY,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.0.0.0 Safari/537.36',
            'Referer': 'https://www.foxygamestore.com/'
        },
        timeout: PROVIDER_TIMEOUT_MS
    };

    try {
        const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, foxyConfig);
        foxyProductCache = response.data.data;
        foxyCacheTimestamp = now;
        return foxyProductCache;
    } catch (err) {
        // Safe log — tidak print headers atau Authorization
        const safeErr = safeAxiosError(err, 'Foxy');
        if (safeErr.isCloudflareChallenge) {
            console.warn('[getFoxyProducts] Blocked by Cloudflare challenge. VPS IP may need whitelisting.');
        } else {
            console.error('[getFoxyProducts] Failed to fetch products:', safeErr);
        }
        throw err;
    }
}

module.exports = {
    validateOrderGameIdIfNeeded,
    invalidateFoxyProductCache,
    getFoxyProducts,
};
