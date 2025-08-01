document.addEventListener('DOMContentLoaded', function() {
    // === DEKLARASI ELEMEN ===
    const navLinks = document.querySelectorAll('.admin-nav-link');
    const sections = document.querySelectorAll('.admin-section');
    const sidebar = document.getElementById('admin-sidebar');
    const menuToggleBtn = document.querySelectorAll('#menu-toggle-btn');
    const validationEditor = document.getElementById('product-validation-editor');
    const validationForm = document.getElementById('validation-config-form');
    const validationSelector = document.getElementById('validation-selector');
    const validationRulesContainer = document.getElementById('validation-rules-container');
    const allowedRegionsInput = document.getElementById('allowed-regions-input');
    const disallowedRegionsInput = document.getElementById('disallowed-regions-input');
    let allValidatableGamesData = [];
    let selectedProductIdForValidation = null;

    // Elemen untuk Produk & Game (Layout Baru)
    const gameSearchInput = document.getElementById('game-search-input');
    const gameSelectorDropdown = document.getElementById('game-selector-dropdown');
    const gameInfoContainer = document.getElementById('game-info-container');
    const productListContainer = document.getElementById('product-list-container');
    const productsTableBody = document.querySelector("#products-table tbody");
    const productListTitle = document.getElementById('product-list-title');

    // Elemen untuk bagian lain
    const pendingDepositsTableBody = document.querySelector("#pending-deposits-table tbody");
    const manualBalanceForm = document.getElementById('manual-balance-form');
    const addBalanceBtn = document.getElementById('add-balance-btn');
    const reduceBalanceBtn = document.getElementById('reduce-balance-btn');
    const addGameForm = document.getElementById('add-game-form');
    const addProductForm = document.getElementById('add-product-form');
    const productGameSelect = document.getElementById('product-game'); // Untuk form 'Tambah Produk'
    const syncForm = document.getElementById('sync-products-form');
    const marginForm = document.getElementById('margin-form');
    const marginFieldsContainer = document.getElementById('margin-fields-container');
    const applyToAllBtn = document.getElementById('apply-validation-to-all-btn');
    const validatorSearchInput = document.getElementById('validator-search-input');

    // Elemen untuk Manajemen Promo
    const addPromoForm = document.getElementById('add-promo-form');
    const promosTableBody = document.querySelector("#promos-table tbody");

    // Elemen untuk Manajemen Flash Sale
    const addFlashSaleForm = document.getElementById('add-flash-sale-form');
    const flashSalesTableBody = document.querySelector("#flash-sales-table tbody");
    const fsProductSelector = document.getElementById('fs-product-selector');
    const fsGameSearch = document.getElementById('fs-game-search');
    const fsGameSelector = document.getElementById('fs-game-selector');

    // === KONFIGURASI & STATE ===
    const ADMIN_API_URL = '/api/admin';
    const PUBLIC_API_URL = '/api';
    const token = localStorage.getItem('authToken');
    const ADMIN_PRICE_ROLE_ORDER = ['BRONZE', 'PARTNER', 'SILVER', 'GOLD', 'Admin'];
    let allGames = [];
    let allProducts = [];
    let allRoles = [];

    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    // === FUNGSI-FUNGSI ===

    async function fetchAdminGames() {
        try {
            const response = await fetch(`${ADMIN_API_URL}/games`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal memuat data game');
            allGames = await response.json();
            populateGameSelectorDropdown(allGames);
        } catch (error) {
            console.error("Error memuat game:", error);
            if (gameSelectorDropdown) {
                gameSelectorDropdown.innerHTML = `<option value="">${error.message}</option>`;
            }
        }
    }

    function populateGameSelectorDropdown(games) {
        if (!gameSelectorDropdown) return;
        gameSelectorDropdown.innerHTML = '<option value="">-- Silakan Pilih Game --</option>';
        games.forEach(game => {
            const option = document.createElement('option');
            option.value = game.id;
            option.textContent = game.name;
            gameSelectorDropdown.appendChild(option);
        });
    }
    
    function displayGameInfo(game) {
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

    async function fetchAdminProducts() {
        if (!productsTableBody) return;
        try {
            const response = await fetch(`${ADMIN_API_URL}/products`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal memuat data produk');
            allProducts = await response.json();
            if (allRoles.length === 0) {
                const rolesResponse = await fetch(`${ADMIN_API_URL}/roles`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!rolesResponse.ok) throw new Error('Gagal memuat data roles.');
                allRoles = await rolesResponse.json();
            }
        } catch (error) {
            console.error("Error memuat produk atau roles:", error);
        }
    }

    function renderProductsForGame(gameId) {
    if (!productsTableBody) return;
    const filteredProducts = allProducts.filter(p => p.game_id == gameId);
    productsTableBody.innerHTML = '';
    const productsTable = document.getElementById('products-table');
    const tableHeaderThead = productsTable.querySelector('thead');
    if (!tableHeaderThead) return;
    const tableHeaderRow = document.createElement('tr');

    // Membuat header dasar
    tableHeaderRow.innerHTML = `<th>Nama Produk</th><th>Harga Pokok</th><th>SKU</th>`;

    // Menambahkan header harga untuk setiap role
    const displayRoles = allRoles.filter(role => ADMIN_PRICE_ROLE_ORDER.includes(role.name))
        .sort((a, b) => ADMIN_PRICE_ROLE_ORDER.indexOf(a.name) - ADMIN_PRICE_ROLE_ORDER.indexOf(b.name));
    displayRoles.forEach(role => {
        tableHeaderRow.innerHTML += `<th>Harga ${role.name}</th>`;
    });

    // Menambahkan header Status
    tableHeaderRow.innerHTML += `<th>Status</th>`;

    // --- PERUBAHAN 1: Menambahkan header baru untuk Aksi Validasi ---
    tableHeaderRow.innerHTML += `<th>Aksi Validasi</th>`;
    // --- AKHIR PERUBAHAN ---

    tableHeaderThead.innerHTML = '';
    tableHeaderThead.appendChild(tableHeaderRow);
    productListTitle.textContent = `Produk untuk: ${allGames.find(g => g.id == gameId)?.name || 'Pilih Game'}`;
    
    if (filteredProducts.length === 0) {
        // PERBAIKAN KECIL: Menyesuaikan colspan agar tabel tetap rapi
        const colspan = 5 + displayRoles.length;
        productsTableBody.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center;">Belum ada produk untuk game ini.</td></tr>`;
        return;
    }

    filteredProducts.forEach(product => {
        const row = document.createElement('tr');
        row.dataset.productId = product.id;
        const formattedBasePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product.price);
        
        let rowHtml = `<td>${product.name}</td><td>${formattedBasePrice}</td><td>${product.provider_sku}</td>`;
        
        displayRoles.forEach(role => {
            const rolePriceKey = `price_${role.name.toLowerCase()}`;
            const formattedRolePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product[rolePriceKey] || 0);
            rowHtml += `<td>${formattedRolePrice}</td>`;
        });
        
        const isChecked = product.status === 'Active' ? 'checked' : '';
        
        // Sel untuk toggle status
        rowHtml += `
            <td>
                <label class="switch">
                    <input type="checkbox" class="product-status-toggle" data-product-id="${product.id}" ${isChecked}>
                    <span class="slider"></span>
                </label>
            </td>
        `;

        // --- PERUBAHAN 2: Menambahkan sel baru untuk tombol "Atur Validasi" ---
        rowHtml += `
            <td>
                <button class="edit-btn edit-validation-btn" data-product-id="${product.id}">Atur</button>
            </td>
        `;
        // --- AKHIR PERUBAHAN ---

        row.innerHTML = rowHtml;
        productsTableBody.appendChild(row);
    });
}

    async function fetchPendingDeposits() {
        if (!pendingDepositsTableBody) return;
        pendingDepositsTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center;">Memuat data...</td></tr>`;
        try {
            const response = await fetch(`${ADMIN_API_URL}/deposits/pending`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (response.status === 403) throw new Error('Akses Ditolak: Anda bukan Admin.');
            if (!response.ok) throw new Error('Gagal mengambil data deposit.');
            const deposits = await response.json();
            renderDepositsTable(deposits);
        } catch (error) {
            pendingDepositsTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        }
    }

    function renderDepositsTable(deposits) {
        if (!pendingDepositsTableBody) return;
        pendingDepositsTableBody.innerHTML = '';
        if (deposits.length === 0) {
            pendingDepositsTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Tidak ada permintaan deposit pending.</td></tr>';
            return;
        }
        deposits.forEach(deposit => {
            const row = document.createElement('tr');
            row.setAttribute('id', `deposit-${deposit.id}`);
            row.innerHTML = `
                <td>${deposit.id}</td>
                <td>${deposit.username}</td>
                <td>${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(deposit.amount)}</td>
                <td>${new Date(deposit.created_at).toLocaleString('id-ID')}</td>
                <td><button class="approve-btn" data-id="${deposit.id}">Approve</button></td>
            `;
            pendingDepositsTableBody.appendChild(row);
        });
    }

    async function handleManualBalance(action) {
        if (!manualBalanceForm) return;
        const username = document.getElementById('target-user').value;
        const amount = document.getElementById('manual-amount').value;
        const description = document.getElementById('manual-description').value;
        if (!username || !amount || !description) {
            alert('Semua kolom pada form manual wajib diisi!');
            return;
        }
        const endpoint = action === 'add' ? `${ADMIN_API_URL}/balance/add` : `${ADMIN_API_URL}/balance/reduce`;
        addBalanceBtn.disabled = true;
        reduceBalanceBtn.disabled = true;
        addBalanceBtn.textContent = 'Memproses...';
        reduceBalanceBtn.textContent = 'Memproses...';
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, amount: parseInt(amount), description })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message);
            alert(result.message);
            manualBalanceForm.reset();
        } catch (error) {
            alert(`Error: ${error.message}`);
        } finally {
            addBalanceBtn.disabled = false;
            reduceBalanceBtn.disabled = false;
            addBalanceBtn.textContent = 'Tambah Saldo';
            reduceBalanceBtn.textContent = 'Kurangi Saldo';
        }
    }

    async function populateAddProductFormDropdown() {
        if (!productGameSelect) return;
        try {
            const response = await fetch(`${PUBLIC_API_URL}/games`);
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

    async function fetchAndDisplayMargins() {
        if (!marginFieldsContainer) return;
        try {
            const response = await fetch(`${ADMIN_API_URL}/roles`, { headers: { 'Authorization': `Bearer ${token}` } });
            const roles = await response.json();
            marginFieldsContainer.innerHTML = '';
            roles.forEach(role => {
                if (role.name !== 'Admin' && role.name !== 'Owner') { 
                    const group = document.createElement('div');
                    group.className = 'form-group-horizontal';
                    group.innerHTML = `<label for="margin-role-${role.id}">${role.name}</label><div><input type="number" id="margin-role-${role.id}" data-role-id="${role.id}" value="${role.margin_percent}" step="0.01" required><span>%</span></div>`;
                    marginFieldsContainer.appendChild(group);
                }
            });
        } catch (error) {
            console.error('Gagal memuat margin:', error);
            marginFieldsContainer.innerHTML = '<p style="color:red">Gagal memuat data margin.</p>';
        }
    }

    async function fetchAllValidatableGames() {
    // Tambahkan pengecekan di awal fungsi
    if (!validationSelector) {
        return; // Hentikan fungsi jika dropdown tidak ada di halaman ini
    }

    try {
        const response = await fetch(`${PUBLIC_API_URL}/games/validatable`);
        allValidatableGamesData = await response.json();
        
        validationSelector.innerHTML = '<option value="">-- Tidak Perlu Validasi --</option>';
        allValidatableGamesData.forEach(game => {
            if (game.name) {
                const option = document.createElement('option');
                option.value = game.gameCode;
                option.textContent = game.name;
                validationSelector.appendChild(option);
            }
        });
    } catch (error) { 
        console.error("Gagal memuat data game untuk validasi:", error); 
        // Tambahkan pengecekan di sini juga untuk keamanan
        if (validationSelector) {
            validationSelector.innerHTML = `<option value="">Error!</option>`;
        }
    }
}

    function showValidationEditor(product) {
    selectedProductIdForValidation = product.id;
    if(!validationEditor) return; // Pengecekan elemen utama

    validationEditor.classList.remove('hidden');
    const config = product.validation_config || {};
    const rules = config.rules || {};

    if(validationSelector) validationSelector.value = config.validator || "";
    if(allowedRegionsInput) allowedRegionsInput.value = (rules.allowedRegions || []).join(',');
    if(disallowedRegionsInput) disallowedRegionsInput.value = (rules.disallowedRegions || []).join(',');

    // Pengecekan krusial untuk 'validationRulesContainer'
    if(validationRulesContainer) {
        validationRulesContainer.classList.toggle('hidden', !validationSelector.value);
    }
}

async function fetchAndDisplayPromos() {
    if (!promosTableBody) return;
    try {
        const response = await fetch(`${ADMIN_API_URL}/promos`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) throw new Error('Gagal memuat data promo.');
        const promos = await response.json();
        renderPromosTable(promos);
    } catch (error) {
        console.error("Error memuat promo:", error);
        if (promosTableBody) promosTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">${error.message}</td></tr>`;
    }
}

function renderPromosTable(promos) {
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

// Mengisi dropdown game di form Flash Sale
function populateFlashSaleGameSelector(games) {
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
    if (!fsProductSelector) return;
    const productsOfGame = allProducts.filter(p => p.game_id == gameId);
    fsProductSelector.innerHTML = '<option value="">-- Pilih Produk --</option>';
    productsOfGame.forEach(product => {
        const option = document.createElement('option');
        option.value = product.id;
        option.textContent = `${product.name} (Harga Asli: Rp ${product.price.toLocaleString('id-ID')})`;
        fsProductSelector.appendChild(option);
    });
}

async function fetchAndDisplayFlashSales() {
    if (!flashSalesTableBody) return;
    try {
        const response = await fetch(`${ADMIN_API_URL}/flash-sales`, { headers: { 'Authorization': `Bearer ${token}` } });
        const flashSales = await response.json();
        renderFlashSalesTable(flashSales);
    } catch (error) {
        console.error("Error memuat flash sale:", error);
    }
}

function renderFlashSalesTable(flashSales) {
    if (!flashSalesTableBody) return;
    flashSalesTableBody.innerHTML = '';
    flashSales.forEach(fs => {
        const row = document.createElement('tr');
        const kuota = `${fs.uses_count} / ${fs.max_uses || '∞'}`;
        row.innerHTML = `
            <td>${fs.game_name}</td>
            <td>${fs.product_name}</td>
            <td>${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(fs.discount_price)}</td>
            <td>${kuota}</td>
            <td>${new Date(fs.end_at).toLocaleString('id-ID')}</td>
            <td><button class="failed-btn delete-fs-btn" data-fs-id="${fs.id}">Hapus</button></td>
        `;
        flashSalesTableBody.appendChild(row);
    });
}

    // === EVENT LISTENERS ===

if (marginForm) {
        marginForm.addEventListener('submit', async (e) => {
            e.preventDefault(); // Mencegah halaman refresh
            const saveButton = marginForm.querySelector('button');
            saveButton.disabled = true;
            saveButton.textContent = 'Menyimpan...';

            const marginInputs = marginFieldsContainer.querySelectorAll('input[type="number"]');
            const marginsToUpdate = Array.from(marginInputs).map(input => ({
                id: input.dataset.roleId,
                margin: parseFloat(input.value)
            }));

            try {
                const response = await fetch(`${ADMIN_API_URL}/roles`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(marginsToUpdate)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                
                alert('Margin berhasil diperbarui!');

            } catch (error) {
                alert(`Error: ${error.message}`);
            } finally {
                saveButton.disabled = false;
                saveButton.textContent = 'Simpan Semua Margin';
            }
        });
    }

        if (validationForm && validationSelector) {

    // Event listener untuk dropdown Tipe Validator
    validationSelector.addEventListener('change', () => {
        validationRulesContainer.classList.toggle('hidden', !validationSelector.value);
    });

    // Event listener untuk tombol "Simpan Pengaturan Validasi"
    validationForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const validator = validationSelector.value;
        const allowed = allowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const disallowed = disallowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        let config = null;
        if (validator) {
            config = { validator };
            if (allowed.length > 0 || disallowed.length > 0) {
                config.rules = {};
                if (allowed.length > 0) config.rules.allowedRegions = allowed;
                if (disallowed.length > 0) config.rules.disallowedRegions = disallowed;
            }
        }
        try {
            const response = await fetch(`${ADMIN_API_URL}/products/${selectedProductIdForValidation}/validation`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ validation_config: config })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message);
            alert('Pengaturan validasi berhasil disimpan!');
            const productIndex = allProducts.findIndex(p => p.id == selectedProductIdForValidation);
            if (productIndex > -1) allProducts[productIndex].validation_config = config;
        } catch (error) { alert(`Error: ${error.message}`); }
    });

    // Event listener untuk tombol "Terapkan ke Semua"
    if (applyToAllBtn) {
        applyToAllBtn.addEventListener('click', async () => {
            if (!selectedProductIdForValidation) {
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

            const validator = validationSelector.value;
            const allowed = allowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            const disallowed = disallowedRegionsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            let config = null;
            if (validator) {
                config = { validator };
                if (allowed.length > 0 || disallowed.length > 0) {
                    config.rules = {};
                    if (allowed.length > 0) config.rules.allowedRegions = allowed;
                    if (disallowed.length > 0) config.rules.disallowedRegions = disallowed;
                }
            }
            
            const productIdsToUpdate = allProducts
                .filter(p => p.game_id == selectedGameId)
                .map(p => p.id);

            try {
                const response = await fetch(`${ADMIN_API_URL}/products/bulk-validation`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        productIds: productIdsToUpdate,
                        validation_config: config
                    })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                
                alert(`Berhasil! Pengaturan validasi telah diterapkan ke ${productIdsToUpdate.length} produk.`);
                
                productIdsToUpdate.forEach(id => {
                    const productIndex = allProducts.findIndex(p => p.id == id);
                    if (productIndex > -1) allProducts[productIndex].validation_config = config;
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
        const filteredGames = allValidatableGamesData.filter(game => 
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
            expires_at: document.getElementById('promo-expires').value || null,
            rules: rules
        };

        try {
            const response = await fetch(`${ADMIN_API_URL}/promos`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
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
                await fetch(`${ADMIN_API_URL}/promos/${promoId}/toggle`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ is_active })
                });
            } catch (error) {
                alert('Gagal mengubah status promo.');
                toggle.checked = !is_active; // Kembalikan posisi toggle jika gagal
            }
        }
    });
}

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
                fetchAndDisplayPromos();
            }
                if (targetId === 'flash-sale') {
                    populateFlashSaleGameSelector(allGames); 
                    fetchAndDisplayFlashSales();
                }
                    
            });
        });
    }

    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allGames.filter(game => game.name.toLowerCase().includes(searchTerm));
            populateGameSelectorDropdown(filteredGames);
        });
    }

   if (gameSelectorDropdown) {
    gameSelectorDropdown.addEventListener('change', () => {
        const selectedGameId = gameSelectorDropdown.value;

        // Ambil elemen judulnya
        const productListTitle = document.getElementById('product-list-title');

        if (selectedGameId) {
            const selectedGame = allGames.find(g => g.id == selectedGameId);
            displayGameInfo(selectedGame);
            renderProductsForGame(selectedGameId);

            // Tampilkan container produk dan SEMBUNYIKAN judulnya
            productListContainer.classList.remove('hidden');
            if (productListTitle) {
                productListTitle.classList.add('hidden');
            }

        } else {
            // Sembunyikan semua jika tidak ada game yang dipilih
            displayGameInfo(null);
            productListContainer.classList.add('hidden');
            
            // TAMPILKAN kembali judulnya dan reset teksnya
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
                    endpoint = `${ADMIN_API_URL}/games/${gameId}/status`;
                    body = { status: isChecked ? 'Active' : 'Inactive' };
                } else {
                    endpoint = `${ADMIN_API_URL}/games/${gameId}/needs-server`;
                    body = { needsServer: isChecked };
                }
                toggleSwitch.disabled = true;
                try {
                    const response = await fetch(endpoint, {
                        method: 'PUT',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const result = await response.json();
                    if (!response.ok) {
                        toggleSwitch.checked = !isChecked;
                        throw new Error(result.message);
                    }
                    alert(result.message);
                    const gameIndex = allGames.findIndex(g => g.id == gameId);
                    if (gameIndex > -1) {
                        if (toggleSwitch.classList.contains('game-status-toggle')) {
                            allGames[gameIndex].status = body.status;
                        } else {
                            allGames[gameIndex].needs_server_id = body.needsServer;
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
    // LISTENER #1: Untuk menangani KLIK pada tombol "Atur"
    productsTableBody.addEventListener('click', (e) => {
        // Cek apakah yang diklik adalah tombol 'Atur Validasi'
        if (e.target.classList.contains('edit-validation-btn')) {
            const productId = e.target.dataset.productId;
            const product = allProducts.find(p => p.id == productId);
            if (product) {
                // Panggil fungsi untuk menampilkan editor validasi
                showValidationEditor(product);
            }
        }
    });

    // LISTENER #2: Untuk menangani PERUBAHAN pada toggle status (kode asli Anda, tidak diubah)
    productsTableBody.addEventListener('change', async (e) => {
        // Cek apakah yang berubah adalah toggle status produk
        if (e.target.classList.contains('product-status-toggle')) {
            const toggleSwitch = e.target;
            const productId = toggleSwitch.dataset.productId;
            const newStatus = toggleSwitch.checked ? 'Active' : 'Inactive';
            toggleSwitch.disabled = true;
            try {
                const response = await fetch(`${ADMIN_API_URL}/products/${productId}/status`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: newStatus })
                });
                const result = await response.json();
                if (!response.ok) {
                    toggleSwitch.checked = !toggleSwitch.checked;
                    throw new Error(result.message);
                }
                console.log(`Status produk ${productId} diubah menjadi ${newStatus}`);
                const productIndex = allProducts.findIndex(p => p.id == productId);
                if (productIndex > -1) {
                    allProducts[productIndex].status = newStatus;
                }
            } catch (error) {
                alert(`Error: ${error.message}`);
            } finally {
                toggleSwitch.disabled = false;
            }
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
            max_discount_amount: document.getElementById('fs-max-discount').value || null
        };

        if(!data.product_id) {
            alert('Silakan pilih produk terlebih dahulu.');
            return;
        }

        try {
            const response = await fetch(`${ADMIN_API_URL}/flash-sales`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!response.ok) throw new Error('Gagal menambahkan produk ke flash sale.');
            alert('Produk berhasil ditambahkan ke flash sale!');
            addFlashSaleForm.reset();
            fsProductSelector.innerHTML = '<option value="">-- Pilih Game Terlebih Dahulu --</option>'; // Reset dropdown produk
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
                    await fetch(`${ADMIN_API_URL}/flash-sales/${fsId}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
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
        const filteredGames = allGames.filter(g => g.name.toLowerCase().includes(searchTerm));
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

    if (addBalanceBtn) addBalanceBtn.addEventListener('click', () => handleManualBalance('add'));
    if (reduceBalanceBtn) reduceBalanceBtn.addEventListener('click', () => handleManualBalance('reduce'));

    if (pendingDepositsTableBody) {
        pendingDepositsTableBody.addEventListener('click', async function(e) {
            if (e.target && e.target.classList.contains('approve-btn')) {
                const depositId = e.target.dataset.id;
                e.target.disabled = true;
                e.target.textContent = 'Memproses...';
                try {
                    const response = await fetch(`${ADMIN_API_URL}/deposits/approve`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ depositId: depositId })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                    document.getElementById(`deposit-${depositId}`).remove();
                } catch (error) {
                    alert(`Error: ${error.message}`);
                    e.target.disabled = false;
                    e.target.textContent = 'Approve';
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
                const response = await fetch(`${ADMIN_API_URL}/games`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
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
            alert("Fitur ini dinonaktifkan. Gunakan sinkronisasi produk.");
        });
    }
    
    if(syncForm) {
        syncForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const syncButton = syncForm.querySelector('button');
            if (confirm(`Anda yakin ingin sinkronisasi produk dari Foxy? Ini akan menambah/memperbarui produk.`)) {
                syncButton.disabled = true;
                syncButton.textContent = 'Mensinkronkan...';
                try {
                    const response = await fetch(`${ADMIN_API_URL}/sync-products`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` }
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


    // === FUNGSI INISIALISASI ===
    async function initAdminPage() {
        await fetchAllValidatableGames();
        await fetchAdminGames();
        await fetchAdminProducts();
        await fetchPendingDeposits();
        await populateAddProductFormDropdown();
        await fetchAndDisplayMargins();
        await fetchAndDisplayPromos();
        await fetchAndDisplayFlashSales();
    }
    
    initAdminPage();
});