function redactSensitiveText(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .replace(/([?&](?:token|secret|api[_-]?key|apikey|authorization|password)=)[^&#\s]*/gi, '$1[REDACTED]')
        .replace(/(api[_-]?key|authorization|password|token|secret)=([^\s,&]*)/gi, '$1=[REDACTED]');
}

function safeErrorDetail(error) {
    if (!error) return { message: 'Unknown error' };
    const detail = {};
    if (error.code) detail.code = error.code;
    if (error.response && error.response.status) detail.status = error.response.status;
    if (error.message) detail.message = redactSensitiveText(error.message);
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
    safeErrorDetail,
    logSafeError,
    safeAxiosError,
};
