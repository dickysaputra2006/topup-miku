(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    function renderPromosTable(promos) {
        const { promosTableBody } = app.state.els;
        if (!promosTableBody) return;
        promosTableBody.innerHTML = '';
        if (promos.length === 0) {
            promosTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center;">Belum ada kode promo yang dibuat.</td></tr>`;
            return;
        }
        promos.forEach(promo => {
            const row = document.createElement('tr');
            const isChecked = promo.is_active ? 'checked' : '';
            row.innerHTML = `
                <td><strong>${promo.code}</strong></td>
                <td>${promo.description}</td>
                <td>${promo.type}</td>
                <td>${promo.type === 'percentage' ? `${promo.value}%` : `Rp ${promo.value}`}</td>
                <td>${promo.uses_count} / ${promo.max_uses || '∞'}</td>
                <td>
                    <label class="switch">
                        <input type="checkbox" class="promo-status-toggle" data-promo-id="${promo.id}" ${isChecked}>
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
            if (promosTableBody) promosTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">${error.message}</td></tr>`;
        }
    }

    // Mengisi dropdown game di form Flash Sale
    function populateFlashSaleGameSelector(games) {
        const { fsGameSelector } = app.state.els;
        if (!fsGameSelector) return;
        const currentVal = fsGameSelector.value;
        fsGameSelector.innerHTML = '<option value="">-- Pilih Game --</option>';
        games.forEach(game => {
            const option = document.createElement('option');
            option.value = game.id;
            option.textContent = game.name;
            fsGameSelector.appendChild(option);
        });
        if (games.some(g => g.id == currentVal)) {
            fsGameSelector.value = currentVal;
        }
    }

    // Mengisi dropdown produk berdasarkan game yang dipilih
    function populateFlashSaleProductSelector(gameId) {
        const { fsProductSelector } = app.state.els;
        if (!fsProductSelector) return;
        const productsOfGame = app.state.allProducts.filter(p => p.game_id == gameId);
        fsProductSelector.innerHTML = '<option value="">-- Pilih Produk --</option>';
        productsOfGame.forEach(product => {
            const option = document.createElement('option');
            option.value = product.id;
            // Simpan harga bronze di data-attribute
            option.dataset.bronzePrice = product.price_bronze;
            option.textContent = product.name;
            fsProductSelector.appendChild(option);
        });
    }

    function renderFlashSalesTable(flashSales) {
        const { formatRupiah, formatDateId } = global.MikuShared.format;
        const { flashSalesTableBody } = app.state.els;
        if (!flashSalesTableBody) return;
        flashSalesTableBody.innerHTML = '';
        flashSales.forEach(fs => {
            const row = document.createElement('tr');
            const kuota = `${fs.uses_count} / ${fs.max_uses || '∞'}`;
            row.innerHTML = `
                <td>${fs.game_name}</td>
                <td>${fs.product_name}</td>
                <td>${formatRupiah(fs.discount_price, { withDecimals: true })}</td>
                <td>${kuota}</td>
                <td>${formatDateId(fs.end_at)}</td>
                <td><button class="failed-btn delete-fs-btn" data-fs-id="${fs.id}">Hapus</button></td>
            `;
            flashSalesTableBody.appendChild(row);
        });
    }

    /**
     * Ambil daftar flash sale aktif dari API admin dan render ke tabel.
     */
    async function fetchAndDisplayFlashSales() {
        const { apiFetch } = global.MikuShared.api;
        const { flashSalesTableBody } = app.state.els;
        if (!flashSalesTableBody) return;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/flash-sales`, { auth: true, token: app.state.token });
            const flashSales = await response.json();
            renderFlashSalesTable(flashSales);
        } catch (error) {
            console.error('Error memuat flash sale:', error);
        }
    }

    /**
     * Pasang seluruh listener form dan tabel manajemen Promo serta Flash Sale.
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
                if (document.getElementById('promo-min-price').value) rules.min_price = parseInt(document.getElementById('promo-min-price').value);
                if (document.getElementById('promo-max-uses-user').value) rules.max_uses_per_user = parseInt(document.getElementById('promo-max-uses-user').value);
                if (document.getElementById('promo-allowed-games').value) rules.allowed_game_ids = document.getElementById('promo-allowed-games').value.split(',').map(id => parseInt(id.trim()));
                if (document.getElementById('promo-allowed-products').value) rules.allowed_product_ids = document.getElementById('promo-allowed-products').value.split(',').map(id => parseInt(id.trim()));

                const data = {
                    code: document.getElementById('promo-code').value,
                    description: document.getElementById('promo-description').value,
                    type: document.getElementById('promo-type').value,
                    value: parseFloat(document.getElementById('promo-value').value),
                    max_uses: parseInt(document.getElementById('promo-max-uses').value) || null,
                    expires_at: document.getElementById('promo-expires').value || null,
                    rules: rules
                };

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/promos`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert('Kode promo berhasil dibuat!');
                    addPromoForm.reset();
                    fetchAndDisplayPromos(); // Refresh tabel
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });
        }

        if (promosTableBody) {
            promosTableBody.addEventListener('change', async (e) => {
                if (e.target.classList.contains('promo-status-toggle')) {
                    const toggle = e.target;
                    const promoId = toggle.dataset.promoId;
                    const is_active = toggle.checked;
                    try {
                        await apiFetch(`${app.ADMIN_API_URL}/promos/${promoId}/toggle`, {
                            method: 'PUT',
                            auth: true,
                            token: app.state.token,
                            jsonBody: { is_active }
                        });
                    } catch (error) {
                        alert('Gagal mengubah status promo.');
                        toggle.checked = !is_active; // Kembalikan posisi toggle jika gagal
                    }
                }
            });
        }

        if (fsProductSelector) {
            fsProductSelector.addEventListener('change', () => {
                const selectedOption = fsProductSelector.options[fsProductSelector.selectedIndex];
                if (selectedOption && selectedOption.value) {
                    const bronzePrice = parseFloat(selectedOption.dataset.bronzePrice);
                    fsBronzePrice.textContent = formatRupiah(bronzePrice, { withDecimals: true });
                    fsPriceInfo.classList.remove('hidden');
                } else {
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
                    // PERBAIKAN: Ubah ID di sini agar sesuai dengan HTML
                    max_discount_amount: document.getElementById('fs-max-discount').value || null
                };

                if (!data.product_id) {
                    alert('Silakan pilih produk terlebih dahulu.');
                    return;
                }

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/flash-sales`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: data
                    });
                    if (!response.ok) throw new Error('Gagal menambahkan produk ke flash sale.');
                    alert('Produk berhasil ditambahkan ke flash sale!');
                    addFlashSaleForm.reset();
                    fsProductSelector.innerHTML = '<option value="">-- Pilih Game Terlebih Dahulu --</option>';
                    fetchAndDisplayFlashSales();
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            });
        }

        if (flashSalesTableBody) {
            flashSalesTableBody.addEventListener('click', async (e) => {
                if (e.target.classList.contains('delete-fs-btn')) {
                    const fsId = e.target.dataset.fsId;
                    if (confirm('Anda yakin ingin menghapus item ini dari flash sale?')) {
                        try {
                            await apiFetch(`${app.ADMIN_API_URL}/flash-sales/${fsId}`, {
                                method: 'DELETE',
                                auth: true,
                                token: app.state.token
                            });
                            fetchAndDisplayFlashSales();
                        } catch (error) {
                            alert('Gagal menghapus item.');
                        }
                    }
                }
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
                if (selectedGameId) {
                    populateFlashSaleProductSelector(selectedGameId);
                } else {
                    fsProductSelector.innerHTML = '<option value="">-- Pilih Game Terlebih Dahulu --</option>';
                }
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
