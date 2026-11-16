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
        products: [],
        selectedProductId: null,
        selectedProductName: '',
        selectedProductPrice: 0,
        selectedPaymentMethod: 'balance',
        needsServerId: false,
        validatedNickname: '',
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
            gameImageFallbackEl: document.getElementById('game-image-fallback'),
            gameNameEl: document.getElementById('game-name'),
            productListContainer: document.getElementById('product-list-container'),
            orderForm: document.getElementById('order-form'),
            totalPriceEl: document.getElementById('total-price'),
            mobileTotalPriceEl: document.getElementById('mobile-total-price'),
            submitOrderBtn: document.getElementById('submit-order-btn'),
            mobileSubmitOrderBtn: document.getElementById('mobile-submit-order-btn'),
            checkoutStatusHintEl: document.getElementById('checkout-status-hint'),
            targetGameIdInput: document.getElementById('target-game-id'),
            targetGameIdLabelEl: document.getElementById('target-game-id-label'),
            serverInputContainer: document.getElementById('server-input-container'),
            validateIdBtn: document.getElementById('validate-id-btn'),
            paymentMethodList: document.getElementById('payment-method-list'),
            summaryGameEl: document.getElementById('summary-game'),
            summaryTargetEl: document.getElementById('summary-target'),
            summaryIgnEl: document.getElementById('summary-ign'),
            summaryProductEl: document.getElementById('summary-product'),
            summaryMethodEl: document.getElementById('summary-method'),
            summaryDiscountRowEl: document.getElementById('summary-discount-row'),
            summaryDiscountEl: document.getElementById('summary-discount'),
            userAuthButton: document.getElementById('user-auth-button'),
            promoCodeInput: document.getElementById('promo-code-input'),
            applyPromoBtn: document.getElementById('apply-promo-btn'),
            promoResultEl: document.getElementById('promo-result'),
            modal: document.getElementById('auth-modal'),
            closeModalButton: document.getElementById('close-modal-btn'),
            loginContainer: document.getElementById('login-container'),
            registerContainer: document.getElementById('register-container'),
            forgotPasswordContainer: document.getElementById('forgot-password-container'),
            forgotPasswordForm: document.getElementById('forgot-password-form'),
            forgotPasswordLink: document.querySelector('.forgot-password'),
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
        const { promoCodeInput, targetGameIdInput } = app.state.els;
        const targetGameIdEl = targetGameIdInput || document.getElementById('target-game-id');
        const targetGameId = targetGameIdEl ? targetGameIdEl.value : '';
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
        const { escapeHtml } = global.MikuShared.dom;
        const { userAuthButton } = app.state.els;
        if (!userAuthButton) return;

        if (app.state.token) {
            try {
                const response = await apiFetch(`${app.PUBLIC_API_URL}/user/profile`, {
                    auth: true,
                    token: app.state.token,
                });
                if (!response.ok) throw new Error('Sesi tidak valid.');
                const user = await response.json();
                userAuthButton.innerHTML = `<i class="fas fa-user-circle" aria-hidden="true"></i> ${escapeHtml(user.username)}`;
                userAuthButton.href = 'dashboard.html';
                userAuthButton.onclick = null;
            } catch (_) {
                clearAuthToken();
                app.state.token = null;
                userAuthButton.textContent = 'Masuk';
                userAuthButton.href = '#';
                userAuthButton.onclick = (e) => { e.preventDefault(); app.showModal(); };
            }
        } else {
            userAuthButton.textContent = 'Masuk';
            userAuthButton.href = '#';
            userAuthButton.onclick = (e) => { e.preventDefault(); app.showModal(); };
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
            forgotPasswordContainer,
            forgotPasswordForm,
            forgotPasswordLink,
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
        if (forgotPasswordLink && forgotPasswordContainer && loginContainer) {
            forgotPasswordLink.addEventListener('click', (e) => {
                e.preventDefault();
                loginContainer.classList.add('hidden');
                forgotPasswordContainer.classList.remove('hidden');
            });
        }
        document.querySelectorAll('.show-login-from-forgot').forEach((link) => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                if (forgotPasswordContainer && loginContainer) {
                    forgotPasswordContainer.classList.add('hidden');
                    loginContainer.classList.remove('hidden');
                }
            });
        });

        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const data = {
                    username: loginForm.querySelector('input[name="username"]').value,
                    password: loginForm.querySelector('input[name="password"]').value,
                };
                try {
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

        if (forgotPasswordForm) {
            forgotPasswordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = forgotPasswordForm.querySelector('input[name="email"]').value;
                const submitButton = forgotPasswordForm.querySelector('button[type="submit"]');
                if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Mengirim...'; }
                try {
                    const response = await fetch(`${app.AUTH_API_URL}/forgot-password`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email }),
                    });
                    const result = await response.json();
                    alert(result.message);
                    const backLink = document.querySelector('.show-login-from-forgot');
                    if (backLink) backLink.click();
                } catch (_) {
                    alert('Terjadi kesalahan. Silakan coba lagi.');
                } finally {
                    if (submitButton) { submitButton.disabled = false; submitButton.textContent = 'Kirim Link Reset'; }
                    forgotPasswordForm.reset();
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
                const countryCodeEl = registerForm.querySelector('select[name="countryCode"]');
                const data = {
                    fullName: registerForm.querySelector('input[name="fullName"]').value,
                    username: registerForm.querySelector('input[name="username"]').value,
                    email: registerForm.querySelector('input[name="email"]').value,
                    countryCode: countryCodeEl ? countryCodeEl.value : '+62',
                    nomorWa: registerForm.querySelector('input[name="nomorWa"]').value,
                    password: passwordInput.value,
                };
                try {
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

        const params = new URLSearchParams(window.location.search);
        const gameId = params.get('gameId');
        const token = getAuthToken();

        if (!gameId) {
            const mainEl = document.querySelector('main');
            if (mainEl) mainEl.innerHTML = '<div class="ui-state error">Game tidak ditemukan. Silakan kembali ke <a href="index.html">halaman utama</a>.</div>';
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
        app.validation.setupLiveValidation();
        app.validation.fetchGameData();
        updateAuthButtonOnProductPage();
        app.mobileNav.init();
        app.checkout.syncActionState();
    });
})(window);
