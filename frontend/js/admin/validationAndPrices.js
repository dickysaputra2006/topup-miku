(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    /**
     * Muat daftar game yang mendukung validasi ID dari API publik.
     */
    async function fetchAllValidatableGames() {
        const { validationSelector } = app.state.els;
        // Tambahkan pengecekan di awal fungsi
        if (!validationSelector) {
            return; // Hentikan fungsi jika dropdown tidak ada di halaman ini
        }

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
            // Tambahkan pengecekan di sini juga untuk keamanan
            if (validationSelector) {
                validationSelector.innerHTML = `<option value="">Error!</option>`;
            }
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
        if (!validationEditor) return; // Pengecekan elemen utama

        validationEditor.classList.remove('hidden');
        const config = product.validation_config || {};
        const rules = config.rules || {};

        if (validationSelector) validationSelector.value = (config.enabled !== false && config.validator) ? config.validator : '';
        if (allowedRegionsInput) allowedRegionsInput.value = (rules.allowedRegions || []).join(',');
        if (disallowedRegionsInput) disallowedRegionsInput.value = (rules.disallowedRegions || []).join(',');

        // Pengecekan krusial untuk 'validationRulesContainer'
        if (validationRulesContainer) {
            validationRulesContainer.classList.toggle('hidden', !validationSelector.value);
        }
    }

    /**
     * Muat pengaturan custom margin per game untuk game yang dipilih.
     */
    async function fetchAndDisplayGameMargins(gameId) {
        const { apiFetch } = global.MikuShared.api;
        const marginContainer = document.getElementById('game-margin-container');
        const customMarginToggle = document.getElementById('use-custom-margin-toggle');
        const customMarginFields = document.getElementById('custom-margin-fields');

        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/games/${gameId}/margins`, {
                auth: true,
                token: app.state.token
            });
            if (!response.ok) throw new Error('Gagal memuat margin.');

            const margins = await response.json();

            customMarginToggle.checked = margins.use_custom_margin || false;
            document.getElementById('margin-bronze').value = margins.bronze_margin || '';
            document.getElementById('margin-partner').value = margins.partner_margin || '';
            document.getElementById('margin-silver').value = margins.silver_margin || '';
            document.getElementById('margin-gold').value = margins.gold_margin || '';

            customMarginFields.classList.toggle('hidden', !customMarginToggle.checked);
            marginContainer.classList.remove('hidden');
        } catch (error) {
            console.error(error);
            marginContainer.classList.add('hidden');
        }
    }

    async function fetchAndDisplayManualPrices(productId, productName) {
        const { apiFetch } = global.MikuShared.api;
        app.state.selectedProductIdForPrice = productId;
        const editor = document.getElementById('manual-price-editor');
        const nameDisplay = document.getElementById('manual-price-product-name');
        const toggle = document.getElementById('use-manual-prices-toggle');
        const fieldsContainer = document.getElementById('manual-price-fields');
        const inputsContainer = document.getElementById('manual-price-inputs-container');

        nameDisplay.textContent = productName;
        inputsContainer.innerHTML = '<p>Memuat role...</p>';
        editor.classList.remove('hidden');

        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/products/${productId}/manual-prices`, {
                auth: true,
                token: app.state.token
            });
            if (!response.ok) throw new Error('Gagal memuat data harga manual.');
            const data = await response.json();

            toggle.checked = data.use_manual_prices;
            fieldsContainer.classList.toggle('hidden', !data.use_manual_prices);

            // Generate input fields based on roles
            inputsContainer.innerHTML = '';
            const displayRoles = app.state.allRoles.filter(role => app.ADMIN_PRICE_ROLE_ORDER.includes(role.name))
                .sort((a, b) => app.ADMIN_PRICE_ROLE_ORDER.indexOf(a.name) - app.ADMIN_PRICE_ROLE_ORDER.indexOf(b.name));

            displayRoles.forEach(role => {
                const roleNameLower = role.name.toLowerCase();
                const price = data.manual_prices[roleNameLower] || '';
                const inputGroup = `
                    <label for="manual-price-${roleNameLower}">Harga Jual ${role.name}</label>
                    <input type="number" id="manual-price-${roleNameLower}" data-role-name="${roleNameLower}" value="${price}" placeholder="Harga untuk ${role.name}">
                `;
                inputsContainer.insertAdjacentHTML('beforeend', inputGroup);
            });
        } catch (error) {
            console.error(error);
            editor.classList.add('hidden');
        }
    }

    /**
     * Pasang listener editor validasi (single & bulk), custom game margin, dan harga manual produk.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
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

        if (validationForm && validationSelector) {
            function buildValidationConfig() {
                const validator = validationSelector.value;
                const allowed = allowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                const disallowed = disallowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                if (!validator) return { enabled: false };
                const config = { enabled: true, validator };
                if (allowed.length > 0 || disallowed.length > 0) {
                    config.rules = {};
                    if (allowed.length > 0) config.rules.allowedRegions = allowed;
                    if (disallowed.length > 0) config.rules.disallowedRegions = disallowed;
                }
                return config;
            }

            // Event listener untuk dropdown Tipe Validator
            validationSelector.addEventListener('change', () => {
                validationRulesContainer.classList.toggle('hidden', !validationSelector.value);
            });

            // Event listener untuk tombol "Simpan Pengaturan Validasi"
            validationForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const config = buildValidationConfig();
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/products/${app.state.selectedProductIdForValidation}/validation`, {
                        method: 'PUT',
                        auth: true,
                        token: app.state.token,
                        jsonBody: { validation_config: config }
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert('Pengaturan validasi berhasil disimpan!');
                    const productIndex = app.state.allProducts.findIndex(p => p.id == app.state.selectedProductIdForValidation);
                    if (productIndex > -1) app.state.allProducts[productIndex].validation_config = config;
                } catch (error) { alert(`Error: ${error.message}`); }
            });

            // Event listener untuk tombol "Terapkan ke Semua"
            if (applyToAllBtn) {
                applyToAllBtn.addEventListener('click', async () => {
                    if (!app.state.selectedProductIdForValidation) {
                        alert('Pilih satu produk terlebih dahulu untuk dijadikan acuan.');
                        return;
                    }
                    const selectedGameId = gameSelectorDropdown.value;
                    if (!selectedGameId) {
                        alert('Pilih game dari dropdown di atas.');
                        return;
                    }
                    if (!confirm(`Anda yakin ingin menerapkan pengaturan validasi ini ke SEMUA produk lain di game ini?`)) {
                        return;
                    }

                    const config = buildValidationConfig();

                    const productIdsToUpdate = app.state.allProducts
                        .filter(p => p.game_id == selectedGameId)
                        .map(p => p.id);

                    try {
                        const response = await apiFetch(`${app.ADMIN_API_URL}/products/bulk-validation`, {
                            method: 'PUT',
                            auth: true,
                            token: app.state.token,
                            jsonBody: {
                                productIds: productIdsToUpdate,
                                validation_config: config
                            }
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.message);

                        alert(`Berhasil! Pengaturan validasi telah diterapkan ke ${productIdsToUpdate.length} produk.`);

                        productIdsToUpdate.forEach(id => {
                            const productIndex = app.state.allProducts.findIndex(p => p.id == id);
                            if (productIndex > -1) app.state.allProducts[productIndex].validation_config = config;
                        });
                    } catch (error) {
                        alert(`Error: ${error.message}`);
                    }
                });
            }

            if (validatorSearchInput) {
                validatorSearchInput.addEventListener('input', () => {
                    const searchTerm = validatorSearchInput.value.toLowerCase();
                    const currentSelectedValue = validationSelector.value; // Simpan nilai yang sedang dipilih

                    // Kosongkan dropdown dulu
                    validationSelector.innerHTML = '<option value="">-- Tidak Perlu Validasi --</option>';

                    // Filter dan isi ulang dropdown berdasarkan pencarian
                    const filteredGames = app.state.allValidatableGamesData.filter(game =>
                        game.name && game.name.toLowerCase().includes(searchTerm)
                    );

                    filteredGames.forEach(game => {
                        const option = document.createElement('option');
                        option.value = game.gameCode;
                        option.textContent = game.name;
                        validationSelector.appendChild(option);
                    });

                    // Kembalikan pilihan sebelumnya jika masih ada di daftar hasil filter
                    if (filteredGames.some(g => g.gameCode === currentSelectedValue)) {
                        validationSelector.value = currentSelectedValue;
                    }
                });
            }
        }

        if (productsTableBody) {
            // LISTENER #1: Untuk menangani KLIK pada tombol "Atur"
            productsTableBody.addEventListener('click', (e) => {
                // Cek apakah yang diklik adalah tombol 'Atur Validasi'
                if (e.target.classList.contains('edit-validation-btn')) {
                    const productId = e.target.dataset.productId;
                    const product = app.state.allProducts.find(p => p.id == productId);
                    if (product) {
                        // Panggil fungsi untuk menampilkan editor validasi
                        showValidationEditor(product);
                    }
                }
            });

            // Event listener untuk tombol 'Atur Harga' di tabel
            productsTableBody.addEventListener('click', (e) => {
                if (e.target.classList.contains('manual-price-btn')) {
                    const productId = e.target.dataset.productId;
                    const productName = e.target.dataset.productName;
                    fetchAndDisplayManualPrices(productId, productName);
                }
            });
        }

        if (gameMarginForm) {
            gameMarginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const selectedGameId = document.getElementById('game-selector-dropdown').value;
                if (!selectedGameId) return alert('Pilih game terlebih dahulu.');

                const data = {
                    use_custom_margin: document.getElementById('use-custom-margin-toggle').checked,
                    bronze_margin: document.getElementById('margin-bronze').value || null,
                    partner_margin: document.getElementById('margin-partner').value || null,
                    silver_margin: document.getElementById('margin-silver').value || null,
                    gold_margin: document.getElementById('margin-gold').value || null,
                };

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/games/${selectedGameId}/margins`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });

            // Event listener untuk toggle-nya
            document.getElementById('use-custom-margin-toggle').addEventListener('change', (e) => {
                document.getElementById('custom-margin-fields').classList.toggle('hidden', !e.target.checked);
            });
        }

        // Event listener untuk form harga manual
        if (manualPriceForm) {
            manualPriceForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (!app.state.selectedProductIdForPrice) return alert('Produk belum dipilih.');

                const manual_prices = {};
                document.querySelectorAll('#manual-price-inputs-container input').forEach(input => {
                    if (input.value) {
                        manual_prices[input.dataset.roleName] = parseFloat(input.value);
                    }
                });

                const data = {
                    use_manual_prices: document.getElementById('use-manual-prices-toggle').checked,
                    manual_prices: manual_prices
                };

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/products/${app.state.selectedProductIdForPrice}/manual-prices`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });

            // Event listener untuk toggle-nya
            document.getElementById('use-manual-prices-toggle').addEventListener('change', (e) => {
                document.getElementById('manual-price-fields').classList.toggle('hidden', !e.target.checked);
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
