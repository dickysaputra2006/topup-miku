(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    app.API_URL = '/api/user';
    app.state = {
        token: null,
        apiKeyFetched: false,
        currentHasApiKey: false,
        currentHasWebhookSecret: false,
        sessionApiKey: '',
        sessionWebhookSecret: '',
        showSessionWebhookSecret: false,
        h2hActionBusy: false,
        mutasiLoaded: false,
        transaksiLoaded: false,
        cachedTransactions: [],
        txStatusFilter: 'all',
        depositFormSetup: false,
        activePaymentMethods: [],
        depositIdempotencyKey: null,
        depositAttemptSignature: null,
        pendingConfirmHandler: null,
        profileContact: {
            email: '',
            phone: '',
            showEmail: false,
            showPhone: false,
        },
        els: {},
    };

    /**
     * Ambil elemen DOM utama halaman dashboard sekali saat bootstrap.
     */
    function collectDashboardElements() {
        return {
            sidebar: document.querySelector('.sidebar'),
            menuToggleBtn: document.getElementById('menu-toggle-btn'),
            logoutButton: document.getElementById('logout-button'),
            editProfileBtn: document.querySelector('.edit-btn'),
            editModal: document.getElementById('edit-profile-modal'),
            closeEditModalBtn: document.getElementById('close-edit-modal-btn'),
            editProfileForm: document.getElementById('edit-profile-form'),
            changePasswordForm: document.getElementById('change-password-form'),
            tabLinks: document.querySelectorAll('.tab-link'),
            tabContents: document.querySelectorAll('.tab-content'),
            dashboardNavLinks: document.querySelectorAll('.dashboard-nav-link'),
            dashboardSections: document.querySelectorAll('.dashboard-section'),
            generateApiKeyBtn: document.getElementById('generate-api-key-btn'),
            revokeApiKeyBtn: document.getElementById('revoke-api-key-btn'),
            apiKeyDisplay: document.getElementById('api-key-display'),
            apiKeyStatusBadge: document.getElementById('h2h-apikey-status-badge'),
            webhookSecretDisplay: document.getElementById('webhook-secret-display'),
            webhookStatusBadge: document.getElementById('h2h-webhook-status-badge'),
            rotateWebhookSecretBtn: document.getElementById('rotate-webhook-secret-btn'),
            toggleWebhookSecretBtn: document.getElementById('toggle-webhook-secret-btn'),
            copyWebhookSecretBtn: document.getElementById('copy-webhook-secret-btn'),
            h2hCallbackForm: document.getElementById('h2h-callback-form'),
            h2hCallbackUrlInput: document.getElementById('h2h-callback-url-input'),
            h2hCallbackApiKeyInput: document.getElementById('h2h-callback-apikey-input'),
            h2hCallbackResultEl: document.getElementById('h2h-callback-result'),
            h2hSecretModal: document.getElementById('h2h-secret-modal'),
            closeH2HSecretModalBtn: document.getElementById('close-h2h-secret-modal-btn'),
            h2hAckSecretModalBtn: document.getElementById('h2h-ack-secret-modal-btn'),
            h2hSecretModalTitle: document.getElementById('h2h-secret-modal-title'),
            h2hRevealedPrimaryLabel: document.getElementById('h2h-revealed-primary-label'),
            h2hRevealedPrimaryValue: document.getElementById('h2h-revealed-primary-value'),
            h2hCopyPrimaryBtn: document.getElementById('h2h-copy-primary-btn'),
            h2hRevealedSecondaryGroup: document.getElementById('h2h-revealed-secondary-group'),
            h2hRevealedSecondaryValue: document.getElementById('h2h-revealed-secondary-value'),
            h2hCopySecondaryBtn: document.getElementById('h2h-copy-secondary-btn'),
            h2hConfirmModal: document.getElementById('h2h-confirm-modal'),
            closeH2HConfirmModalBtn: document.getElementById('close-h2h-confirm-modal-btn'),
            h2hConfirmTitle: document.getElementById('h2h-confirm-title'),
            h2hConfirmMessage: document.getElementById('h2h-confirm-message'),
            h2hConfirmCancelBtn: document.getElementById('h2h-confirm-cancel-btn'),
            h2hConfirmAcceptBtn: document.getElementById('h2h-confirm-accept-btn'),
            cekPesananForm: document.getElementById('cek-pesanan-form'),
            hasilCekPesanan: document.getElementById('hasil-cek-pesanan'),
            whitelistIpForm: document.getElementById('whitelist-ip-form'),
            currentIpsList: document.getElementById('current-ips-list'),
        };
    }

    /**
     * Wrapper request JSON terautentikasi ke endpoint /api/user.
     */
    app.requestUserApi = function requestUserApi(path, options = {}) {
        const { forceLogout } = global.MikuShared.auth;
        const { apiFetchJson } = global.MikuShared.api;
        return apiFetchJson(`${app.API_URL}${path}`, {
            ...options,
            auth: true,
            token: app.state.token,
            onUnauthorized: () => forceLogout('Sesi Anda telah berakhir, silakan login kembali.'),
        });
    };

    function setSidebarOpen(sidebar, open) {
        if (!sidebar) return;
        sidebar.classList.toggle('active', open);
        document.body.classList.toggle('menu-open', open);
        const toggleBtn = document.getElementById('menu-toggle-btn');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setupSidebarMenu(sidebar) {
        document.querySelectorAll('#menu-toggle-btn, .menu-toggle-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!sidebar) return;
                setSidebarOpen(sidebar, !sidebar.classList.contains('active'));
            });
        });

        document.addEventListener('click', function (event) {
            if (sidebar && sidebar.classList.contains('active')) {
                if (!sidebar.contains(event.target) && !event.target.closest('#menu-toggle-btn') && !event.target.closest('.menu-toggle-btn')) {
                    setSidebarOpen(sidebar, false);
                }
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && sidebar && sidebar.classList.contains('active')) {
                setSidebarOpen(sidebar, false);
                const toggleBtn = document.getElementById('menu-toggle-btn');
                if (toggleBtn && typeof toggleBtn.focus === 'function') toggleBtn.focus();
            }
        });
    }

    function setupSectionNavigation() {
        const { sidebar, dashboardNavLinks, dashboardSections } = app.state.els;
        const { generateIdempotencyKey } = global.MikuShared.api;

        if (dashboardNavLinks.length > 0 && dashboardSections.length > 0) {
            dashboardNavLinks.forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const targetId = link.dataset.target;
                    if (!targetId) return;

                    if (sidebar && sidebar.classList.contains('active')) {
                        setSidebarOpen(sidebar, false);
                    }

                    dashboardNavLinks.forEach(navLink => navLink.classList.remove('active'));
                    document.querySelectorAll(`.sidebar-nav .dashboard-nav-link[data-target="${targetId}"]`).forEach(navLink => {
                        navLink.classList.add('active');
                    });

                    dashboardSections.forEach(section => {
                        if (section) {
                            section.classList.toggle('hidden', section.id !== targetId);
                        }
                    });

                    window.scrollTo({ top: 0, behavior: 'smooth' });

                    if (targetId === 'integrasi' && !app.state.apiKeyFetched) {
                        app.h2h.loadIntegrasiSectionData();
                    }

                    if (targetId === 'mutasi-saldo' && !app.state.mutasiLoaded) {
                        app.transactions.fetchBalanceHistory();
                    }

                    if (targetId === 'transaksi-tab' && !app.state.transaksiLoaded) {
                        app.transactions.fetchTransactions();
                    }
                    if (targetId === 'deposit-tab') {
                        if (app.state.depositAttemptSignature === null) {
                            app.state.depositIdempotencyKey = generateIdempotencyKey();
                        }
                        app.deposit.setupDepositForm();
                        app.deposit.loadDepositPaymentMethods();
                        app.deposit.loadDepositHistory();
                    }
                });
            });
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        const { setupPasswordToggles } = global.MikuShared.dom;
        const { requireAuthToken } = global.MikuShared.auth;
        const { generateIdempotencyKey } = global.MikuShared.api;

        const sidebar = document.querySelector('.sidebar');
        setupSidebarMenu(sidebar);

        const token = requireAuthToken('index.html');
        if (!token) return;

        app.state.token = token;
        app.state.els = collectDashboardElements();
        app.state.depositIdempotencyKey = generateIdempotencyKey();

        const integrasiSection = document.getElementById('integrasi');
        if (integrasiSection && !integrasiSection.classList.contains('hidden')) {
            app.h2h.loadIntegrasiSectionData();
        }

        setupSectionNavigation();
        app.h2h.bindEvents();
        app.profile.bindEvents();
        app.transactions.bindEvents();

        app.overview.fetchProfileData();
        app.overview.fetchTransactionSummary();
        app.overview.fetchRecentTransactions();

        setupPasswordToggles();
        app.deposit.bindCopyDelegation();
    });
})(window);
