(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    function renderPromosTable(promos) {
        const { formatRupiah } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { promosTableBody } = app.state.els;
        if (!promosTableBody) return;
        promosTableBody.innerHTML = '';
        if (!Array.isArray(promos) || promos.length === 0) {
            promosTableBody.innerHTML = '<tr class="table-empty-row"><td colspan="6"><div class="ui-state empty">Belum ada kode promo yang dibuat.</div></td></tr>';
            return;
        }
        promos.forEach(promo => {
            const row = document.createElement('tr');
            const isChecked = promo.is_active ? 'checked' : '';
            const formattedValue = promo.type === 'percentage'
                ? `${escapeHtml(promo.value)}%`
                : escapeHtml(formatRupiah(promo.value || 0));
            const maxUses = promo.max_uses != null ? String(promo.max_uses) : 'Tak terbatas';
            row.innerHTML = `
                <td class="td-mono"><strong>${escapeHtml(promo.code)}</strong></td>
                <td><span class="cell-truncate" title="${escapeHtml(promo.description)}">${escapeHtml(promo.description || '-')}</span></td>
                <td>${escapeHtml(promo.type)}</td>
                <td class="td-numeric">${formattedValue}</td>
                <td class="td-numeric">${escapeHtml(promo.uses_count ?? 0)} / ${escapeHtml(maxUses)}</td>
                <td>
                    <label class="switch">
                        <input type="checkbox" class="promo-status-toggle" data-promo-id="${escapeHtml(promo.id)}" ${isChecked}>
                        <span class="slider"></span>
                    </label>
                </td>
            `;
            promosTableBody.appendChild(row);
        });
    }

    /**
     * Ambil daftar kode promo dari API admin dan render ke tabel.
     */
    async function fetchAndDisplayPromos() {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const { promosTableBody } = app.state.els;
        if (!promosTableBody) return;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/promos`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat data promo.');
            const promos = await response.json();
            renderPromosTable(promos);
        } catch (error) {
            console.error('Error memuat promo:', error);
            promosTableBody.innerHTML = `<tr class="table-error-row"><td colspan="6"><div class="ui-state error">${escapeHtml(error.message)}</div></td></tr>`;
        }
    }

    function populateFlashSaleGameSelector(games) {
        const { fsGameSelector } = app.state.els;
        if (!fsGameSelector) return;
        const currentVal = fsGameSelector.value;
        fsGameSelector.innerHTML = '<option value="">-- Pilih Game --</option>';
        (games || []).forEach(game => {
            const option = document.createElement('option');
            option.value = game.id;
            option.textContent = game.name;
            fsGameSelector.appendChild(option);
        });
        if ((games || []).some(g => String(g.id) === String(currentVal))) {
            fsGameSelector.value = currentVal;
        }
    }

    function populateFlashSaleProductSelector(gameId) {
        const { fsProductSelector } = app.state.els;
        if (!fsProductSelector) return;
        const productsOfGame = (app.state.allProducts || []).filter(p => String(p.game_id) === String(gameId));
        fsProductSelector.innerHTML = '<option value="">-- Pilih Produk --</option>';
        productsOfGame.forEach(product => {
            const option = document.createElement('option');
            option.value = product.id;
            option.dataset.bronzePrice = product.price_bronze;
            option.textContent = product.name;
            fsProductSelector.appendChild(option);
        });
    }

    function renderFlashSalesTable(flashSales) {
        const { formatRupiah, formatDateId } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { flashSalesTableBody } = app.state.els;
        if (!flashSalesTableBody) return;
        flashSalesTableBody.innerHTML = '';
        if (!Array.isArray(flashSales) || flashSales.length === 0) {
            flashSalesTableBody.innerHTML = '<tr class="table-empty-row"><td colspan="6"><div class="ui-state empty">Belum ada item flash sale aktif.</div></td></tr>';
            return;
        }
        app.state.allFlashSales = flashSales;
        flashSales.forEach(fs => {
            const row = document.createElement('tr');
            const maxUses = fs.max_uses != null ? String(fs.max_uses) : 'Tak terbatas';
            const kuota = `${fs.uses_count ?? 0} / ${maxUses}`;
            const formattedDiscount = formatRupiah(fs.discount_price, { withDecimals: true });
            row.innerHTML = `
                <td>${escapeHtml(fs.game_name || '-')}</td>
                <td><span class="cell-truncate" title="${escapeHtml(fs.product_name)}">${escapeHtml(fs.product_name || '-')}</span></td>
                <td class="td-numeric">${escapeHtml(formattedDiscount)}</td>
                <td class="td-numeric">${escapeHtml(kuota)}</td>
                <td>${escapeHtml(formatDateId(fs.end_at))}</td>
                <td>
                    <button type="button" class="resolve-btn resolve-btn-refund delete-fs-btn"
                        data-fs-id="${escapeHtml(fs.id)}"
                        data-game-name="${escapeHtml(fs.game_name || '-')}"
                        data-product-name="${escapeHtml(fs.product_name || '-')}"
                        data-discount-price="${escapeHtml(formattedDiscount)}">Hapus</button>
                </td>
            `;
            flashSalesTableBody.appendChild(row);
        });
    }

    /**
     * Ambil daftar flash sale aktif dari API admin dan render ke tabel.
     */
    async function fetchAndDisplayFlashSales() {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const { flashSalesTableBody } = app.state.els;
        if (!flashSalesTableBody) return;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/flash-sales`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat flash sale.');
            const flashSales = await response.json();
            renderFlashSalesTable(flashSales);
        } catch (error) {
            console.error('Error memuat flash sale:', error);
            flashSalesTableBody.innerHTML = `<tr class="table-error-row"><td colspan="6"><div class="ui-state error">${escapeHtml(error.message)}</div></td></tr>`;
        }
    }

    /**
     * Pasang listener form dan tabel manajemen Promo serta Flash Sale berkonfirmasi.
     */
    function bindEvents() {
        const { formatRupiah } = global.MikuShared.format;
        const { apiFetch } = global.MikuShared.api;
        const {
            addPromoForm,
            promosTableBody,
            fsProductSelector,
            fsBronzePrice,
            fsPriceInfo,
            addFlashSaleForm,
            flashSalesTableBody,
            fsGameSearch,
            fsGameSelector,
        } = app.state.els;

        if (addPromoForm) {
            addPromoForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const rules = {};
                if (document.getElementById('promo-min-price').value) rules.min_price = parseInt(document.getElementById('promo-min-price').value, 10);
                if (document.getElementById('promo-max-uses-user').value) rules.max_uses_per_user = parseInt(document.getElementById('promo-max-uses-user').value, 10);
                const maxDiscountRaw = document.getElementById('promo-max-discount')?.value;
                if (maxDiscountRaw !== undefined && String(maxDiscountRaw).trim() !== '') {
                    const maxDiscountVal = parseInt(maxDiscountRaw, 10);
                    if (Number.isFinite(maxDiscountVal) && maxDiscountVal > 0) {
                        rules.max_discount_amount = maxDiscountVal;
                    }
                }
                if (document.getElementById('promo-allowed-games').value) rules.allowed_game_ids = document.getElementById('promo-allowed-games').value.split(',').map(id => parseInt(id.trim(), 10));
                if (document.getElementById('promo-allowed-products').value) rules.allowed_product_ids = document.getElementById('promo-allowed-products').value.split(',').map(id => parseInt(id.trim(), 10));

                const data = {
                    code: document.getElementById('promo-code').value.trim(),
                    description: document.getElementById('promo-description').value.trim(),
                    type: document.getElementById('promo-type').value,
                    value: parseFloat(document.getElementById('promo-value').value),
                    max_uses: parseInt(document.getElementById('promo-max-uses').value, 10) || null,
                    expires_at: document.getElementById('promo-expires').value || null,
                    rules,
                };

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/promos`, {
                        method: 'POST', auth: true, token: app.state.token, jsonBody: data,
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    app.notify('Kode promo berhasil dibuat.', 'success');
                    addPromoForm.reset();
                    fetchAndDisplayPromos();
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                }
            });
        }

        if (promosTableBody) {
            promosTableBody.addEventListener('change', async (e) => {
                if (!e.target.classList.contains('promo-status-toggle')) return;
                const toggle = e.target;
                const promoId = toggle.dataset.promoId;
                const is_active = toggle.checked;
                try {
                    const res = await apiFetch(`${app.ADMIN_API_URL}/promos/${promoId}/toggle`, {
                        method: 'PUT', auth: true, token: app.state.token, jsonBody: { is_active },
                    });
                    if (!res.ok) throw new Error('Gagal mengubah status promo.');
                    app.notify(`Status promo diubah menjadi ${is_active ? 'Aktif' : 'Nonaktif'}.`, 'success');
                } catch (error) {
                    app.notify(error.message || 'Gagal mengubah status promo.', 'error');
                    toggle.checked = !is_active;
                }
            });
        }

        if (fsProductSelector) {
            fsProductSelector.addEventListener('change', () => {
                const selectedOption = fsProductSelector.options[fsProductSelector.selectedIndex];
                if (selectedOption && selectedOption.value) {
                    const bronzePrice = parseFloat(selectedOption.dataset.bronzePrice);
                    if (fsBronzePrice) fsBronzePrice.textContent = formatRupiah(bronzePrice, { withDecimals: true });
                    if (fsPriceInfo) fsPriceInfo.classList.remove('hidden');
                } else if (fsPriceInfo) {
                    fsPriceInfo.classList.add('hidden');
                }
            });
        }

        if (addFlashSaleForm) {
            addFlashSaleForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const data = {
                    product_id: document.getElementById('fs-product-selector').value,
                    discount_price: document.getElementById('fs-discount-price').value,
                    start_at: document.getElementById('fs-start-at').value,
                    end_at: document.getElementById('fs-end-at').value,
                    max_uses: document.getElementById('fs-max-uses').value || null,
                    max_discount_amount: document.getElementById('fs-max-discount').value || null,
                };
                if (!data.product_id) { app.notify('Silakan pilih produk terlebih dahulu.', 'error'); return; }

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/flash-sales`, {
                        method: 'POST', auth: true, token: app.state.token, jsonBody: data,
                    });
                    if (!response.ok) throw new Error('Gagal menambahkan produk ke flash sale.');
                    app.notify('Produk berhasil ditambahkan ke flash sale.', 'success');
                    addFlashSaleForm.reset();
                    fsProductSelector.innerHTML = '<option value="">-- Pilih Game Terlebih Dahulu --</option>';
                    if (fsPriceInfo) fsPriceInfo.classList.add('hidden');
                    fetchAndDisplayFlashSales();
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                }
            });
        }

        if (flashSalesTableBody) {
            flashSalesTableBody.addEventListener('click', (e) => {
                const delBtn = e.target.closest('.delete-fs-btn');
                if (!delBtn) return;
                const fsId = delBtn.dataset.fsId;
                app.openConfirmModal({
                    title: 'Hapus Item Flash Sale?',
                    message: 'Item akan langsung dihapus dari daftar flash sale aktif.',
                    details: [
                        { label: 'Game', value: delBtn.dataset.gameName || '-' },
                        { label: 'Produk', value: delBtn.dataset.productName || '-' },
                        { label: 'Harga Diskon', value: delBtn.dataset.discountPrice || '-' },
                    ],
                    confirmLabel: 'Ya, Hapus Item',
                    danger: true,
                    onConfirm: async () => {
                        delBtn.disabled = true;
                        try {
                            const res = await apiFetch(`${app.ADMIN_API_URL}/flash-sales/${fsId}`, {
                                method: 'DELETE', auth: true, token: app.state.token,
                            });
                            if (!res.ok) throw new Error('Gagal menghapus item flash sale.');
                            app.notify('Item flash sale berhasil dihapus.', 'success');
                            await fetchAndDisplayFlashSales();
                        } catch (error) {
                            app.notify(error.message || 'Gagal menghapus item.', 'error');
                            delBtn.disabled = false;
                        }
                    },
                });
            });
        }

        if (fsGameSearch) {
            fsGameSearch.addEventListener('input', () => {
                const searchTerm = fsGameSearch.value.toLowerCase();
                const filteredGames = app.state.allGames.filter(g => g.name.toLowerCase().includes(searchTerm));
                populateFlashSaleGameSelector(filteredGames);
            });
        }

        if (fsGameSelector) {
            fsGameSelector.addEventListener('change', () => {
                const selectedGameId = fsGameSelector.value;
                if (selectedGameId) populateFlashSaleProductSelector(selectedGameId);
                else if (fsProductSelector) fsProductSelector.innerHTML = '<option value="">-- Pilih Game Terlebih Dahulu --</option>';
            });
        }
    }

    app.promosAndFlashSales = {
        fetchAndDisplayPromos,
        renderPromosTable,
        populateFlashSaleGameSelector,
        populateFlashSaleProductSelector,
        fetchAndDisplayFlashSales,
        renderFlashSalesTable,
        bindEvents,
    };
})(window);
