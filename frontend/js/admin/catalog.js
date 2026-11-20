(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});
    const PAGE_SIZE = 25;
    let currentPage = 1;

    function updateCatalogStatsPill() {
        const pill = document.getElementById('catalog-stats-pill');
        if (!pill) return;
        const gamesCount = Array.isArray(app.state.allGames) ? app.state.allGames.length : 0;
        const productsCount = Array.isArray(app.state.allProducts) ? app.state.allProducts.length : 0;
        const activeCount = Array.isArray(app.state.allProducts)
            ? app.state.allProducts.filter(p => p.status === 'Active').length
            : 0;
        pill.textContent = `${gamesCount} Game · ${productsCount} Produk (${activeCount} Aktif)`;
    }

    function populateGameSelectorDropdown(games) {
        const { gameSelectorDropdown } = app.state.els;
        if (!gameSelectorDropdown) return;
        const prevVal = gameSelectorDropdown.value;
        gameSelectorDropdown.innerHTML = '<option value="">Semua Game</option>';
        (games || []).forEach(game => {
            const option = document.createElement('option');
            option.value = game.id;
            option.textContent = game.name;
            gameSelectorDropdown.appendChild(option);
        });
        if (prevVal && (games || []).some(g => String(g.id) === String(prevVal))) {
            gameSelectorDropdown.value = prevVal;
        }
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
            updateCatalogStatsPill();
        } catch (error) {
            console.error('Error memuat game:', error);
            if (gameSelectorDropdown) {
                gameSelectorDropdown.innerHTML = `<option value="">${error.message}</option>`;
            }
        }
    }

    function displayGameInfo(game) {
        const { escapeHtml } = global.MikuShared.dom;
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
            <div class="admin-toolbar">
                <div class="admin-toolbar-heading">
                    <h3>Pengaturan Game: ${escapeHtml(game.name)}</h3>
                </div>
                <button type="button" id="open-game-margin-modal-btn" class="admin-btn-secondary edit-btn-compact" data-game-id="${escapeHtml(game.id)}">
                    <i class="fas fa-percent" aria-hidden="true"></i> Margin Khusus Game
                </button>
            </div>
            <div class="game-info-details">
                <p><strong>ID Game:</strong> <span class="td-mono">${escapeHtml(game.id)}</span></p>
                <p><strong>Kategori:</strong> ${escapeHtml(game.category || '-')}</p>
                <div class="game-info-toggle">
                    <strong>Status Aktif</strong>
                    <label class="switch">
                        <input type="checkbox" class="game-status-toggle" data-game-id="${escapeHtml(game.id)}" ${isStatusChecked}>
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="game-info-toggle">
                    <strong>Perlu Server ID?</strong>
                    <label class="switch">
                        <input type="checkbox" class="needs-server-toggle" data-game-id="${escapeHtml(game.id)}" ${needsServerChecked}>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>`;
    }

    /**
     * Muat seluruh produk dan role harga ke state admin, lalu render tabel table-first.
     */
    async function fetchAdminProducts() {
        const { apiFetch } = global.MikuShared.api;
        const { productsTableBody, gameSelectorDropdown } = app.state.els;
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
            updateCatalogStatsPill();
            const activeGameId = gameSelectorDropdown ? gameSelectorDropdown.value : '';
            renderProductsForGame(activeGameId);
        } catch (error) {
            console.error('Error memuat produk atau roles:', error);
            productsTableBody.innerHTML = `<tr class="table-error-row"><td colspan="7"><div class="ui-state error">Gagal memuat katalog produk.</div></td></tr>`;
        }
    }

    function updateCatalogPaginationUI(totalFiltered, totalPages, startIdx, endIdx) {
        const infoEl = document.getElementById('catalog-page-info');
        const prevBtn = document.getElementById('catalog-prev-btn');
        const nextBtn = document.getElementById('catalog-next-btn');
        if (infoEl) {
            infoEl.textContent = totalFiltered > 0
                ? `Menampilkan ${startIdx + 1}-${endIdx} dari ${totalFiltered} produk (Hal. ${currentPage}/${totalPages})`
                : 'Menampilkan 0 produk';
        }
        if (prevBtn) prevBtn.disabled = currentPage <= 1;
        if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
    }

    /**
     * Render tabel produk table-first dengan filter game, pencarian SKU/nama, status, dan paginasi.
     */
    function renderProductsForGame(gameId = '') {
        const { formatRupiah } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { productsTableBody } = app.state.els;
        if (!productsTableBody) return;

        const productSearch = (document.getElementById('product-search-input')?.value || '').trim().toLowerCase();
        const statusFilter = document.getElementById('product-status-filter')?.value || '';
        const gameMap = new Map((app.state.allGames || []).map(g => [String(g.id), g.name]));

        const filteredProducts = (app.state.allProducts || []).filter(p => {
            if (gameId && String(p.game_id) !== String(gameId)) return false;
            if (statusFilter && p.status !== statusFilter) return false;
            if (productSearch) {
                const hay = `${p.name || ''} ${p.provider_sku || ''} ${p.game_name || gameMap.get(String(p.game_id)) || ''}`.toLowerCase();
                if (!hay.includes(productSearch)) return false;
            }
            return true;
        });

        const productsTable = document.getElementById('products-table');
        const tableHeaderThead = productsTable ? productsTable.querySelector('thead tr') : null;
        const displayRoles = (app.state.allRoles || [])
            .filter(role => app.ADMIN_PRICE_ROLE_ORDER.includes(role.name))
            .sort((a, b) => app.ADMIN_PRICE_ROLE_ORDER.indexOf(a.name) - app.ADMIN_PRICE_ROLE_ORDER.indexOf(b.name));

        if (tableHeaderThead) {
            let headerHtml = '<th>Game</th><th>Produk</th><th class="td-numeric">Modal</th><th>SKU</th>';
            displayRoles.forEach(role => { headerHtml += `<th class="td-numeric">${escapeHtml(role.name)}</th>`; });
            headerHtml += '<th>Status</th><th>Validasi</th><th>Manual</th>';
            tableHeaderThead.innerHTML = headerHtml;
        }

        const totalFiltered = filteredProducts.length;
        const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        const startIdx = (currentPage - 1) * PAGE_SIZE;
        const pageItems = filteredProducts.slice(startIdx, startIdx + PAGE_SIZE);
        updateCatalogPaginationUI(totalFiltered, totalPages, startIdx, Math.min(startIdx + pageItems.length, totalFiltered));

        productsTableBody.innerHTML = '';
        if (pageItems.length === 0) {
            const colSpan = 7 + displayRoles.length;
            productsTableBody.innerHTML = `<tr class="table-empty-row"><td colspan="${colSpan}"><div class="ui-state empty">Tidak ada produk yang cocok dengan filter saat ini.</div></td></tr>`;
            return;
        }

        pageItems.forEach(product => {
            const row = document.createElement('tr');
            row.dataset.productId = product.id;
            const gameName = product.game_name || gameMap.get(String(product.game_id)) || '-';
            let rowHtml = `
                <td><span class="cell-truncate" title="${escapeHtml(gameName)}">${escapeHtml(gameName)}</span></td>
                <td><span class="cell-truncate" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</span></td>
                <td class="td-numeric">${escapeHtml(formatRupiah(product.price, { withDecimals: true }))}</td>
                <td class="td-mono">${escapeHtml(product.provider_sku)}</td>
            `;
            displayRoles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                rowHtml += `<td class="td-numeric">${escapeHtml(formatRupiah(product[rolePriceKey] || 0, { withDecimals: true }))}</td>`;
            });
            const isChecked = product.status === 'Active' ? 'checked' : '';
            rowHtml += `
                <td><label class="switch"><input type="checkbox" class="product-status-toggle" data-product-id="${escapeHtml(product.id)}" ${isChecked}><span class="slider"></span></label></td>
                <td><button type="button" class="edit-btn edit-btn-compact edit-validation-btn" data-product-id="${escapeHtml(product.id)}">Atur</button></td>
                <td><button type="button" class="edit-btn edit-btn-compact manual-price-btn" data-product-id="${escapeHtml(product.id)}" data-product-name="${escapeHtml(product.name)}">Atur Harga</button></td>
            `;
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

    function wireModalControl(modalId, openBtnId, closeBtnIds, onOpen) {
        const modal = document.getElementById(modalId);
        if (!modal) return { close: () => {} };
        const close = () => modal.classList.add('hidden');
        app.registerModalCloser(close);

        const openBtn = openBtnId ? document.getElementById(openBtnId) : null;
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (typeof onOpen === 'function') onOpen(modal);
                modal.classList.remove('hidden');
            });
        }
        closeBtnIds.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.addEventListener('click', close);
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });
        return { modal, close };
    }

    function renderSyncResultBanner({ ok, marginPercent, message }) {
        const { formatDateId } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const banner = document.getElementById('sync-result-banner');
        if (!banner) return;
        const totalGames = Array.isArray(app.state.allGames) ? app.state.allGames.length : 0;
        const totalProducts = Array.isArray(app.state.allProducts) ? app.state.allProducts.length : 0;
        const timeStr = formatDateId(new Date().toISOString());
        banner.className = `admin-sync-summary ${ok ? 'is-success' : 'is-error'}`;
        banner.innerHTML = `
            <p class="admin-sync-summary-title">${ok ? 'Ringkasan Sinkronisasi Terakhir' : 'Sinkronisasi Gagal'}</p>
            <p>${escapeHtml(message)}</p>
            <p class="text-muted-sm">Waktu: ${escapeHtml(timeStr)} · Margin acuan: ${escapeHtml(marginPercent ?? 'Default')}% · Katalog kini: ${totalGames} Game, ${totalProducts} Produk</p>
        `;
        banner.classList.remove('hidden');
    }

    /**
     * Pasang listener filter katalog table-first, modal tambah/sinkronisasi, dan toggle status.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
            gameSearchInput,
            gameSelectorDropdown,
            gameInfoContainer,
            productsTableBody,
            addGameForm,
            addProductForm,
            syncForm,
        } = app.state.els;

        const addGameModalCtrl = wireModalControl('add-game-modal', 'open-add-game-modal-btn', ['close-add-game-modal-btn', 'cancel-add-game-btn']);
        const addProductModalCtrl = wireModalControl('add-product-modal', 'open-add-product-modal-btn', ['close-add-product-modal-btn', 'cancel-add-product-btn']);
        const syncModalCtrl = wireModalControl('sync-products-modal', 'open-sync-modal-btn', ['close-sync-modal-btn', 'cancel-sync-btn'], () => {
            const previewEl = document.getElementById('sync-preview-details');
            app.renderModalSummaryRows(previewEl, [
                { label: 'Game Terdaftar Saat Ini', value: String((app.state.allGames || []).length) },
                { label: 'Produk Terdaftar Saat Ini', value: String((app.state.allProducts || []).length) },
                { label: 'Target Endpoint', value: 'POST /api/admin/sync-products' },
            ]);
        });

        const productSearchInput = document.getElementById('product-search-input');
        const productStatusFilter = document.getElementById('product-status-filter');
        const prevBtn = document.getElementById('catalog-prev-btn');
        const nextBtn = document.getElementById('catalog-next-btn');

        const refreshTableFromFilters = () => {
            currentPage = 1;
            renderProductsForGame(gameSelectorDropdown ? gameSelectorDropdown.value : '');
        };

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
                const selectedGame = selectedGameId ? app.state.allGames.find(g => String(g.id) === String(selectedGameId)) : null;
                displayGameInfo(selectedGame);
                refreshTableFromFilters();
            });
        }

        if (productSearchInput) productSearchInput.addEventListener('input', refreshTableFromFilters);
        if (productStatusFilter) productStatusFilter.addEventListener('change', refreshTableFromFilters);
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (currentPage > 1) { currentPage -= 1; renderProductsForGame(gameSelectorDropdown ? gameSelectorDropdown.value : ''); }
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                currentPage += 1;
                renderProductsForGame(gameSelectorDropdown ? gameSelectorDropdown.value : '');
            });
        }

        if (gameInfoContainer) {
            gameInfoContainer.addEventListener('click', (e) => {
                const marginBtn = e.target.closest('#open-game-margin-modal-btn');
                if (marginBtn) {
                    app.validationAndPrices.fetchAndDisplayGameMargins(marginBtn.dataset.gameId);
                }
            });

            gameInfoContainer.addEventListener('change', async (e) => {
                const toggleSwitch = e.target;
                if (!toggleSwitch.classList.contains('game-status-toggle') && !toggleSwitch.classList.contains('needs-server-toggle')) return;
                const gameId = toggleSwitch.dataset.gameId;
                const isChecked = toggleSwitch.checked;
                const isStatusToggle = toggleSwitch.classList.contains('game-status-toggle');
                const endpoint = isStatusToggle ? `${app.ADMIN_API_URL}/games/${gameId}/status` : `${app.ADMIN_API_URL}/games/${gameId}/needs-server`;
                const body = isStatusToggle ? { status: isChecked ? 'Active' : 'Inactive' } : { needsServer: isChecked };

                toggleSwitch.disabled = true;
                try {
                    const response = await apiFetch(endpoint, { method: 'PUT', auth: true, token: app.state.token, jsonBody: body });
                    const result = await response.json();
                    if (!response.ok) { toggleSwitch.checked = !isChecked; throw new Error(result.message); }
                    app.notify(result.message || 'Pengaturan game diperbarui.', 'success');
                    const gameIndex = app.state.allGames.findIndex(g => String(g.id) === String(gameId));
                    if (gameIndex > -1) {
                        if (isStatusToggle) app.state.allGames[gameIndex].status = body.status;
                        else app.state.allGames[gameIndex].needs_server_id = body.needsServer;
                    }
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    toggleSwitch.disabled = false;
                }
            });
        }

        if (productsTableBody) {
            productsTableBody.addEventListener('change', async (e) => {
                if (!e.target.classList.contains('product-status-toggle')) return;
                const toggleSwitch = e.target;
                const productId = toggleSwitch.dataset.productId;
                const newStatus = toggleSwitch.checked ? 'Active' : 'Inactive';
                toggleSwitch.disabled = true;
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/products/${productId}/status`, {
                        method: 'PUT', auth: true, token: app.state.token, jsonBody: { status: newStatus },
                    });
                    const result = await response.json();
                    if (!response.ok) { toggleSwitch.checked = !toggleSwitch.checked; throw new Error(result.message); }
                    const productIndex = app.state.allProducts.findIndex(p => String(p.id) === String(productId));
                    if (productIndex > -1) app.state.allProducts[productIndex].status = newStatus;
                    updateCatalogStatsPill();
                    app.notify(`Status produk diubah menjadi ${newStatus}.`, 'success');
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    toggleSwitch.disabled = false;
                }
            });
        }

        if (addGameForm) {
            addGameForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const saveBtn = document.getElementById('save-add-game-btn');
                if (saveBtn) saveBtn.disabled = true;
                const data = {
                    name: document.getElementById('game-name').value.trim(),
                    category: document.getElementById('game-category').value,
                    imageUrl: document.getElementById('game-image').value.trim(),
                };
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/games`, { method: 'POST', auth: true, token: app.state.token, jsonBody: data });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    app.notify(result.message || 'Game baru berhasil ditambahkan.', 'success');
                    addGameForm.reset();
                    addGameModalCtrl.close();
                    await fetchAdminGames();
                    await populateAddProductFormDropdown();
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (saveBtn) saveBtn.disabled = false;
                }
            });
        }

        if (addProductForm) {
            addProductForm.addEventListener('submit', (e) => {
                e.preventDefault();
                addProductModalCtrl.close();
                app.notify('Fitur tambah produk manual dinonaktifkan. Gunakan Sinkronkan Foxy.', 'info');
            });
        }

        if (syncForm) {
            syncForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const syncButton = document.getElementById('confirm-sync-btn') || syncForm.querySelector('button[type="submit"]');
                const marginInput = document.getElementById('margin-percent');
                const rawMargin = marginInput ? marginInput.value.trim() : '';
                const margin_percent = rawMargin !== '' ? parseFloat(rawMargin) : undefined;
                if (syncButton) {
                    syncButton.disabled = true;
                    syncButton.textContent = 'Mensinkronkan...';
                }
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/sync-products`, {
                        method: 'POST', auth: true, token: app.state.token, jsonBody: { margin_percent },
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    syncModalCtrl.close();
                    await fetchAdminGames();
                    await fetchAdminProducts();
                    await populateAddProductFormDropdown();
                    renderSyncResultBanner({ ok: true, marginPercent: margin_percent, message: result.message });
                    app.notify(result.message || 'Sinkronisasi produk selesai.', 'success');
                } catch (error) {
                    syncModalCtrl.close();
                    renderSyncResultBanner({ ok: false, marginPercent: margin_percent, message: error.message });
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (syncButton) {
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
