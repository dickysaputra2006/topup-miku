const axios = require('axios');
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const {
    stripIpDecorations,
    isRestrictedHostname,
    isRestrictedIpForOutbound
} = require('./networkSecurity.js');

const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_MAX_REDIRECTS = 0;
const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const WEBHOOK_SIGNATURE_MAX_AGE_SECONDS = 300;

// Wrapper DNS yang dapat di-mock pada unit test tanpa bergantung ke DNS eksternal.
const webhookDns = {
    lookup: (hostname, options) => dns.promises.lookup(hostname, options)
};

/**
 * Buat custom DNS lookup untuk http/https Agent agar koneksi TCP selalu terikat
 * pada alamat IP tervalidasi dan kebal terhadap DNS rebinding.
 */
function createPinnedLookup(pinnedAddress, pinnedFamily) {
    return (_hostname, options, cb) => {
        const callback = typeof options === 'function' ? options : cb;
        const resolvedFamily = pinnedFamily || net.isIP(pinnedAddress);
        if (options && typeof options === 'object' && options.all) {
            return callback(null, [{ address: pinnedAddress, family: resolvedFamily }]);
        }
        return callback(null, pinnedAddress, resolvedFamily);
    };
}

/**
 * Validasi URL webhook HTTPS dan resolusi seluruh record DNS-nya.
 * Menolak skema non-HTTPS, kredensial dalam URL, hostname internal, serta setiap
 * alamat IP private/loopback/link-local/CGNAT/reserved/IPv4-mapped IPv6.
 */
async function validateWebhookUrl(rawUrl, { dnsLookup } = {}) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
        throw new Error('URL callback tidak valid.');
    }

    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch (_err) {
        throw new Error('URL callback tidak valid.');
    }

    if (parsed.protocol !== 'https:') {
        throw new Error('URL callback harus menggunakan HTTPS.');
    }
    if (parsed.username || parsed.password) {
        throw new Error('URL callback tidak boleh mengandung kredensial.');
    }

    const hostname = stripIpDecorations(parsed.hostname);
    if (isRestrictedHostname(hostname)) {
        throw new Error('Target URL callback mengarah ke alamat yang tidak diizinkan.');
    }

    const literalFamily = net.isIP(hostname);
    if (literalFamily) {
        if (isRestrictedIpForOutbound(hostname)) {
            throw new Error('Target URL callback mengarah ke alamat IP yang tidak diizinkan.');
        }
        return {
            parsed,
            hostname,
            pinnedAddress: hostname,
            pinnedFamily: literalFamily,
            resolvedAddresses: [{ address: hostname, family: literalFamily }]
        };
    }

    const lookupFn = typeof dnsLookup === 'function' ? dnsLookup : webhookDns.lookup;
    let resolved;
    try {
        resolved = await lookupFn(hostname, { all: true });
    } catch (_dnsErr) {
        throw new Error('Domain URL callback tidak dapat diresolusi.');
    }

    const addresses = Array.isArray(resolved) ? resolved : (resolved ? [resolved] : []);
    if (addresses.length === 0) {
        throw new Error('Domain URL callback tidak memiliki alamat IP yang valid.');
    }

    for (const record of addresses) {
        const ip = record && record.address ? String(record.address) : '';
        if (!ip || isRestrictedIpForOutbound(ip)) {
            throw new Error('Target URL callback mengarah ke alamat IP yang tidak diizinkan.');
        }
    }

    const primary = addresses[0];
    return {
        parsed,
        hostname,
        pinnedAddress: primary.address,
        pinnedFamily: primary.family || net.isIP(primary.address),
        resolvedAddresses: addresses
    };
}

/**
 * Buat header webhook standar dengan X-Timestamp (Unix detik) dan X-Signature
 * (HMAC-SHA256 hex atas `${timestamp}.${rawBody}` memakai secret per reseller).
 */
function buildSignedWebhookHeaders(rawBody, secret, timestampSeconds) {
    const ts = timestampSeconds !== undefined && timestampSeconds !== null
        ? String(timestampSeconds)
        : String(Math.floor(Date.now() / 1000));

    const headers = {
        'Content-Type': 'application/json',
        'X-Timestamp': ts
    };

    if (typeof secret === 'string' && secret.length > 0) {
        const signingPayload = `${ts}.${rawBody}`;
        headers['X-Signature'] = crypto
            .createHmac('sha256', secret)
            .update(signingPayload)
            .digest('hex');
    }

    return headers;
}

/**
 * Hilangkan kredensial (userinfo & query/token/secret) sebelum dicetak ke log peringatan.
 */
function redactWebhookCredentials(text) {
    if (!text) return '';
    return String(text)
        .replace(/https?:\/\/[^\s)"']+/gi, (rawUrl) => {
            try {
                const parsed = new URL(rawUrl);
                return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
            } catch (_e) {
                return '[REDACTED_URL]';
            }
        })
        .replace(/\b(api[_-]?key|authorization|password|token|secret|signature)=?([^\s,&)]*)/gi, '$1=[REDACTED]');
}

/**
 * Format alasan kegagalan/penolakan webhook secara aman untuk warning log.
 */
