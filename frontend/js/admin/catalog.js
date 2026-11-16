(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    function populateGameSelectorDropdown(games) {
        const { gameSelectorDropdown } = app.state.els;
        if (!gameSelectorDropdown) return;
        gameSelectorDropdown.innerHTML = '<option value="">-- Silakan Pilih Game --</option>';
        games.forEach(game => {
            const option = document.createElement('option');
            option.value = game.id;
            option.textContent = game.name;
            gameSelectorDropdown.appendChild(option);
        });
    }

    /**
     * Muat seluruh game admin ke state dan isi dropdown pemilih game.
     */
    async function fetchAdminGames() {
        const { apiFetch } = global.MikuShared.api;
        const { gameSelectorDropdown } = app.state.els;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/games`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat data game');
            app.state.allGames = await response.json();
            populateGameSelectorDropdown(app.state.allGames);
        } catch (error) {
            console.error('Error memuat game:', error);
            if (gameSelectorDropdown) {
                gameSelectorDropdown.innerHTML = `<option value="">${error.message}</option>`;
            }
        }
    }

    function displayGameInfo(game) {
        const { gameInfoContainer } = app.state.els;
        if (!gameInfoContainer) return;
        if (!game) {
            gameInfoContainer.innerHTML = '';
            gameInfoContainer.classList.add('hidden');
            return;
        }
        const isStatusChecked = game.status === 'Active' ? 'checked' : '';
        const needsServerChecked = game.needs_server_id ? 'checked' : '';
        gameInfoContainer.classList.remove('hidden');
        gameInfoContainer.innerHTML = `
            <h3>Pengaturan untuk: ${game.name}</h3>
            <div class="game-info-details">
                <p><strong>ID Game:</strong> ${game.id}</p>
                <p><strong>Kategori:</strong> ${game.category}</p>
                <div class="game-info-toggle">
                    <strong>Status Aktif:</strong>
                    <label class="switch">
                        <input type="checkbox" class="game-status-toggle" data-game-id="${game.id}" ${isStatusChecked}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="game-info-toggle">
                    <strong>Perlu Server ID?:</strong>
                    <label class="switch">
                        <input type="checkbox" class="needs-server-toggle" data-game-id="${game.id}" ${needsServerChecked}>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>`;
    }

    /**
     * Muat seluruh produk dan role harga ke state admin.
     */
    async function fetchAdminProducts() {
        const { apiFetch } = global.MikuShared.api;
        const { productsTableBody } = app.state.els;
        if (!productsTableBody) return;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/products`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat data produk');
            app.state.allProducts = await response.json();
            if (app.state.allRoles.length === 0) {
                const rolesResponse = await apiFetch(`${app.ADMIN_API_URL}/roles`, { auth: true, token: app.state.token });
                if (!rolesResponse.ok) throw new Error('Gagal memuat data roles.');
                app.state.allRoles = await rolesResponse.json();
            }
        } catch (error) {
            console.error('Error memuat produk atau roles:', error);
        }
    }

    /**
     * Render tabel produk beserta harga role, toggle status, tombol validasi, dan harga manual.
     */
    function renderProductsForGame(gameId) {
        const { formatRupiah } = global.MikuShared.format;
        const { productsTableBody, validationEditor, productListTitle } = app.state.els;
        if (!productsTableBody) return;
        // Sembunyikan editor lain saat game diganti
        if (validationEditor) validationEditor.classList.add('hidden');
        const manualPriceEditor = document.getElementById('manual-price-editor');
        if (manualPriceEditor) manualPriceEditor.classList.add('hidden');

        const filteredProducts = app.state.allProducts.filter(p => p.game_id == gameId);
        productsTableBody.innerHTML = '';
        const productsTable = document.getElementById('products-table');
        const tableHeaderThead = productsTable.querySelector('thead tr');
        if (!tableHeaderThead) return;

        // Membuat header dasar + kolom baru
        let headerHtml = `<th>Nama Produk</th><th>Harga Pokok</th><th>SKU</th>`;
        const displayRoles = app.state.allRoles.filter(role => app.ADMIN_PRICE_ROLE_ORDER.includes(role.name))
            .sort((a, b) => app.ADMIN_PRICE_ROLE_ORDER.indexOf(a.name) - app.ADMIN_PRICE_ROLE_ORDER.indexOf(b.name));
        displayRoles.forEach(role => {
            headerHtml += `<th>Harga ${role.name}</th>`;
        });
        headerHtml += `<th>Status</th><th>Aksi Validasi</th><th>Harga Manual</th>`; // <-- KOLOM BARU
        tableHeaderThead.innerHTML = headerHtml;

        productListTitle.textContent = `Produk untuk: ${app.state.allGames.find(g => g.id == gameId)?.name || 'Pilih Game'}`;

        if (filteredProducts.length === 0) {
            productsTableBody.innerHTML = `<tr><td colspan="${7 + displayRoles.length}" style="text-align: center;">...</td></tr>`;
            return;
        }

        filteredProducts.forEach(product => {
            const row = document.createElement('tr');
            row.dataset.productId = product.id;
            row.dataset.productName = product.name; // Simpan nama produk
            row.style.cursor = 'pointer'; // Tambah cursor pointer

            let rowHtml = `<td>${product.name}</td><td>${formatRupiah(product.price, { withDecimals: true })}</td><td>${product.provider_sku}</td>`;

            displayRoles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                const formattedRolePrice = formatRupiah(product[rolePriceKey] || 0, { withDecimals: true });
                rowHtml += `<td>${formattedRolePrice}</td>`;
            });

            const isChecked = product.status === 'Active' ? 'checked' : '';
            rowHtml += `<td><label class="switch"><input type="checkbox" class="product-status-toggle" data-product-id="${product.id}" ${isChecked}><span class="slider"></span></label></td>`;
            rowHtml += `<td><button class="edit-btn edit-validation-btn" data-product-id="${product.id}">Atur</button></td>`;
            rowHtml += `<td><button class="edit-btn manual-price-btn" data-product-id="${product.id}" data-product-name="${product.name}">Atur Harga</button></td>`; // <-- TOMBOL BARU

            row.innerHTML = rowHtml;
            productsTableBody.appendChild(row);
        });
    }

    /**
     * Isi dropdown game pada form tambah produk manual.
     */
    async function populateAddProductFormDropdown() {
        const { productGameSelect } = app.state.els;
        if (!productGameSelect) return;
        try {
            const response = await fetch(`${app.PUBLIC_API_URL}/games`);
            if (!response.ok) throw new Error('Gagal memuat daftar game.');
            const games = await response.json();
            productGameSelect.innerHTML = '<option value="">-- Pilih Game --</option>';
            games.forEach(game => {
                const option = document.createElement('option');
                option.value = game.id;
                option.textContent = game.name;
                productGameSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Gagal memuat game:', error);
            productGameSelect.innerHTML = `<option value="">${error.message}</option>`;
        }
    }

    /**
     * Pasang listener pencarian/pemilihan game, toggle game & produk, tambah game, dan sinkronisasi Foxy.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
            gameSearchInput,
            gameSelectorDropdown,
            productListContainer,
            gameInfoContainer,
            productsTableBody,
            addGameForm,
            addProductForm,
            syncForm,
        } = app.state.els;

        if (gameSearchInput) {
            gameSearchInput.addEventListener('input', () => {
                const searchTerm = gameSearchInput.value.toLowerCase();
                const filteredGames = app.state.allGames.filter(game => game.name.toLowerCase().includes(searchTerm));
                populateGameSelectorDropdown(filteredGames);
            });
        }

        if (gameSelectorDropdown) {
            gameSelectorDropdown.addEventListener('change', () => {
                const selectedGameId = gameSelectorDropdown.value;

                // Ambil elemen judulnya
                const productListTitle = document.getElementById('product-list-title');

                if (selectedGameId) {
                    const selectedGame = app.state.allGames.find(g => g.id == selectedGameId);
                    displayGameInfo(selectedGame);
                    renderProductsForGame(selectedGameId);
                    app.validationAndPrices.fetchAndDisplayGameMargins(selectedGameId);

                    // Tampilkan container produk dan SEMBUNYIKAN judulnya
                    productListContainer.classList.remove('hidden');
                    if (productListTitle) {
                        productListTitle.classList.add('hidden');
                    }
                } else {
                    displayGameInfo(null);
                    productListContainer.classList.add('hidden');

                    // Sembunyikan juga form margin jika tidak ada game yang dipilih
                    const marginContainer = document.getElementById('game-margin-container');
                    if (marginContainer) marginContainer.classList.add('hidden');

                    if (productListTitle) {
                        productListTitle.classList.remove('hidden');
                        productListTitle.textContent = 'Pilih Game untuk Melihat Produk';
                    }
                }
            });
        }

        if (gameInfoContainer) {
            gameInfoContainer.addEventListener('change', async (e) => {
                const toggleSwitch = e.target;
                if (toggleSwitch.classList.contains('game-status-toggle') || toggleSwitch.classList.contains('needs-server-toggle')) {
                    const gameId = toggleSwitch.dataset.gameId;
                    const isChecked = toggleSwitch.checked;
                    let endpoint = '';
                    let body = {};
                    if (toggleSwitch.classList.contains('game-status-toggle')) {
                        endpoint = `${app.ADMIN_API_URL}/games/${gameId}/status`;
                        body = { status: isChecked ? 'Active' : 'Inactive' };
                    } else {
                        endpoint = `${app.ADMIN_API_URL}/games/${gameId}/needs-server`;
                        body = { needsServer: isChecked };
                    }
                    toggleSwitch.disabled = true;
                    try {
                        const response = await apiFetch(endpoint, {
                            method: 'PUT',
                            auth: true,
                            token: app.state.token,
                            jsonBody: body
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            toggleSwitch.checked = !isChecked;
                            throw new Error(result.message);
                        }
                        alert(result.message);
                        const gameIndex = app.state.allGames.findIndex(g => g.id == gameId);
                        if (gameIndex > -1) {
                            if (toggleSwitch.classList.contains('game-status-toggle')) {
                                app.state.allGames[gameIndex].status = body.status;
                            } else {
                                app.state.allGames[gameIndex].needs_server_id = body.needsServer;
                            }
                        }
                    } catch (error) {
                        alert(`Error: ${error.message}`);
                    } finally {
                        toggleSwitch.disabled = false;
                    }
                }
            });
        }

        if (productsTableBody) {
            // LISTENER #2: Untuk menangani PERUBAHAN pada toggle status (kode asli Anda, tidak diubah)
            productsTableBody.addEventListener('change', async (e) => {
                // Cek apakah yang berubah adalah toggle status produk
                if (e.target.classList.contains('product-status-toggle')) {
                    const toggleSwitch = e.target;
                    const productId = toggleSwitch.dataset.productId;
                    const newStatus = toggleSwitch.checked ? 'Active' : 'Inactive';
                    toggleSwitch.disabled = true;
                    try {
                        const response = await apiFetch(`${app.ADMIN_API_URL}/products/${productId}/status`, {
                            method: 'PUT',
                            auth: true,
                            token: app.state.token,
                            jsonBody: { status: newStatus }
                        });
                        const result = await response.json();
                        if (!response.ok) {
                            toggleSwitch.checked = !toggleSwitch.checked;
                            throw new Error(result.message);
                        }
                        console.log(`Status produk ${productId} diubah menjadi ${newStatus}`);
                        const productIndex = app.state.allProducts.findIndex(p => p.id == productId);
                        if (productIndex > -1) {
                            app.state.allProducts[productIndex].status = newStatus;
                        }
                    } catch (error) {
                        alert(`Error: ${error.message}`);
                    } finally {
                        toggleSwitch.disabled = false;
                    }
                }
            });
        }

        if (addGameForm) {
            addGameForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const data = {
                    name: document.getElementById('game-name').value,
                    category: document.getElementById('game-category').value,
                    imageUrl: document.getElementById('game-image').value,
                };
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/games`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                    addGameForm.reset();
                    await fetchAdminGames();
                    await populateAddProductFormDropdown();
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });
        }

        if (addProductForm) {
            addProductForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                alert('Fitur ini dinonaktifkan. Gunakan sinkronisasi produk.');
            });
        }

        if (syncForm) {
            syncForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const syncButton = syncForm.querySelector('button');
                const marginInput = document.getElementById('margin-percent');
                const rawMargin = marginInput ? marginInput.value.trim() : '';
                const margin_percent = rawMargin !== '' ? parseFloat(rawMargin) : undefined;
                if (confirm(`Anda yakin ingin sinkronisasi produk dari Foxy? Ini akan menambah/memperbarui produk.`)) {
                    syncButton.disabled = true;
                    syncButton.textContent = 'Mensinkronkan...';
                    try {
                        const response = await apiFetch(`${app.ADMIN_API_URL}/sync-products`, {
                            method: 'POST',
                            auth: true,
                            token: app.state.token,
                            jsonBody: { margin_percent }
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.message);
                        alert(result.message);
                        // Reload data setelah sinkronisasi
                        await fetchAdminGames();
                        await fetchAdminProducts();
                    } catch (error) {
                        alert(`Error: ${error.message}`);
                    } finally {
                        syncButton.disabled = false;
                        syncButton.textContent = 'Sinkronkan Sekarang';
                    }
                }
            });
        }
    }

    app.catalog = {
        fetchAdminGames,
        populateGameSelectorDropdown,
        displayGameInfo,
        fetchAdminProducts,
        renderProductsForGame,
        populateAddProductFormDropdown,
        bindEvents,
    };
})(window);
