(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    app.AUTH_API_URL = '/api/auth';
    app.PUBLIC_API_URL = '/api';

    app.state = {
        gameId: null,
        token: null,
        fsProductId: null,
        fsPrice: null,
        selectedProductId: null,
        appliedPromo: null,
        currentDiscountAmount: 0,
        isValidationSuccess: false,
        isOrderSubmitting: false,
        lastValidationErrorMessage: '',
        orderIdempotencyKey: null,
        lastOrderAttemptSignature: null,
        els: {},
    };

    function collectProductElements() {
        return {
            validationResultEl: document.getElementById('validation-result'),
            gameImageEl: document.getElementById('game-image'),
            gameNameEl: document.getElementById('game-name'),
            productListContainer: document.getElementById('product-list-container'),
            orderForm: document.getElementById('order-form'),
            totalPriceEl: document.getElementById('total-price'),
            submitOrderBtn: document.getElementById('submit-order-btn'),
            targetGameIdInput: document.getElementById('target-game-id'),
            serverInputContainer: document.getElementById('server-input-container'),
            userAuthButton: document.getElementById('user-auth-button'),
            promoCodeInput: document.getElementById('promo-code-input'),
            applyPromoBtn: document.getElementById('apply-promo-btn'),
            promoResultEl: document.getElementById('promo-result'),
            modal: document.getElementById('auth-modal'),
            closeModalButton: document.getElementById('close-modal-btn'),
            loginContainer: document.getElementById('login-container'),
            registerContainer: document.getElementById('register-container'),
            showRegisterLink: document.getElementById('show-register'),
            showLoginLink: document.getElementById('show-login'),
            loginForm: document.getElementById('login-form'),
            registerForm: document.getElementById('register-form'),
        };
    }

    /**
     * Susun payload order saat ini untuk dikirim ke API order maupun hash signature idempotency.
     */
    app.buildCurrentOrderPayload = function buildCurrentOrderPayload() {
        const { promoCodeInput } = app.state.els;
        const targetGameId = document.getElementById('target-game-id').value;
        const targetServerIdEl = document.getElementById('target-server-id');
        const targetServerId = targetServerIdEl ? targetServerIdEl.value : null;
        return {
            productId: app.state.selectedProductId,
            targetGameId,
            targetServerId,
            promoCode: (app.state.appliedPromo && app.state.appliedPromo.valid) ? promoCodeInput.value : null,
        };
    };

    /**
     * Rotasi Idempotency-Key hanya ketika payload order berubah setelah percobaan submit sebelumnya.
     */
    app.ensureOrderIdempotencyKey = function ensureOrderIdempotencyKey(payload) {
        const { generateIdempotencyKey } = global.MikuShared.api;
        const signature = JSON.stringify(payload);
        // Rotasi key hanya jika payload berubah setelah percobaan submit sebelumnya
        if (app.state.lastOrderAttemptSignature !== null && app.state.lastOrderAttemptSignature !== signature) {
            app.state.orderIdempotencyKey = generateIdempotencyKey();
            app.state.lastOrderAttemptSignature = null;
        }
        return signature;
    };

    app.showModal = function showModal() {
        const { modal } = app.state.els;
        if (modal) modal.classList.remove('hidden');
    };

    app.hideModal = function hideModal() {
        const { modal } = app.state.els;
        if (modal) modal.classList.add('hidden');
    };

    async function updateAuthButtonOnProductPage() {
        const { clearAuthToken } = global.MikuShared.auth;
        const { apiFetch } = global.MikuShared.api;
        const { userAuthButton } = app.state.els;
        if (!userAuthButton) return;

        // Cek jika pengguna sudah login (ada token)
        if (app.state.token) {
            try {
                // Ambil data profil pengguna dari server
                const response = await apiFetch(`${app.PUBLIC_API_URL}/user/profile`, {
                    auth: true,
                    token: app.state.token,
                });

                if (!response.ok) throw new Error('Sesi tidak valid.');

                const user = await response.json();

                // Ubah tombol menjadi nama pengguna dan arahkan ke dashboard
                userAuthButton.innerHTML = `<i class="fas fa-user-circle"></i> ${user.username}`;
                userAuthButton.href = 'dashboard.html';
                userAuthButton.onclick = null; // Hapus fungsi klik lama
            } catch (error) {
                // Jika token tidak valid/error, kembali ke state "Masuk"
                clearAuthToken();
                userAuthButton.textContent = 'Masuk';
                userAuthButton.href = '#';
                userAuthButton.onclick = (e) => {
                    e.preventDefault();
                    app.showModal();
                };
            }
        } else {
            // Jika tidak ada token (belum login)
            userAuthButton.textContent = 'Masuk';
            userAuthButton.href = '#';
            userAuthButton.onclick = (e) => {
                e.preventDefault();
                app.showModal(); // Panggil fungsi untuk menampilkan modal login
            };
        }
    }

    function bindAuthEvents() {
        const { setAuthToken } = global.MikuShared.auth;
        const {
            closeModalButton,
            showRegisterLink,
            showLoginLink,
            loginContainer,
            registerContainer,
            loginForm,
            registerForm,
        } = app.state.els;

        if (closeModalButton) closeModalButton.addEventListener('click', app.hideModal);

        if (showRegisterLink) {
            showRegisterLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (loginContainer && registerContainer) {
                    loginContainer.classList.add('hidden');
                    registerContainer.classList.remove('hidden');
                }
            });
        }
        if (showLoginLink) {
            showLoginLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (loginContainer && registerContainer) {
                    registerContainer.classList.add('hidden');
                    loginContainer.classList.remove('hidden');
                }
            });
        }

        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const data = {
                    username: loginForm.querySelector('input[name="username"]').value,
                    password: loginForm.querySelector('input[name="password"]').value,
                };
                try {
                    // Menggunakan AUTH_API_URL untuk login
                    const response = await fetch(`${app.AUTH_API_URL}/login`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data),
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    setAuthToken(result.token);
                    alert(result.message);
                    window.location.reload();
                } catch (error) {
                    alert(`Error Login: ${error.message}`);
                }
            });
        }

        if (registerForm) {
            registerForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const passwordInput = registerForm.querySelector('input[name="password"]');
                const confirmPasswordInput = registerForm.querySelector('input[name="confirmPassword"]');
                if (passwordInput.value !== confirmPasswordInput.value) {
                    alert('Password dan Konfirmasi Password tidak cocok!');
                    confirmPasswordInput.value = '';
                    confirmPasswordInput.focus();
                    return;
                }
                // Phase 2B: baca countryCode
                const countryCodeEl = registerForm.querySelector('select[name="countryCode"]');
                const countryCode = countryCodeEl ? countryCodeEl.value : '+62';
                const data = {
                    fullName: registerForm.querySelector('input[name="fullName"]').value,
                    username: registerForm.querySelector('input[name="username"]').value,
                    email: registerForm.querySelector('input[name="email"]').value,
                    countryCode: countryCode,
                    nomorWa: registerForm.querySelector('input[name="nomorWa"]').value,
                    password: passwordInput.value,
                };
                try {
                    // Menggunakan AUTH_API_URL untuk register
                    const response = await fetch(`${app.AUTH_API_URL}/register`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data),
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                    registerForm.reset();
                    if (showLoginLink) showLoginLink.click();
                } catch (error) {
                    alert(`Error Registrasi: ${error.message}`);
                }
            });
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        const { setupPasswordToggles } = global.MikuShared.dom;
        const { getAuthToken } = global.MikuShared.auth;
        const { generateIdempotencyKey } = global.MikuShared.api;

        // === Bagian 1: Deklarasi Variabel & Elemen ===
        const params = new URLSearchParams(window.location.search);
        const gameId = params.get('gameId');
        const token = getAuthToken();

        if (!gameId) {
            document.querySelector('main').innerHTML = '<h1 style="text-align:center;">Game tidak ditemukan. Silakan kembali ke halaman utama.</h1>';
            return;
        }

        app.state.gameId = gameId;
        app.state.token = token;
        app.state.fsProductId = params.get('fsProductId');
        app.state.fsPrice = params.get('fsPrice');
        app.state.orderIdempotencyKey = generateIdempotencyKey();
        app.state.els = collectProductElements();

        bindAuthEvents();
        app.checkout.bindEvents();
        setupPasswordToggles();

        // === Bagian 4: Menjalankan Fungsi Awal ===
        app.validation.fetchGameData();
        updateAuthButtonOnProductPage();
        app.validation.setupLiveValidation();
        app.mobileNav.init();
    });
})(window);
