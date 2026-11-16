const logger = require('../utils/logger');

const SENSITIVE_AUDIT_KEYS = new Set([
    'password',
    'passwordhash',
    'currentpassword',
    'newpassword',
    'token',
    'resettoken',
    'jwt',
    'apikey',
    'apikeyhash',
    'secret',
    'webhooksecret',
    'h2hwebhooksecret',
    'authorization',
    'xapikey',
    'xcallbacktoken',
    'cookie',
    'setcookie',
]);

function normalizeAuditKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Sanitasi nilai payload audit sebelum diserialisasi ke kolom JSONB agar tidak
 * menyimpan field rahasia maupun menyebabkan error circular reference.
 */
function sanitizeAuditValue(value, seen = new WeakSet()) {
    if (value === undefined) return null;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        return typeof logger.redactSensitiveText === 'function'
            ? logger.redactSensitiveText(value)
            : value;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value !== 'object') {
        return String(value);
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(item => sanitizeAuditValue(item, seen));
    }

    const cleaned = {};
    for (const [rawKey, rawVal] of Object.entries(value)) {
        if (rawVal === undefined) continue;
        if (SENSITIVE_AUDIT_KEYS.has(normalizeAuditKey(rawKey))) {
            cleaned[rawKey] = '[REDACTED]';
        } else {
            cleaned[rawKey] = sanitizeAuditValue(rawVal, seen);
        }
    }
    return typeof logger.redactSensitiveData === 'function'
        ? logger.redactSensitiveData(cleaned)
        : cleaned;
}

/**
 * Ekstrak identitas admin serta metadata request aman (IP & User-Agent terpotong).
 */
function extractRequestAuditMeta(req) {
    if (!req || typeof req !== 'object') {
        return { adminId: null, ipAddress: null, userAgent: null };
    }
    const rawUserId = req.user && req.user.id !== undefined && req.user.id !== null
        ? Number(req.user.id)
        : null;
    const adminId = Number.isInteger(rawUserId) && rawUserId > 0 ? rawUserId : null;

    const rawIp = req.ip || (req.socket && req.socket.remoteAddress) || null;
    const ipAddress = rawIp ? String(rawIp).trim().slice(0, 64) : null;

    const rawUa = req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']).trim() : null;
    const userAgent = rawUa ? rawUa.slice(0, 512) : null;

    return { adminId, ipAddress, userAgent };
}

/**
 * Catat aksi admin ke tabel `admin_audit_logs` secara fail-safe.
 * Kegagalan non-kritis penulisan log dicatat aman dan tidak menggagalkan mutasi utama.
 */
async function recordAdminAuditLog(queryable, entry = {}) {
    if (!queryable || typeof queryable.query !== 'function') {
        return { recorded: false };
    }

    const action = entry && entry.action ? String(entry.action).trim().slice(0, 100) : '';
    const targetType = entry && entry.targetType ? String(entry.targetType).trim().slice(0, 60) : '';
    if (!action || !targetType) {
        return { recorded: false };
    }

    try {
        const meta = extractRequestAuditMeta(entry.req);
        const explicitAdminId = entry.adminId !== undefined && entry.adminId !== null ? Number(entry.adminId) : null;
        const adminId = Number.isInteger(explicitAdminId) && explicitAdminId > 0 ? explicitAdminId : meta.adminId;
        const ipAddress = entry.ipAddress !== undefined ? entry.ipAddress : meta.ipAddress;
        const userAgent = entry.userAgent !== undefined ? entry.userAgent : meta.userAgent;

        const targetId = entry.targetId !== undefined && entry.targetId !== null
            ? String(entry.targetId).trim().slice(0, 120)
            : null;

        const sanitizedBefore = entry.beforeData !== undefined && entry.beforeData !== null
            ? sanitizeAuditValue(entry.beforeData)
            : null;
        const sanitizedAfter = entry.afterData !== undefined && entry.afterData !== null
            ? sanitizeAuditValue(entry.afterData)
            : null;

        const beforeJson = sanitizedBefore !== null ? JSON.stringify(sanitizedBefore) : null;
        const afterJson = sanitizedAfter !== null ? JSON.stringify(sanitizedAfter) : null;

        await queryable.query(
            `INSERT INTO admin_audit_logs
             (admin_id, action, target_type, target_id, before_data, after_data, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                adminId,
                action,
                targetType,
                targetId,
                beforeJson,
                afterJson,
                ipAddress ? String(ipAddress).slice(0, 64) : null,
                userAgent ? String(userAgent).slice(0, 512) : null,
            ]
        );
        return { recorded: true };
    } catch (error) {
        logger.logSafeError(`[audit] Gagal mencatat log aksi ${action}:`, error);
        return { recorded: false, error };
    }
}

module.exports = {
    sanitizeAuditValue,
    extractRequestAuditMeta,
    recordAdminAuditLog,
};
