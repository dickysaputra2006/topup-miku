const CONTROL_CHARS_WITHOUT_NEWLINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Pastikan body HTTP berupa plain object (bukan null, primitif, atau array).
 */
function getBodyObject(req) {
    if (!req || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return { error: 'Payload request harus berupa objek JSON.' };
    }
    return { value: req.body };
}

/**
 * Validasi bahwa nilai bertipe plain object.
 */
function requirePlainObject(value, fieldLabel) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: `${fieldLabel} harus berupa objek.` };
    }
    return { value };
}

/**
 * Validasi string wajib beserta panjang, regex opsional, dan normalisasi huruf.
 */
function requireString(value, fieldLabel, options = {}) {
    const {
        min = 1,
        max = 255,
        pattern = null,
        patternMessage = null,
        uppercase = false,
        lowercase = false,
        allowNewlines = false,
    } = options;

    if (typeof value !== 'string') {
        return { error: `${fieldLabel} wajib berupa teks.` };
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return { error: `${fieldLabel} wajib diisi.` };
    }
    if (CONTROL_CHARS_WITHOUT_NEWLINES.test(trimmed) || (!allowNewlines && /[\r\n]/.test(trimmed))) {
        return { error: `${fieldLabel} mengandung karakter kontrol yang tidak diizinkan.` };
    }
    if (trimmed.length < min) {
        return { error: `${fieldLabel} minimal ${min} karakter.` };
    }
    if (trimmed.length > max) {
        return { error: `${fieldLabel} maksimal ${max} karakter.` };
    }

    let normalized = trimmed;
    if (uppercase) normalized = normalized.toUpperCase();
    else if (lowercase) normalized = normalized.toLowerCase();

    if (pattern && !pattern.test(normalized)) {
        return { error: patternMessage || `Format ${fieldLabel} tidak valid.` };
    }
    return { value: normalized };
}

/**
 * Validasi string opsional yang mengembalikan defaultValue bila kosong/null/undefined.
 */
function optionalTrimmedString(value, fieldLabel, options = {}) {
    const { max = 1000, defaultValue = null, allowNewlines = true } = options;
    if (value === undefined || value === null) {
        return { value: defaultValue };
    }
    if (typeof value !== 'string') {
        return { error: `${fieldLabel} harus berupa teks.` };
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return { value: defaultValue };
    }
    if (CONTROL_CHARS_WITHOUT_NEWLINES.test(trimmed) || (!allowNewlines && /[\r\n]/.test(trimmed))) {
        return { error: `${fieldLabel} mengandung karakter kontrol yang tidak diizinkan.` };
    }
    if (trimmed.length > max) {
        return { error: `${fieldLabel} maksimal ${max} karakter.` };
    }
    return { value: trimmed };
}

/**
 * Validasi integer positif ketat (menolak boolean, float, NaN, atau string non-angka).
 */
function requirePositiveInt(value, fieldLabel, options = {}) {
    const { min = 1, max = 2147483647 } = options;
    if (typeof value === 'boolean' || value === null || value === undefined || typeof value === 'object') {
        return { error: `${fieldLabel} harus berupa bilangan bulat positif.` };
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!/^\d+$/.test(trimmed)) {
            return { error: `${fieldLabel} harus berupa bilangan bulat positif.` };
        }
        value = Number(trimmed);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        return { error: `${fieldLabel} harus antara ${min} hingga ${max}.` };
    }
    return { value };
}

/**
 * Validasi integer positif opsional.
 */
function optionalPositiveInt(value, fieldLabel, options = {}) {
    const { defaultValue = null } = options;
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        return { value: defaultValue };
    }
    return requirePositiveInt(value, fieldLabel, options);
}

/**
 * Validasi angka terukur (Number.isFinite + rentang min/max + opsional integer).
 */
function requireBoundedNumber(value, fieldLabel, options = {}) {
    const { min = 0, max = 100000000, integer = false, exclusiveMin = false } = options;
    if (typeof value === 'boolean' || value === null || value === undefined || typeof value === 'object') {
        return { error: `${fieldLabel} harus berupa angka yang valid.` };
    }
    let num = value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return { error: `${fieldLabel} wajib diisi angka yang valid.` };
        }
        num = Number(trimmed);
    }
    if (typeof num !== 'number' || !Number.isFinite(num)) {
        return { error: `${fieldLabel} harus berupa angka yang valid.` };
    }
    if (integer && !Number.isInteger(num)) {
        return { error: `${fieldLabel} harus berupa bilangan bulat.` };
    }
    const minOk = exclusiveMin ? num > min : num >= min;
    if (!minOk || num > max) {
        return { error: `${fieldLabel} harus bernilai antara ${min} hingga ${max}.` };
    }
    return { value: num };
}

/**
 * Validasi boolean ketat (`true` atau `false`).
 */
function requireBoolean(value, fieldLabel) {
    if (typeof value !== 'boolean') {
        return { error: `${fieldLabel} harus berupa boolean (true/false).` };
    }
    return { value };
}