function formatSafeWebhookReason(error) {
    if (!error) return 'Unknown webhook error';
    const parts = [];
    if (error.response && error.response.status) {
        parts.push(`HTTP ${error.response.status}`);
    } else if (error.code) {
        parts.push(String(error.code));
    }
    if (error.message) {
        const cleanMsg = redactWebhookCredentials(error.message).slice(0, 200);
        if (cleanMsg) parts.push(cleanMsg);
    }
    return parts.join(' - ') || 'Webhook delivery failed';
}

/**
 * Pastikan reseller memiliki h2h_webhook_secret; jika NULL/kosong, buat dan simpan
 * secara lazy & atomik agar header X-Signature selalu tersedia saat mengirim webhook.
 */
async function ensureUserWebhookSecret(dbPool, userId, existingSecret = null) {
    if (typeof existingSecret === 'string' && existingSecret.length > 0) {
        return existingSecret;
    }
    if (!dbPool || !userId) return null;

    const candidate = crypto.randomBytes(32).toString('hex');
    const result = await dbPool.query(
        `UPDATE users
         SET h2h_webhook_secret = COALESCE(NULLIF(h2h_webhook_secret, ''), $1)
         WHERE id = $2
         RETURNING h2h_webhook_secret`,
        [candidate, userId]
    );
    const saved = result && result.rows && result.rows[0] && result.rows[0].h2h_webhook_secret;
    return saved || candidate;
}

/**
 * Bangun konfigurasi axios yang menonaktifkan redirect (maxRedirects: 0), membatasi
 * ukuran body/respons serta timeout, dan memasang IP-pinned agent jika tersedia.
 */
function buildAxiosWebhookConfig({ headers, pinnedAddress, pinnedFamily, timeoutMs } = {}) {
    const parsedTimeout = Number(timeoutMs);
    const effectiveTimeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? Math.min(parsedTimeout, WEBHOOK_TIMEOUT_MS)
        : WEBHOOK_TIMEOUT_MS;

    const config = {
        headers: headers || { 'Content-Type': 'application/json' },
        timeout: effectiveTimeout,
        maxRedirects: WEBHOOK_MAX_REDIRECTS,
        maxContentLength: WEBHOOK_MAX_RESPONSE_BYTES,
        maxBodyLength: WEBHOOK_MAX_BODY_BYTES,
        validateStatus: (status) => status >= 200 && status < 300
    };

    if (pinnedAddress) {
        const pinnedLookup = createPinnedLookup(pinnedAddress, pinnedFamily);
        config.httpAgent = new http.Agent({ keepAlive: false, lookup: pinnedLookup });
        config.httpsAgent = new https.Agent({ keepAlive: false, lookup: pinnedLookup });
    }

    return config;
}

/**
 * Kirim webhook H2H secara aman terhadap SSRF/DNS rebinding/redirect dan bertanda tangan HMAC-SHA256.
 */
async function sendH2HWebhook({ url, payload, secret, timeoutMs, dnsLookup, timestampSeconds } = {}) {
    const validated = await validateWebhookUrl(url, { dnsLookup });
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers = buildSignedWebhookHeaders(rawBody, secret, timestampSeconds);
    const config = buildAxiosWebhookConfig({
        headers,
        pinnedAddress: validated.pinnedAddress,
        pinnedFamily: validated.pinnedFamily,
        timeoutMs
    });

    return axios.post(validated.parsed.toString(), rawBody, config);
}

/**
 * Kirim webhook H2H secara aman dan non-throwing:
 * - Lazy-seed h2h_webhook_secret bila reseller lama belum memilikinya.
 * - Validasi SSRF + DNS pinning + maxRedirects: 0.
 * - Jika ditolak/gagal, catat console.warn (invoice + alasan aman) tanpa melempar error.
 */
async function dispatchSafeH2HWebhook({
    dbPool,
    userId,
    callbackUrl,
    webhookSecret,
    payload,
    invoiceId,
    source = 'webhook',
    dnsLookup
} = {}) {
    if (!callbackUrl) {
        return { sent: false, skipped: true };
    }

    const safeInvoice = invoiceId || (payload && payload.invoice_id) || 'UNKNOWN';
    try {
        const activeSecret = await ensureUserWebhookSecret(dbPool, userId, webhookSecret);
        await sendH2HWebhook({
            url: callbackUrl,
            payload,
            secret: activeSecret,
            timeoutMs: WEBHOOK_TIMEOUT_MS,
            dnsLookup
        });
        return { sent: true, secret: activeSecret };
    } catch (err) {
        const safeReason = formatSafeWebhookReason(err);
        console.warn(`[${source}] Webhook ditolak/gagal untuk invoice ${safeInvoice}: ${safeReason}`);
        return { sent: false, reason: safeReason };
    }
}

module.exports = {
    WEBHOOK_TIMEOUT_MS,
    WEBHOOK_MAX_REDIRECTS,
    WEBHOOK_MAX_RESPONSE_BYTES,
    WEBHOOK_MAX_BODY_BYTES,
    WEBHOOK_SIGNATURE_MAX_AGE_SECONDS,
    webhookDns,
    createPinnedLookup,
    validateWebhookUrl,
    buildSignedWebhookHeaders,
    redactWebhookCredentials,
    formatSafeWebhookReason,
    ensureUserWebhookSecret,
    buildAxiosWebhookConfig,
    sendH2HWebhook,
    dispatchSafeH2HWebhook
};
