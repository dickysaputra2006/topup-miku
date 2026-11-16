const SENSITIVE_KEY_NAMES = new Set([
    'password',
    'pass',
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
    'xsignature',
    'signature',
    'cookie',
    'setcookie',
    'pgskey',
    'pgsapikey',
    'foxyapikey',
    'foxycallbacksecret',
    'wabotadmintoken',
]);

function normalizeSensitiveKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Redaksi token/kredensial/JWT yang muncul di string URL, query param,
 * header Bearer, maupun pasangan key=value sebelum ditulis ke log.
 */
function redactSensitiveText(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .replace(/([?&](?:token|secret|api[_-]?key|apikey|authorization|password|jwt)=)[^&#\s]*/gi, '$1[REDACTED]')
        .replace(/((?:api[_-]?key|x-api-key|x-callback-token|authorization|password|token|secret|jwt)\s*[:=]\s*)(?:Bearer\s+)?[^\s,&"']+/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]');
}

/**
 * Redaksi rekursif properti sensitif pada objek, array, dan error tanpa
 * memodifikasi objek sumber dan aman terhadap circular reference.
 */
function redactSensitiveData(value, seen = new WeakSet(), depth = 0) {
    if (value === undefined || value === null) return value;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return redactSensitiveText(value);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (typeof value !== 'object') return String(value);
    if (depth > 8) return '[Truncated]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) {
        const safeErr = {
            name: value.name,
            message: redactSensitiveText(value.message || ''),
        };
        if (value.code) safeErr.code = value.code;
        if (value.statusCode) safeErr.statusCode = value.statusCode;
        if (value.response && value.response.status) safeErr.status = value.response.status;
        return safeErr;
    }

    if (Array.isArray(value)) {
        return value.map(item => redactSensitiveData(item, seen, depth + 1));
    }

    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined || typeof item === 'function') continue;
        if (SENSITIVE_KEY_NAMES.has(normalizeSensitiveKey(key))) {
            sanitized[key] = '[REDACTED]';
        } else {
            sanitized[key] = redactSensitiveData(item, seen, depth + 1);
        }
    }
    return sanitized;
}

function safeErrorDetail(error) {
    if (!error) return { message: 'Unknown error' };
    if (typeof error === 'object' && !(error instanceof Error) && !error.message && !error.response) {
        return redactSensitiveData(error);
    }
    const detail = {};
    if (error.code) detail.code = error.code;
    if (error.response && error.response.status) detail.status = error.response.status;
    if (error.message) detail.message = redactSensitiveText(error.message);
    if (!detail.message && !detail.code) return redactSensitiveData(error);
    return detail;
}

function logSafeError(label, error) {
    console.error(label, safeErrorDetail(error));
}

/**
 * Safe summary of Axios/provider error. Never prints Authorization, config.headers,
 * request._header, or full response body. Detects Cloudflare challenge.
 */
function safeAxiosError(error, providerName) {
    const name = providerName || 'Provider';
    if (!error) return { provider: name, message: 'Unknown error' };
    const safe = { provider: name };
    if (error.message) {
        safe.message = redactSensitiveText(error.message);
    }
    if (error.response) {
        safe.status = error.response.status;
        safe.statusText = error.response.statusText;
        if (error.response.config) {
            safe.method = error.response.config.method ? error.response.config.method.toUpperCase() : undefined;
            safe.url = error.response.config.url ? redactSensitiveText(error.response.config.url) : undefined;
        }
        const cfHeader = error.response.headers && error.response.headers['cf-mitigated'];
        const bodyStr = typeof error.response.data === 'string' ? error.response.data : '';
        const isCloudflare = error.response.status === 403 &&
            (cfHeader === 'challenge' || bodyStr.includes('Just a moment'));
        safe.isCloudflareChallenge = isCloudflare;
        safe.responseContentType = error.response.headers && error.response.headers['content-type'];
        if (isCloudflare) safe.note = 'Provider blocked request with Cloudflare challenge';
    } else if (error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'))) {
        safe.note = 'Request timed out';
    } else if (error.code) {
        safe.code = error.code;
    }
    return safe;
}

module.exports = {
    redactSensitiveText,
    redactSensitiveData,
    safeErrorDetail,
    logSafeError,
    safeAxiosError,
};
