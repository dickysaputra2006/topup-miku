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
        selectedProductIdForValidation: null,
        selectedProductIdForPrice: null,
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
        };
    }

    function bindSidebarAndNavigation() {
        const { menuToggleBtn, sidebar, navLinks, sections } = app.state.els;

        if (menuToggleBtn.length > 0 && sidebar) {
            menuToggleBtn.forEach(btn => btn.addEventListener('click', () => {
                sidebar.classList.toggle('active');
                document.body.classList.toggle('menu-open');
            }));
        }

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

                    if (targetId === 'promo') {
                        app.promosAndFlashSales.fetchAndDisplayPromos();
                    }
                    if (targetId === 'flash-sale') {
                        app.promosAndFlashSales.populateFlashSaleGameSelector(app.state.allGames);
                        app.promosAndFlashSales.fetchAndDisplayFlashSales();
                    }
                    if (targetId === 'deposit') {
                        app.deposits.fetchAdminDeposits();
                    }
                    if (targetId === 'payment-methods') {
                        app.paymentMethods.fetchAdminPaymentMethods();
                    }
                    if (targetId === 'transaksi') {
                        app.transactionsAndRoles.fetchAdminTransactions();
                    }
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

        if (!token) {
            return;
        }

        app.state.token = token;
        app.state.els = els;

        app.transactionsAndRoles.bindEvents();
        app.validationAndPrices.bindEvents();
        app.promosAndFlashSales.bindEvents();
        bindSidebarAndNavigation();
        app.catalog.bindEvents();
        app.deposits.bindEvents();
        app.paymentMethods.bindEvents();

        initAdminPage();
    });
})(window);
