(function (global) {
    'use strict';

    const shared = (global.MikuShared = global.MikuShared || {});

    /**
     * Buat UUID v4 kriptografis untuk header Idempotency-Key.
     */
    function generateIdempotencyKey() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            global.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        throw new Error('Browser tidak mendukung generator UUID yang aman.');
    }

    /**
     * Bangun header Authorization Bearer bila token tersedia.
     */
    function getAuthHeaders(extraHeaders = {}, tokenOverride = null) {
        const token = tokenOverride !== null
            ? tokenOverride
            : (shared.auth ? shared.auth.getAuthToken() : localStorage.getItem('authToken'));
        const headers = { ...extraHeaders };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * Wrapper fetch standar dengan dukungan injeksi Authorization dan JSON body opsional.
     */
    function apiFetch(url, options = {}) {
        const {
            auth = false,
            token = null,
            jsonBody,
            headers = {},
            ...fetchOptions
        } = options;

        const mergedHeaders = auth ? getAuthHeaders(headers, token) : { ...headers };
        let body = fetchOptions.body;
        if (jsonBody !== undefined) {
            if (!mergedHeaders['Content-Type']) {
                mergedHeaders['Content-Type'] = 'application/json';
            }
            body = JSON.stringify(jsonBody);
        }

        return fetch(url, {
            ...fetchOptions,
            headers: mergedHeaders,
            ...(body !== undefined ? { body } : {}),
        });
    }

    /**
     * Jalankan request JSON, tangani respons 401 opsional, dan lempar Error bila !response.ok.
     */
    async function apiFetchJson(url, options = {}) {
        const {
            onUnauthorized,
            fallbackError = 'Permintaan gagal diproses.',
            ...requestOptions
        } = options;
        const response = await apiFetch(url, requestOptions);
        if (response.status === 401 && typeof onUnauthorized === 'function') {
            onUnauthorized(response);
            throw new Error('Sesi berakhir.');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error((data && data.message) || fallbackError);
        }
        return data;
    }

    shared.api = {
        generateIdempotencyKey,
        getAuthHeaders,
        apiFetch,
        apiFetchJson,
    };
})(window);
