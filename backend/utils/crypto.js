const crypto = require('crypto');

function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

function timingSafeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
        return false;
    }
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufB, bufB);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function generateInvoiceId(prefix) {
    return `${prefix}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}

function generateProviderTrxId(prefix) {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

module.exports = {
    hashResetToken,
    hashApiKey,
    timingSafeStringEqual,
    generateInvoiceId,
    generateProviderTrxId,
};