/**
 * Validasi nilai terhadap whitelist enum eksplisit.
 */
function requireEnum(value, fieldLabel, allowedValues, options = {}) {
    const { caseInsensitive = false } = options;
    if (typeof value !== 'string') {
        return { error: `${fieldLabel} tidak valid. Gunakan: ${allowedValues.join(', ')}.` };
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return { error: `${fieldLabel} tidak valid. Gunakan: ${allowedValues.join(', ')}.` };
    }
    const match = caseInsensitive
        ? allowedValues.find(item => String(item).toLowerCase() === trimmed.toLowerCase())
        : allowedValues.find(item => item === trimmed);
    if (match === undefined) {
        return { error: `${fieldLabel} tidak valid. Gunakan: ${allowedValues.join(', ')}.` };
    }
    return { value: match };
}

/**
 * Validasi nilai tanggal (ISO string atau Date) menjadi instance Date yang valid.
 */
function requireValidDate(value, fieldLabel) {
    if (typeof value === 'boolean' || value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
        return { error: `${fieldLabel} wajib berupa tanggal yang valid.` };
    }
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        return { error: `${fieldLabel} harus berupa tanggal yang valid.` };
    }
    if (typeof value === 'string' && value.trim().length > 64) {
        return { error: `${fieldLabel} tidak valid.` };
    }
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return { error: `${fieldLabel} tidak valid.` };
    }
    return { value: parsed };
}

/**
 * Validasi struktur objek `rules` pada kode promo.
 */
function validatePromoRulesObject(rules) {
    if (rules === undefined || rules === null) {
        return { value: null };
    }
    const objRes = requirePlainObject(rules, 'rules');
    if (objRes.error) return objRes;

    const clean = {};
    if (rules.min_price !== undefined && rules.min_price !== null && rules.min_price !== '') {
        const res = requireBoundedNumber(rules.min_price, 'rules.min_price', { min: 0, max: 100000000 });
        if (res.error) return res;
        clean.min_price = res.value;
    }
    if (rules.max_discount_amount !== undefined && rules.max_discount_amount !== null && rules.max_discount_amount !== '') {
        const res = requireBoundedNumber(rules.max_discount_amount, 'rules.max_discount_amount', { min: 1, max: 100000000 });
        if (res.error) return res;
        clean.max_discount_amount = res.value;
    }
    if (rules.max_uses_per_user !== undefined && rules.max_uses_per_user !== null && rules.max_uses_per_user !== '') {
        const res = requirePositiveInt(rules.max_uses_per_user, 'rules.max_uses_per_user', { min: 1, max: 10000 });
        if (res.error) return res;
        clean.max_uses_per_user = res.value;
    }
    for (const idListField of ['allowed_game_ids', 'allowed_product_ids']) {
        if (rules[idListField] !== undefined && rules[idListField] !== null) {
            if (!Array.isArray(rules[idListField]) || rules[idListField].length > 500) {
                return { error: `rules.${idListField} harus berupa array maksimal 500 ID.` };
            }
            const parsedIds = [];
            for (const item of rules[idListField]) {
                const idRes = requirePositiveInt(item, `rules.${idListField}`);
                if (idRes.error) return idRes;
                parsedIds.push(idRes.value);
            }
            clean[idListField] = parsedIds;
        }
    }
    return { value: clean };
}

/**
 * Validasi struktur peta harga manual per role (`bronze`, `silver`, `gold`, `partner`).
 */
function validateManualPricesMap(manualPrices, { required = false } = {}) {
    if (manualPrices === undefined || manualPrices === null) {
        return required ? { error: 'manual_prices wajib diisi jika harga manual aktif.' } : { value: {} };
    }
    const objRes = requirePlainObject(manualPrices, 'manual_prices');
    if (objRes.error) return objRes;

    const ALLOWED_ROLES = new Set(['bronze', 'silver', 'gold', 'partner']);
    const clean = {};
    for (const [roleKey, rawPrice] of Object.entries(manualPrices)) {
        const normalizedKey = String(roleKey || '').trim().toLowerCase();
        if (!ALLOWED_ROLES.has(normalizedKey)) {
            return { error: `Role "${roleKey}" pada manual_prices tidak dikenal.` };
        }
        if (rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === '') {
            continue;
        }
        const priceRes = requireBoundedNumber(rawPrice, `manual_prices.${normalizedKey}`, { min: 1, max: 100000000 });
        if (priceRes.error) return priceRes;
        clean[normalizedKey] = priceRes.value;
    }
    return { value: clean };
}

module.exports = {
    getBodyObject,
    requirePlainObject,
    requireString,
    optionalTrimmedString,
    requirePositiveInt,
    optionalPositiveInt,
    requireBoundedNumber,
    requireBoolean,
    requireEnum,
    requireValidDate,
    validatePromoRulesObject,
    validateManualPricesMap,
};
