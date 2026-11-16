(function (global) {
    'use strict';

    const shared = (global.MikuShared = global.MikuShared || {});
    const AUTH_TOKEN_KEY = 'authToken';
    const LOGOUT_MESSAGE_KEY = 'logoutMessage';

    /**
     * Ambil token autentikasi pengguna saat ini dari localStorage.
     */
    function getAuthToken() {
        return localStorage.getItem(AUTH_TOKEN_KEY);
    }

    /**
     * Simpan token autentikasi pengguna ke localStorage.
     */
    function setAuthToken(token) {
        localStorage.setItem(AUTH_TOKEN_KEY, token);
    }

    /**
     * Hapus token autentikasi dari localStorage dan sessionStorage.
     */
    function clearAuthToken() {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
    }

    /**
     * Wajibkan token ada; jika tidak, arahkan ke halaman login/beranda dan kembalikan null.
     */
    function requireAuthToken(redirectUrl = 'index.html') {
        const token = getAuthToken();
        if (!token) {
            window.location.href = redirectUrl;
            return null;
        }
        return token;
    }

    /**
     * Keluarkan pengguna paksa dengan pesan pada sessionStorage dan arahkan halaman.
     */
    function forceLogout(message, redirectUrl = 'index.html') {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        if (message) {
            sessionStorage.setItem(LOGOUT_MESSAGE_KEY, message);
        }
        window.location.href = redirectUrl;
    }

    /**
     * Ambil dan bersihkan pesan logout sementara dari sessionStorage bila ada.
     */
    function consumeLogoutMessage() {
        const msg = sessionStorage.getItem(LOGOUT_MESSAGE_KEY);
        if (msg) {
            sessionStorage.removeItem(LOGOUT_MESSAGE_KEY);
        }
        return msg;
    }

    shared.auth = {
        AUTH_TOKEN_KEY,
        getAuthToken,
        setAuthToken,
        clearAuthToken,
        requireAuthToken,
        forceLogout,
        consumeLogoutMessage,
    };
})(window);
