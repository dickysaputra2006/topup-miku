(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    app.ADMIN_API_URL = '/api/admin';
    app.PUBLIC_API_URL = '/api';
    app.ADMIN_PRICE_ROLE_ORDER = ['BRONZE', 'PARTNER', 'SILVER', 'GOLD', 'Admin'];

    app.state = {
        token: null,
        allGames: [],
        allProducts: [],
        allRoles: [],
        allPaymentMethods: [],
        allValidatableGamesData: [],
        allDeposits: [],
        pendingDepositCount: 0,
        selectedProductIdForValidation: null,
        selectedProductIdForPrice: null,
        pendingConfirmHandler: null,
        confirmBusy: false,
        modalClosers: [],
        els: {},
    };

    /**
     * Kumpulkan referensi elemen DOM panel admin saat DOMContentLoaded.
     */
    function collectAdminElements() {
        return {
            navLinks: document.querySelectorAll('.admin-nav-link'),
            sections: document.querySelectorAll('.admin-section'),
            sidebar: document.getElementById('admin-sidebar'),
            menuToggleBtn: document.querySelectorAll('#menu-toggle-btn, .menu-toggle-btn'),
            pendingDepositBadge: document.getElementById('pending-deposit-badge'),
            depositPendingSummary: document.getElementById('deposit-pending-summary'),
            validationEditor: document.getElementById('product-validation-editor'),
            validationForm: document.getElementById('validation-config-form'),
            validationSelector: document.getElementById('validation-selector'),
            validationRulesContainer: document.getElementById('validation-rules-container'),
            allowedRegionsInput: document.getElementById('allowed-regions-input'),
            disallowedRegionsInput: document.getElementById('disallowed-regions-input'),
            gameSearchInput: document.getElementById('game-search-input'),
            gameSelectorDropdown: document.getElementById('game-selector-dropdown'),
            gameInfoContainer: document.getElementById('game-info-container'),
            productListContainer: document.getElementById('product-list-container'),
            productsTableBody: document.querySelector('#products-table tbody'),
            productListTitle: document.getElementById('product-list-title'),
            adminDepositsTbody: document.getElementById('admin-deposits-tbody'),
            depositStatusFilter: document.getElementById('deposit-status-filter'),
            refreshDepositsBtn: document.getElementById('refresh-deposits-btn'),
            manualBalanceForm: document.getElementById('manual-balance-form'),
            addBalanceBtn: document.getElementById('add-balance-btn'),
            reduceBalanceBtn: document.getElementById('reduce-balance-btn'),
            addGameForm: document.getElementById('add-game-form'),
            addProductForm: document.getElementById('add-product-form'),
            productGameSelect: document.getElementById('product-game'),
            syncForm: document.getElementById('sync-products-form'),
            marginForm: document.getElementById('margin-form'),
            marginFieldsContainer: document.getElementById('margin-fields-container'),
            applyToAllBtn: document.getElementById('apply-validation-to-all-btn'),
            validatorSearchInput: document.getElementById('validator-search-input'),
            gameMarginForm: document.getElementById('game-margin-form'),
            manualPriceForm: document.getElementById('manual-price-form'),
            addPromoForm: document.getElementById('add-promo-form'),
            promosTableBody: document.querySelector('#promos-table tbody'),
            addFlashSaleForm: document.getElementById('add-flash-sale-form'),
            flashSalesTableBody: document.querySelector('#flash-sales-table tbody'),
            fsProductSelector: document.getElementById('fs-product-selector'),
            fsGameSearch: document.getElementById('fs-game-search'),
            fsGameSelector: document.getElementById('fs-game-selector'),
            fsPriceInfo: document.getElementById('fs-price-info'),
            fsBronzePrice: document.getElementById('fs-bronze-price'),
            paymentMethodForm: document.getElementById('payment-method-form'),
            pmFormTitle: document.getElementById('pm-form-title'),
            pmEditIdInput: document.getElementById('pm-edit-id'),
            pmNameInput: document.getElementById('pm-name'),
            pmCodeInput: document.getElementById('pm-code'),
            pmTypeSelect: document.getElementById('pm-type'),
            pmAccountNumberInput: document.getElementById('pm-account-number'),
            pmAccountNameInput: document.getElementById('pm-account-name'),
            pmQrisUrlInput: document.getElementById('pm-qris-image-url'),
            pmMinAmountInput: document.getElementById('pm-min-amount'),
            pmSortOrderInput: document.getElementById('pm-sort-order'),
            pmInstructionsInput: document.getElementById('pm-instructions'),
            pmIsQrisCheckbox: document.getElementById('pm-is-qris'),
            pmIsActiveCheckbox: document.getElementById('pm-is-active'),
            pmSubmitBtn: document.getElementById('pm-submit-btn'),
            pmCancelEditBtn: document.getElementById('pm-cancel-edit-btn'),
            pmFormStatus: document.getElementById('pm-form-status'),
            adminPaymentMethodsTbody: document.getElementById('admin-payment-methods-tbody'),
            refreshPmBtn: document.getElementById('refresh-pm-btn'),
            adminConfirmModal: document.getElementById('admin-confirm-modal'),
            closeAdminConfirmBtn: document.getElementById('close-admin-confirm-btn'),
            adminConfirmCancelBtn: document.getElementById('admin-confirm-cancel-btn'),
            adminConfirmAcceptBtn: document.getElementById('admin-confirm-accept-btn'),
            adminConfirmTitle: document.getElementById('admin-confirm-title'),
            adminConfirmMessage: document.getElementById('admin-confirm-message'),
            adminConfirmDetails: document.getElementById('admin-confirm-details'),
            rejectDepositModal: document.getElementById('reject-deposit-modal'),
            closeRejectDepositBtn: document.getElementById('close-reject-deposit-btn'),
            cancelRejectDepositBtn: document.getElementById('cancel-reject-deposit-btn'),
            rejectDepositForm: document.getElementById('reject-deposit-form'),
            rejectDepositSummary: document.getElementById('reject-deposit-summary'),
            rejectReasonInput: document.getElementById('reject-reason-input'),
            rejectReasonError: document.getElementById('reject-reason-error'),
            submitRejectDepositBtn: document.getElementById('submit-reject-deposit-btn'),
        };
    }

    /**
     * Tampilkan notifikasi toast non-blocking admin.
     */
    app.notify = function notify(message, variant = 'success') {
        const toast = document.getElementById('toast-notification');
        if (toast) {
            toast.classList.remove('toast-success', 'toast-info');
            if (variant === 'success') toast.classList.add('toast-success');
            else if (variant === 'info') toast.classList.add('toast-info');
            if (global.MikuShared && global.MikuShared.dom) {
                global.MikuShared.dom.showToast(message);
                return;
            }
        }
        console[variant === 'error' ? 'error' : 'log'](message);
    };

    /**
     * Perbarui badge jumlah deposit berstatus Pending pada sidebar admin.
     */
    app.updatePendingDepositBadge = function updatePendingDepositBadge(count) {
        const safeCount = Math.max(0, Number(count) || 0);
        app.state.pendingDepositCount = safeCount;
        const badge = app.state.els.pendingDepositBadge || document.getElementById('pending-deposit-badge');
        if (!badge) return;
        badge.textContent = safeCount > 99 ? '99+' : String(safeCount);
        badge.classList.toggle('hidden', safeCount === 0);
        badge.setAttribute('aria-label', `${safeCount} deposit pending`);
    };

    /**
     * Render daftar key-value ringkasan untuk modal konfirmasi/penolakan admin.
     */
    app.renderModalSummaryRows = function renderModalSummaryRows(containerEl, rows) {
        const { escapeHtml } = global.MikuShared.dom;
        if (!containerEl) return;
        if (!Array.isArray(rows) || rows.length === 0) {
            containerEl.innerHTML = '';
            containerEl.classList.add('hidden');
            return;
        }
        containerEl.innerHTML = rows.map(row => `
            <div class="admin-detail-row">
                <span>${escapeHtml(row.label)}</span>
                <strong>${escapeHtml(row.value)}</strong>
            </div>
        `).join('');
        containerEl.classList.remove('hidden');
    };

    app.closeConfirmModal = function closeConfirmModal(force = false) {
        const { adminConfirmModal, adminConfirmAcceptBtn, adminConfirmCancelBtn } = app.state.els;
        if (!adminConfirmModal || (app.state.confirmBusy && !force)) return;
        app.state.pendingConfirmHandler = null;
        adminConfirmModal.classList.add('hidden');
        if (adminConfirmAcceptBtn) adminConfirmAcceptBtn.disabled = false;
        if (adminConfirmCancelBtn) adminConfirmCancelBtn.disabled = false;
    };

    /**
     * Buka modal konfirmasi eksplisit sebelum aksi destruktif/finansial/sinkronisasi.
     */
    app.openConfirmModal = function openConfirmModal({ title, message, details = [], confirmLabel = 'Lanjutkan', danger = false, onConfirm }) {
        const {
            adminConfirmModal,
            adminConfirmTitle,
            adminConfirmMessage,
            adminConfirmDetails,
            adminConfirmAcceptBtn,
            adminConfirmCancelBtn,
        } = app.state.els;
        if (!adminConfirmModal || !adminConfirmAcceptBtn) return;
        if (adminConfirmTitle) adminConfirmTitle.textContent = title || 'Konfirmasi Aksi';
        if (adminConfirmMessage) adminConfirmMessage.textContent = message || '';
        app.renderModalSummaryRows(adminConfirmDetails, details);
        adminConfirmAcceptBtn.textContent = confirmLabel;
        adminConfirmAcceptBtn.classList.toggle('admin-btn-danger', Boolean(danger));
        adminConfirmAcceptBtn.classList.toggle('admin-btn-primary', !danger);
        adminConfirmAcceptBtn.disabled = false;
        if (adminConfirmCancelBtn) adminConfirmCancelBtn.disabled = false;
        app.state.pendingConfirmHandler = onConfirm;
        adminConfirmModal.classList.remove('hidden');
        if (danger && adminConfirmCancelBtn && typeof adminConfirmCancelBtn.focus === 'function') {
            adminConfirmCancelBtn.focus();
        } else if (typeof adminConfirmAcceptBtn.focus === 'function') {
            adminConfirmAcceptBtn.focus();
        }
    };

    app.registerModalCloser = function registerModalCloser(fn) {
        if (typeof fn === 'function') app.state.modalClosers.push(fn);
    };

    function bindConfirmAndEscapeEvents() {
        const {
            adminConfirmModal,
            closeAdminConfirmBtn,
            adminConfirmCancelBtn,
            adminConfirmAcceptBtn,
        } = app.state.els;

        if (closeAdminConfirmBtn) closeAdminConfirmBtn.addEventListener('click', () => app.closeConfirmModal());
        if (adminConfirmCancelBtn) adminConfirmCancelBtn.addEventListener('click', () => app.closeConfirmModal());
        if (adminConfirmModal) {
            adminConfirmModal.addEventListener('click', (e) => {
                if (e.target === adminConfirmModal) app.closeConfirmModal();
            });
        }
        if (adminConfirmAcceptBtn) {
            adminConfirmAcceptBtn.addEventListener('click', async () => {
                if (!app.state.pendingConfirmHandler || app.state.confirmBusy) return;
                const action = app.state.pendingConfirmHandler;
                app.state.confirmBusy = true;
                adminConfirmAcceptBtn.disabled = true;
                if (adminConfirmCancelBtn) adminConfirmCancelBtn.disabled = true;
                try {
                    await action();
                } finally {
                    app.state.confirmBusy = false;
                    app.closeConfirmModal(true);
                }
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            app.closeConfirmModal();
            app.state.modalClosers.forEach(closeFn => closeFn());
        });
    }

    function bindSidebarAndNavigation() {
        const { menuToggleBtn, sidebar, navLinks, sections } = app.state.els;

        function setSidebarOpen(open) {
            if (!sidebar) return;
            sidebar.classList.toggle('active', Boolean(open));
            document.body.classList.toggle('menu-open', Boolean(open));
            menuToggleBtn.forEach(btn => btn.setAttribute('aria-expanded', open ? 'true' : 'false'));
        }

        app.registerModalCloser(() => setSidebarOpen(false));

        if (menuToggleBtn.length > 0 && sidebar) {
            menuToggleBtn.forEach(btn => btn.addEventListener('click', () => {
                setSidebarOpen(!sidebar.classList.contains('active'));
            }));
        }

        document.addEventListener('click', (e) => {
            if (!sidebar || !sidebar.classList.contains('active')) return;
            if (e.target.closest('#admin-sidebar') || e.target.closest('#menu-toggle-btn')) return;
            setSidebarOpen(false);
        });

        if (navLinks.length > 0 && sections.length > 0) {
            navLinks.forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const targetId = link.dataset.target;
                    navLinks.forEach(navLink => navLink.classList.remove('active'));
                    link.classList.add('active');
                    sections.forEach(section => {
                        section.classList.toggle('hidden', section.id !== targetId);
                    });

                    if (targetId === 'promo') app.promosAndFlashSales.fetchAndDisplayPromos();
                    if (targetId === 'flash-sale') {
                        app.promosAndFlashSales.populateFlashSaleGameSelector(app.state.allGames);
                        app.promosAndFlashSales.fetchAndDisplayFlashSales();
                    }
                    if (targetId === 'deposit') app.deposits.fetchAdminDeposits();
                    if (targetId === 'payment-methods') app.paymentMethods.fetchAdminPaymentMethods();
                    if (targetId === 'transaksi') app.transactionsAndRoles.fetchAdminTransactions();

                    if (global.innerWidth <= 768) setSidebarOpen(false);
                });
            });
        }
    }

    async function initAdminPage() {
        await app.validationAndPrices.fetchAllValidatableGames();
        await app.catalog.fetchAdminGames();
        await app.catalog.fetchAdminProducts();
        await app.deposits.fetchAdminDeposits();
        await app.paymentMethods.fetchAdminPaymentMethods();
        await app.catalog.populateAddProductFormDropdown();
        await app.transactionsAndRoles.fetchAndDisplayMargins();
        await app.promosAndFlashSales.fetchAndDisplayPromos();
        await app.promosAndFlashSales.fetchAndDisplayFlashSales();
        await app.transactionsAndRoles.fetchAdminTransactions();
    }

    document.addEventListener('DOMContentLoaded', function () {
        const { requireAuthToken } = global.MikuShared.auth;
        const els = collectAdminElements();
        const token = requireAuthToken('index.html');

        if (!token) return;

        app.state.token = token;
        app.state.els = els;

        bindConfirmAndEscapeEvents();
        bindSidebarAndNavigation();
        app.transactionsAndRoles.bindEvents();
        app.validationAndPrices.bindEvents();
        app.promosAndFlashSales.bindEvents();
        app.catalog.bindEvents();
        app.deposits.bindEvents();
        app.paymentMethods.bindEvents();

        initAdminPage();
    });
})(window);
