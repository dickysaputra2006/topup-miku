require('dotenv').config();

const BOT_PRODUCT_BLACKLIST = ['FXGT', 'Via Login', 'Gifts'];
const MAX_BODY_SIZE = '100kb';
const DUPLICATE_ORDER_WINDOW_SECONDS = 15;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REF_ID_REGEX = /^[A-Za-z0-9._:-]{1,100}$/;
const INVOICE_ID_REGEX = /^[A-Za-z0-9_-]{3,64}$/;

// === KONFIGURASI FOXY API ===
const PROVIDER_TIMEOUT_MS = 15000; // 15 detik untuk semua request ke provider
const FOXY_CACHE_TTL = 5 * 60 * 1000; // 5 menit

const ALLOWED_PAYMENT_METHOD_TYPES = ['ewallet', 'bank', 'qris'];

const CALLBACK_VERIFY_COOLDOWN_MS = 5000;
const CALLBACK_SUCCESS_RESPONSE = { message: 'Callback berhasil diproses.' };

module.exports = {
    BOT_PRODUCT_BLACKLIST,
    MAX_BODY_SIZE,
    DUPLICATE_ORDER_WINDOW_SECONDS,
    UUID_REGEX,
    REF_ID_REGEX,
    INVOICE_ID_REGEX,
    FOXY_BASE_URL: (process.env.FOXY_BASE_URL || 'https://api.foxygamestore.com').replace(/\/+$/, ''),
    PROVIDER_TIMEOUT_MS,
    FOXY_CACHE_TTL,
    ALLOWED_PAYMENT_METHOD_TYPES,
    CALLBACK_VERIFY_COOLDOWN_MS,
    CALLBACK_SUCCESS_RESPONSE,
};
