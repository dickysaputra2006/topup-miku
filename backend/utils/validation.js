const { UUID_REGEX, REF_ID_REGEX, INVOICE_ID_REGEX } = require('../config/constants');

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255;
}

function isValidPassword(password) {
    return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function isValidApiKey(apiKey) {
    // Menerima key baru 32 byte (64 hex) dan key legacy 24 byte (48 hex) selama masa transisi
    return typeof apiKey === 'string' && /^(?:[a-f0-9]{48}|[a-f0-9]{64})$/i.test(apiKey);
}

function parsePositiveQuota(rawValue) {
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return null;
    const num = Number(rawValue);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function isValidPriceAmount(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 && numberValue <= 100000000;
}

function isValidInvoiceId(rawId) {
    return typeof rawId === 'string' && INVOICE_ID_REGEX.test(rawId);
}

function parseOptionalRefId(rawRefId) {
    if (rawRefId === undefined || rawRefId === null) {
        return null;
    }
    if (typeof rawRefId !== 'string' || !REF_ID_REGEX.test(rawRefId)) {
        const err = new Error('Format ref_id tidak valid. Gunakan 1-100 karakter huruf, angka, titik, underscore, titik dua, atau tanda hubung.');
        err.statusCode = 400;
        throw err;
    }
    return rawRefId;
}

function parseOptionalIdempotencyKeyHeader(req) {
    const rawHeader = req && req.headers ? req.headers['idempotency-key'] : undefined;
    if (rawHeader === undefined) {
        return null;
    }
    if (typeof rawHeader !== 'string') {
        const err = new Error('Header Idempotency-Key harus berupa UUID yang valid.');
        err.statusCode = 400;
        throw err;
    }
    const trimmed = rawHeader.trim();
    if (!UUID_REGEX.test(trimmed)) {
        const err = new Error('Header Idempotency-Key harus berupa UUID yang valid.');
        err.statusCode = 400;
        throw err;
    }
    return trimmed.toLowerCase();
}

function isSafeAssetUrl(rawUrl) {
    if (!rawUrl) return true;
    if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) return true;
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function parseOptionalBoolean(val, fallback) {
    if (val === undefined) return fallback;
    if (typeof val === 'boolean') return val;
    if (val === 'true' || val === 1 || val === '1') return true;
    if (val === 'false' || val === 0 || val === '0') return false;
    return null;
}

function parseOptionalText(body, key, fallback, maxLen) {
    const hasField = Object.prototype.hasOwnProperty.call(body, key);
    const raw = hasField ? body[key] : fallback;
    if (raw === null || raw === undefined) return { value: null };
    if (typeof raw !== 'string') return { error: `${key} harus berupa teks.` };
    const trimmed = raw.trim();
    if (!trimmed) return { value: null };
    if (trimmed.length > maxLen) return { error: `${key} maksimal ${maxLen} karakter.` };
    return { value: trimmed };
}

/**
 * Sanitasi nama game dari data_cekid.json agar tidak menampilkan suffix provider
 * ke publik tanpa mengubah ID layanan asli.
 */
function sanitizeValidationServiceName(name) {
    if (!name || typeof name !== 'string') return name || '';
    let clean = name.trim();
    // Khusus: Mobile Legends With Region → label deskriptif
    if (/mobile.?legends.?with.?region/i.test(clean)) {
        return 'Mobile Legends - Verifikasi Region';
    }
    // Hapus suffix provider dalam tanda kurung: (Mobapay), (DG), (HK), (FAST), (WORK, FAST), dll.
    clean = clean.replace(/\s*\([^)]*\)\s*$/i, '').trim();
    // Hapus suffix tanpa kurung: Work Fast, FAST di akhir
    clean = clean.replace(/\s+(Work\s+Fast|FAST|WORK)\s*$/i, '').trim();
    return clean || name.trim();
}

module.exports = {
    isValidEmail,
    isValidPassword,
    isValidApiKey,
    parsePositiveQuota,
    isValidPriceAmount,
    isValidInvoiceId,
    parseOptionalRefId,
    parseOptionalIdempotencyKeyHeader,
    isSafeAssetUrl,
    parseOptionalBoolean,
    parseOptionalText,
    sanitizeValidationServiceName,
};
