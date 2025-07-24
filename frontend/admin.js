document.addEventListener('DOMContentLoaded', function() {
    // === DEKLARASI ELEMEN ===
    const navLinks = document.querySelectorAll('.admin-nav-link');
    const sections = document.querySelectorAll('.admin-section');
    const sidebar = document.getElementById('admin-sidebar');
    const menuToggleBtn = document.querySelectorAll('#menu-toggle-btn');

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

    // === KONFIGURASI & STATE ===
    const ADMIN_API_URL = 'https://topup-miku.onrender.com/api/admin';
    const PUBLIC_API_URL = 'https://topup-miku.onrender.com/api';
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
        tableHeaderRow.innerHTML = `<th>Nama Produk</th><th>Harga Pokok</th><th>SKU</th>`;
        const displayRoles = allRoles.filter(role => ADMIN_PRICE_ROLE_ORDER.includes(role.name))
            .sort((a, b) => ADMIN_PRICE_ROLE_ORDER.indexOf(a.name) - ADMIN_PRICE_ROLE_ORDER.indexOf(b.name));
        displayRoles.forEach(role => {
            tableHeaderRow.innerHTML += `<th>Harga ${role.name}</th>`;
        });
        tableHeaderRow.innerHTML += `<th>Status</th>`;
        tableHeaderThead.innerHTML = '';
        tableHeaderThead.appendChild(tableHeaderRow);
        productListTitle.textContent = `Produk untuk: ${allGames.find(g => g.id == gameId)?.name || 'Pilih Game'}`;
        if (filteredProducts.length === 0) {
            const colspan = 4 + displayRoles.length;
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
            rowHtml += `
                <td>
                    <label class="switch">
                        <input type="checkbox" class="product-status-toggle" data-product-id="${product.id}" ${isChecked}>
                        <span class="slider"></span>
                    </label>
                </td>
            `;
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

    // === EVENT LISTENERS ===

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
            if (selectedGameId) {
                const selectedGame = allGames.find(g => g.id == selectedGameId);
                displayGameInfo(selectedGame);
                renderProductsForGame(selectedGameId);
                productListContainer.classList.remove('hidden');
            } else {
                displayGameInfo(null);
                productListContainer.classList.add('hidden');
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
        productsTableBody.addEventListener('change', async (e) => {
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
        await fetchAdminGames();
        await fetchAdminProducts();
        await fetchPendingDeposits();
        await populateAddProductFormDropdown();
        await fetchAndDisplayMargins();
    }
    
    initAdminPage();
});