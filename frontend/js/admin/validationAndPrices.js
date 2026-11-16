(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    function wireModalClose(modalEl, closeBtnIds) {
        if (!modalEl) return () => {};
        const close = () => modalEl.classList.add('hidden');
        app.registerModalCloser(close);
        closeBtnIds.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.addEventListener('click', close);
        });
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) close();
        });
        return close;
    }

    /**
     * Muat daftar game yang mendukung validasi ID dari API publik.
     */
    async function fetchAllValidatableGames() {
        const { validationSelector } = app.state.els;
        if (!validationSelector) return;

        try {
            const response = await fetch(`${app.PUBLIC_API_URL}/games/validatable`);
            app.state.allValidatableGamesData = await response.json();

            validationSelector.innerHTML = '<option value="">-- Tidak Perlu Validasi --</option>';
            app.state.allValidatableGamesData.forEach(game => {
                if (game.name) {
                    const option = document.createElement('option');
                    option.value = game.gameCode;
                    option.textContent = game.name;
                    validationSelector.appendChild(option);
                }
            });
        } catch (error) {
            console.error('Gagal memuat data game untuk validasi:', error);
            validationSelector.innerHTML = '<option value="">Gagal memuat validator</option>';
        }
    }

    function showValidationEditor(product) {
        const {
            validationEditor,
            validationSelector,
            allowedRegionsInput,
            disallowedRegionsInput,
            validationRulesContainer,
        } = app.state.els;
        app.state.selectedProductIdForValidation = product.id;
        if (!validationEditor) return;

        const titleEl = document.getElementById('validation-modal-title');
        if (titleEl) titleEl.textContent = `Validasi: ${product.name || 'Produk'}`;

        const config = product.validation_config || {};
        const rules = config.rules || {};

        if (validationSelector) validationSelector.value = (config.enabled !== false && config.validator) ? config.validator : '';
        if (allowedRegionsInput) allowedRegionsInput.value = (rules.allowedRegions || []).join(',');
        if (disallowedRegionsInput) disallowedRegionsInput.value = (rules.disallowedRegions || []).join(',');
        if (validationRulesContainer && validationSelector) {
            validationRulesContainer.classList.toggle('hidden', !validationSelector.value);
        }
        validationEditor.classList.remove('hidden');
    }

    /**
     * Muat pengaturan custom margin per game dan buka modal margin khusus game.
     */
    async function fetchAndDisplayGameMargins(gameId) {
        const { apiFetch } = global.MikuShared.api;
        const marginContainer = document.getElementById('game-margin-container');
        const customMarginToggle = document.getElementById('use-custom-margin-toggle');
        const customMarginFields = document.getElementById('custom-margin-fields');
        if (!marginContainer || !gameId) return;

        marginContainer.dataset.gameId = String(gameId);
        const game = (app.state.allGames || []).find(g => String(g.id) === String(gameId));
        const titleEl = document.getElementById('game-margin-modal-title');
        if (titleEl) titleEl.textContent = game ? `Margin Khusus: ${game.name}` : 'Margin Khusus Game';

        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/games/${gameId}/margins`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat margin game.');
            const margins = await response.json();

            if (customMarginToggle) customMarginToggle.checked = Boolean(margins.use_custom_margin);
            document.getElementById('margin-bronze').value = margins.bronze_margin || '';
            document.getElementById('margin-partner').value = margins.partner_margin || '';
            document.getElementById('margin-silver').value = margins.silver_margin || '';
            document.getElementById('margin-gold').value = margins.gold_margin || '';

            if (customMarginFields && customMarginToggle) {
                customMarginFields.classList.toggle('hidden', !customMarginToggle.checked);
            }
            marginContainer.classList.remove('hidden');
        } catch (error) {
            console.error(error);
            marginContainer.classList.add('hidden');
            app.notify(`Error: ${error.message}`, 'error');
        }
    }

    async function fetchAndDisplayManualPrices(productId, productName) {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        app.state.selectedProductIdForPrice = productId;
        const editor = document.getElementById('manual-price-editor');
        const nameDisplay = document.getElementById('manual-price-product-name');
        const toggle = document.getElementById('use-manual-prices-toggle');
        const fieldsContainer = document.getElementById('manual-price-fields');
        const inputsContainer = document.getElementById('manual-price-inputs-container');
        if (!editor || !inputsContainer) return;

        if (nameDisplay) nameDisplay.textContent = productName || '-';
        inputsContainer.innerHTML = '<div class="ui-state loading">Memuat role...</div>';
        editor.classList.remove('hidden');

        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/products/${productId}/manual-prices`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat data harga manual.');
            const data = await response.json();

            if (toggle) toggle.checked = Boolean(data.use_manual_prices);
            if (fieldsContainer) fieldsContainer.classList.toggle('hidden', !data.use_manual_prices);

            inputsContainer.innerHTML = '';
            const displayRoles = (app.state.allRoles || [])
                .filter(role => app.ADMIN_PRICE_ROLE_ORDER.includes(role.name))
                .sort((a, b) => app.ADMIN_PRICE_ROLE_ORDER.indexOf(a.name) - app.ADMIN_PRICE_ROLE_ORDER.indexOf(b.name));

            displayRoles.forEach(role => {
                const roleNameLower = role.name.toLowerCase();
                const safeRoleLower = escapeHtml(roleNameLower);
                const safeRoleName = escapeHtml(role.name);
                const price = (data.manual_prices && data.manual_prices[roleNameLower] != null) ? data.manual_prices[roleNameLower] : '';
                inputsContainer.insertAdjacentHTML('beforeend', `
                    <div class="admin-modal-field">
                        <label for="manual-price-${safeRoleLower}">Harga Jual ${safeRoleName} (Rp)</label>
                        <input type="number" id="manual-price-${safeRoleLower}" data-role-name="${safeRoleLower}" value="${escapeHtml(price)}" placeholder="Harga untuk ${safeRoleName}">
                    </div>
                `);
            });
        } catch (error) {
            console.error(error);
            editor.classList.add('hidden');
            app.notify(`Error: ${error.message}`, 'error');
        }
    }

    /**
     * Pasang listener modal validasi (single & bulk), custom game margin, dan harga manual produk.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
            validationEditor,
            validationForm,
            validationSelector,
            validationRulesContainer,
            allowedRegionsInput,
            disallowedRegionsInput,
            applyToAllBtn,
            validatorSearchInput,
            gameSelectorDropdown,
            productsTableBody,
            gameMarginForm,
            manualPriceForm,
        } = app.state.els;

        const closeValidationModal = wireModalClose(validationEditor, ['close-validation-modal-btn', 'cancel-validation-btn']);
        const closeGameMarginModal = wireModalClose(document.getElementById('game-margin-container'), ['close-game-margin-modal-btn', 'cancel-game-margin-btn']);
        const closeManualPriceModal = wireModalClose(document.getElementById('manual-price-editor'), ['close-manual-price-modal-btn', 'cancel-manual-price-btn']);

        function buildValidationConfig() {
            const validator = validationSelector ? validationSelector.value : '';
            const allowed = allowedRegionsInput ? allowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];
            const disallowed = disallowedRegionsInput ? disallowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : [];
            if (!validator) return { enabled: false };
            const config = { enabled: true, validator };
            if (allowed.length > 0 || disallowed.length > 0) {
                config.rules = {};
                if (allowed.length > 0) config.rules.allowedRegions = allowed;
                if (disallowed.length > 0) config.rules.disallowedRegions = disallowed;
            }
            return config;
        }

        if (validationForm && validationSelector) {
            validationSelector.addEventListener('change', () => {
                if (validationRulesContainer) validationRulesContainer.classList.toggle('hidden', !validationSelector.value);
            });

            validationForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const config = buildValidationConfig();
                const saveBtn = document.getElementById('save-validation-btn');
                if (saveBtn) saveBtn.disabled = true;
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/products/${app.state.selectedProductIdForValidation}/validation`, {
                        method: 'PUT', auth: true, token: app.state.token, jsonBody: { validation_config: config },
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    const productIndex = app.state.allProducts.findIndex(p => String(p.id) === String(app.state.selectedProductIdForValidation));
                    if (productIndex > -1) app.state.allProducts[productIndex].validation_config = config;
                    closeValidationModal();
                    app.notify('Pengaturan validasi produk berhasil disimpan.', 'success');
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (saveBtn) saveBtn.disabled = false;
                }
            });

            if (applyToAllBtn) {
                applyToAllBtn.addEventListener('click', () => {
                    if (!app.state.selectedProductIdForValidation) {
                        app.notify('Pilih satu produk terlebih dahulu untuk dijadikan acuan.', 'error');
                        return;
                    }
                    const selectedProduct = app.state.allProducts.find(p => String(p.id) === String(app.state.selectedProductIdForValidation));
                    const selectedGameId = (gameSelectorDropdown && gameSelectorDropdown.value) || (selectedProduct && selectedProduct.game_id);
                    if (!selectedGameId) {
                        app.notify('Game produk acuan tidak ditemukan.', 'error');
                        return;
                    }
                    const productIdsToUpdate = app.state.allProducts.filter(p => String(p.game_id) === String(selectedGameId)).map(p => p.id);
                    const gameObj = app.state.allGames.find(g => String(g.id) === String(selectedGameId));
                    const config = buildValidationConfig();

                    app.openConfirmModal({
                        title: 'Terapkan Validasi ke Semua Produk Game?',
                        message: 'Pengaturan validasi aktif akan menimpa semua produk di game terpilih.',
                        details: [
                            { label: 'Game', value: gameObj ? gameObj.name : `#${selectedGameId}` },
                            { label: 'Jumlah Produk Terdampak', value: `${productIdsToUpdate.length} produk` },
                            { label: 'Validator', value: config.enabled ? config.validator : 'Tanpa Validasi' },
                        ],
                        confirmLabel: 'Ya, Terapkan Semua',
                        danger: true,
                        onConfirm: async () => {
                            try {
                                const response = await apiFetch(`${app.ADMIN_API_URL}/products/bulk-validation`, {
                                    method: 'PUT', auth: true, token: app.state.token,
                                    jsonBody: { productIds: productIdsToUpdate, validation_config: config },
                                });
                                const result = await response.json();
                                if (!response.ok) throw new Error(result.message);
                                productIdsToUpdate.forEach(id => {
                                    const idx = app.state.allProducts.findIndex(p => String(p.id) === String(id));
                                    if (idx > -1) app.state.allProducts[idx].validation_config = config;
                                });
                                closeValidationModal();
                                app.notify(`Validasi diterapkan ke ${productIdsToUpdate.length} produk.`, 'success');
                            } catch (error) {
                                app.notify(`Error: ${error.message}`, 'error');
                            }
                        },
                    });
                });
            }

            if (validatorSearchInput) {
                validatorSearchInput.addEventListener('input', () => {
                    const searchTerm = validatorSearchInput.value.toLowerCase();
                    const currentSelectedValue = validationSelector.value;
                    validationSelector.innerHTML = '<option value="">-- Tidak Perlu Validasi --</option>';
                    const filteredGames = app.state.allValidatableGamesData.filter(game => game.name && game.name.toLowerCase().includes(searchTerm));
                    filteredGames.forEach(game => {
                        const option = document.createElement('option');
                        option.value = game.gameCode;
                        option.textContent = game.name;
                        validationSelector.appendChild(option);
                    });
                    if (filteredGames.some(g => g.gameCode === currentSelectedValue)) validationSelector.value = currentSelectedValue;
                });
            }
        }

        if (productsTableBody) {
            productsTableBody.addEventListener('click', (e) => {
                const valBtn = e.target.closest('.edit-validation-btn');
                if (valBtn) {
                    const product = app.state.allProducts.find(p => String(p.id) === String(valBtn.dataset.productId));
                    if (product) showValidationEditor(product);
                    return;
                }
                const priceBtn = e.target.closest('.manual-price-btn');
                if (priceBtn) {
                    fetchAndDisplayManualPrices(priceBtn.dataset.productId, priceBtn.dataset.productName);
                }
            });
        }

        if (gameMarginForm) {
            const customToggle = document.getElementById('use-custom-margin-toggle');
            if (customToggle) {
                customToggle.addEventListener('change', (e) => {
                    const fields = document.getElementById('custom-margin-fields');
                    if (fields) fields.classList.toggle('hidden', !e.target.checked);
                });
            }
            gameMarginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const modalEl = document.getElementById('game-margin-container');
                const selectedGameId = (modalEl && modalEl.dataset.gameId) || (gameSelectorDropdown && gameSelectorDropdown.value);
                if (!selectedGameId) { app.notify('Pilih game terlebih dahulu.', 'error'); return; }
                const saveBtn = document.getElementById('save-game-margin-btn');
                if (saveBtn) saveBtn.disabled = true;
                const data = {
                    use_custom_margin: document.getElementById('use-custom-margin-toggle').checked,
                    bronze_margin: document.getElementById('margin-bronze').value || null,
                    partner_margin: document.getElementById('margin-partner').value || null,
                    silver_margin: document.getElementById('margin-silver').value || null,
                    gold_margin: document.getElementById('margin-gold').value || null,
                };
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/games/${selectedGameId}/margins`, {
                        method: 'POST', auth: true, token: app.state.token, jsonBody: data,
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    closeGameMarginModal();
                    app.notify(result.message || 'Margin khusus game disimpan.', 'success');
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (saveBtn) saveBtn.disabled = false;
                }
            });
        }

        if (manualPriceForm) {
            const manualToggle = document.getElementById('use-manual-prices-toggle');
            if (manualToggle) {
                manualToggle.addEventListener('change', (e) => {
                    const fields = document.getElementById('manual-price-fields');
                    if (fields) fields.classList.toggle('hidden', !e.target.checked);
                });
            }
            manualPriceForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (!app.state.selectedProductIdForPrice) { app.notify('Produk belum dipilih.', 'error'); return; }
                const saveBtn = document.getElementById('save-manual-price-btn');
                if (saveBtn) saveBtn.disabled = true;
                const manual_prices = {};
                document.querySelectorAll('#manual-price-inputs-container input').forEach(input => {
                    if (input.value !== '') manual_prices[input.dataset.roleName] = parseFloat(input.value);
                });
                const data = {
                    use_manual_prices: document.getElementById('use-manual-prices-toggle').checked,
                    manual_prices,
                };
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/products/${app.state.selectedProductIdForPrice}/manual-prices`, {
                        method: 'POST', auth: true, token: app.state.token, jsonBody: data,
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    closeManualPriceModal();
                    app.notify(result.message || 'Harga jual manual disimpan.', 'success');
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (saveBtn) saveBtn.disabled = false;
                }
            });
        }
    }

    app.validationAndPrices = {
        fetchAllValidatableGames,
        showValidationEditor,
        fetchAndDisplayGameMargins,
        fetchAndDisplayManualPrices,
        bindEvents,
    };
})(window);
