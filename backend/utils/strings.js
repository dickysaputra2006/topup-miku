function normalizeString(value, maxLength = 255) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

/**
 * Normalize a WhatsApp number to E.164 format.
 * Accepts: countryCode (e.g. '+62') + localNumber (e.g. '81234567890' or '081234567890').
 * Returns the normalized string (e.g. '+6281234567890') or null if invalid.
 *
 * Rules:
 *   - Strip spaces, dashes, parentheses from localNumber
 *   - Strip a leading '0' from localNumber (common Indonesian format: 081xxx -> 81xxx)
 *   - Concatenate countryCode + stripped localNumber
 *   - Final result must match E.164 pattern: +[1-3 digit country][6-12 digit local]
 */
function normalizePhone(countryCode, localNumber) {
    if (typeof countryCode !== 'string' || typeof localNumber !== 'string') return null;
    // Sanitize country code: must start with '+' followed by 1-3 digits
    const cc = countryCode.trim().replace(/\s+/g, '');
    if (!/^\+[0-9]{1,3}$/.test(cc)) return null;
    // Sanitize local number: strip formatting chars
    let local = localNumber.trim().replace(/[\s\-().]/g, '');
    // Strip leading '0' (e.g. 0812 -> 812)
    if (local.startsWith('0')) local = local.slice(1);
    // Only digits allowed in local part
    if (!/^[0-9]+$/.test(local)) return null;
    // Reasonable length: 6-12 digits for local part
    if (local.length < 6 || local.length > 12) return null;
    return cc + local;
}

/**
 * Normalize WhatsApp number from profile update payloads to E.164 using normalizePhone.
 * Supports explicit countryCode+localNumber, standalone E.164 (+628...), or Indonesian formats (08.../628.../8...).
 */
function normalizeProfilePhone(rawNomorWa, rawCountryCode) {
    if (typeof rawNomorWa !== 'string') return null;
    if (typeof rawCountryCode === 'string' && rawCountryCode.trim() !== '') {
        return normalizePhone(rawCountryCode, rawNomorWa);
    }

    const stripped = rawNomorWa.trim().replace(/[\s\-().]/g, '');
    if (!stripped) return null;

    if (stripped.startsWith('+')) {
        const knownCodes = ['+62', '+60', '+65', '+63', '+66', '+84', '+1'];
        const matchedCode = knownCodes.find(code => stripped.startsWith(code));
        if (matchedCode) {
            return normalizePhone(matchedCode, stripped.slice(matchedCode.length));
        }
        return /^\+[1-9][0-9]{7,14}$/.test(stripped) ? stripped : null;
    }

    if (/^62[0-9]{8,12}$/.test(stripped)) {
        return normalizePhone('+62', stripped.slice(2));
    }

    return normalizePhone('+62', stripped);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Helper: status label publik
function publicStatusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'success') return 'Berhasil';
    if (s === 'failed') return 'Gagal';
    if (s === 'refunded') return 'Refund';
    if (s === 'partial refund') return 'Perlu Review Admin';
    return 'Pending';
}

// Helper: mask invoice ID — TRX-9A7F3C2B10E84D65A1F9C302 => TRX-9A7F****C302
function maskInvoiceId(invoiceId) {
    if (!invoiceId || typeof invoiceId !== 'string') return invoiceId;
    if (invoiceId.length <= 4) return '****';
    const dashIdx = invoiceId.indexOf('-');
    if (dashIdx !== -1 && dashIdx <= 6) {
        const prefix = invoiceId.slice(0, dashIdx + 1);    // "TRX-" atau "H2H-"
        const suffix = invoiceId.slice(dashIdx + 1);
        if (suffix.length <= 4) return `${prefix}****`;
        if (suffix.length <= 8) return `${prefix}${suffix.slice(0, 2)}****${suffix.slice(-2)}`;
        return `${prefix}${suffix.slice(0, 4)}****${suffix.slice(-4)}`;
    }
    if (invoiceId.length <= 8) return `${invoiceId.slice(0, 2)}****${invoiceId.slice(-2)}`;
    return `${invoiceId.slice(0, 4)}****${invoiceId.slice(-4)}`;
}

/**
 * Mask username untuk leaderboard publik.
 * - Kosong/null: "User***"
 * - Panjang <= 3: huruf pertama + "***"
 * - Panjang > 3: 3 huruf awal + "***" + 2 huruf akhir
 * Email/phone tidak pernah diproses di sini — hanya username.
 */
function maskLeaderboardName(username) {
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
        return 'User***';
    }
    const u = username.trim();
    if (u.length <= 3) {
        return u.charAt(0) + '***';
    }
    return u.slice(0, 3) + '***' + u.slice(-2);
}

/**
 * Tentukan label rank berdasarkan total belanja (IDR).
 */
function leaderboardRankLabel(totalSpent) {
    const s = Number(totalSpent) || 0;
    if (s >= 5000000) return 'Legend';
    if (s >= 2000000) return 'Diamond';
    if (s >= 1000000) return 'Platinum';
    if (s >= 500000)  return 'Gold';
    if (s >= 200000)  return 'Silver';
    return 'Bronze';
}

/**
 * Format angka ke Rupiah untuk summary_text WA-friendly.
 * Tidak digunakan di logika bisnis, hanya presentasi teks.
 */
function formatRupiahBot(amount) {
    return 'Rp ' + Number(amount).toLocaleString('id-ID');
}

const VENDOR_OR_INTERNAL_LEAK_RE = /foxy|pgscode|mobapay|https?:\/\/|econnrefused|etimedout|enotfound|insufficient\s+balance|buy_price|cost_price|provider_price|base_price|provider_response/i;

/**
 * Sanitasi pesan error/status eksternal agar tidak membocorkan nama vendor, URL internal, atau HTML ke pengguna.
 */
function sanitizePublicErrorMessage(message, fallback = 'Terjadi kesalahan saat memproses permintaan.') {
    if (typeof message !== 'string') return fallback;
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > 220) return fallback;
    if (/[\r\n<>]|[\u0000-\u001F\u007F]/.test(trimmed)) return fallback;
    if (VENDOR_OR_INTERNAL_LEAK_RE.test(trimmed)) return fallback;
    return trimmed;
}

/**
 * Sanitasi deskripsi mutasi saldo sebelum ditampilkan ke pengguna/reseller.
 */
function sanitizeBalanceHistoryDescription(description) {
    if (typeof description !== 'string') return description;
    if (!VENDOR_OR_INTERNAL_LEAK_RE.test(description)) return description;
    const invMatch = description.match(/(?:TRX|H2H|INV|DEP)-[A-Za-z0-9_-]+/);
    return invMatch
        ? `Pengembalian dana untuk invoice ${invMatch[0]} karena transaksi gagal diproses`
        : 'Mutasi saldo diproses oleh sistem';
}

module.exports = {
    normalizeString,
    normalizePhone,
    normalizeProfilePhone,
    escapeHtml,
    publicStatusLabel,
    maskInvoiceId,
    maskLeaderboardName,
    leaderboardRankLabel,
    formatRupiahBot,
    sanitizePublicErrorMessage,
    sanitizeBalanceHistoryDescription,
};
