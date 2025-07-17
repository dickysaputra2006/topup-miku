// admin.js
document.addEventListener('DOMContentLoaded', function() {
    // --- LOGIKA BARU UNTUK NAVIGASI TAB ---
    const navLinks = document.querySelectorAll('.admin-nav-link');
    const sections = document.querySelectorAll('.admin-section');

    // Pastikan elemennya ada sebelum menambahkan fungsi klik
    if (navLinks.length > 0 && sections.length > 0) {
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = link.dataset.target;

                navLinks.forEach(navLink => navLink.classList.remove('active'));
                link.classList.add('active');

                sections.forEach(section => {
                    if (section.id === targetId) {
                        section.classList.remove('hidden');
                    } else {
                        section.classList.add('hidden');
                    }
                });
            });
        });
    }

    const ADMIN_API_URL = 'https://topup-miku.onrender.com/api/admin';
    const PUBLIC_API_URL = 'https://topup-miku.onrender.com/api'; 
    const token = localStorage.getItem('authToken');

    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    const pendingDepositsTableBody = document.querySelector("#pending-deposits-table tbody");
    const manualBalanceForm = document.getElementById('manual-balance-form');
    const addBalanceBtn = document.getElementById('add-balance-btn');
    const reduceBalanceBtn = document.getElementById('reduce-balance-btn');
    const addGameForm = document.getElementById('add-game-form');
    const addProductForm = document.getElementById('add-product-form');
    const productGameSelect = document.getElementById('product-game');
    const syncForm = document.getElementById('sync-products-form');
    const gamesTableBody = document.querySelector("#games-table tbody");
    const productsTableBody = document.querySelector("#products-table tbody");
    const productListTitle = document.getElementById('product-list-title');
    const marginForm = document.getElementById('margin-form');
    const marginFieldsContainer = document.getElementById('margin-fields-container');

    let allGames = [];
    let allProducts = [];
    let allRoles = []; // Variabel untuk menyimpan semua role
    
    // ====================================================================
    // PERUBAHAN DI SINI: Urutan role yang diinginkan
    const ADMIN_PRICE_ROLE_ORDER = ['BRONZE', 'PARTNER', 'SILVER', 'GOLD', 'Admin']; 
    // ====================================================================

    // === Kumpulan Semua Fungsi ===
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

    async function populateGamesDropdown() {
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

    async function fetchAdminGames() {
        if (!gamesTableBody) return;
        try {
            const response = await fetch(`${ADMIN_API_URL}/games`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal memuat data game');
            allGames = await response.json();
            renderGamesTable(allGames);
        } catch (error) {
            console.error("Error memuat game:", error);
            if (gamesTableBody) gamesTableBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: red;">${error.message}</td></tr>`;
        }
    }

    
function renderGamesTable(games) {
    if (!gamesTableBody) return;
    gamesTableBody.innerHTML = '';
    if (games.length === 0) {
        gamesTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Belum ada game.</td></tr>';
        return;
    }

    
    games.forEach(game => {
        const row = document.createElement('tr');
        row.dataset.gameId = game.id;

        // Tentukan apakah toggle harus dalam keadaan ON
        const isChecked = game.status === 'Active' ? 'checked' : '';

        // Tambahkan sel baru untuk toggle switch
        row.innerHTML = `
            <td>${game.id}</td>
            <td>${game.name}</td>
            <td>${game.category}</td>
            <td>
                <label class="switch">
                    <input type="checkbox" class="game-status-toggle" ${isChecked}>
                    <span class="slider"></span>
                </label>
            </td>
        `;
        gamesTableBody.appendChild(row);
    });
}

     async function fetchAdminProducts() {
        if (!productsTableBody) return;
        try {
            const response = await fetch(`${ADMIN_API_URL}/products`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal memuat data produk');
            allProducts = await response.json();

            // Ambil juga daftar role untuk header tabel (jika belum ada)
            if (allRoles.length === 0) {
                const rolesResponse = await fetch(`${ADMIN_API_URL}/roles`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!rolesResponse.ok) throw new Error('Gagal memuat data roles untuk header.');
                allRoles = await rolesResponse.json();
            }

            const activeGameRow = document.querySelector('#games-table tbody tr.active-row');
            if (activeGameRow) {
                renderProductsForGame(activeGameRow.dataset.gameId);
            } else {
                // Untuk colspan default, gunakan ADMIN_PRICE_ROLE_ORDER
                const colspan = 3 + ADMIN_PRICE_ROLE_ORDER.length; 
                productsTableBody.innerHTML = '<tr><td colspan="'+colspan+'" style="text-align: center;">Pilih Game untuk Melihat Produk</td></tr>';
            }
        } catch (error) {
            console.error("Error memuat produk atau roles:", error);
            const colspan = 3 + ADMIN_PRICE_ROLE_ORDER.length; 
            if (productsTableBody) productsTableBody.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center; color: red;">${error.message}</td></tr>`;
        }
    }

     function renderProductsForGame(gameId) {
    if (!productsTableBody) return;
    const filteredProducts = allProducts.filter(p => p.game_id == gameId);
    productsTableBody.innerHTML = '';

    const productsTable = document.getElementById('products-table');
    const tableHeaderThead = productsTable.querySelector('thead');

    if (!tableHeaderThead) {
        console.error('Error: Table header (thead) not found for products table.');
        return;
    }

    const tableHeaderRow = document.createElement('tr');
    // TAMBAHKAN HEADER BARU 'STATUS' DI SINI
    tableHeaderRow.innerHTML = `<th>Nama Produk</th><th>Harga Pokok</th><th>SKU</th>`;

    const displayRoles = allRoles.filter(role =>
        ADMIN_PRICE_ROLE_ORDER.includes(role.name)
    ).sort((a, b) => {
        const indexA = ADMIN_PRICE_ROLE_ORDER.indexOf(a.name);
        const indexB = ADMIN_PRICE_ROLE_ORDER.indexOf(b.name);
        return indexA - indexB;
    });

    displayRoles.forEach(role => {
        tableHeaderRow.innerHTML += `<th>Harga ${role.name}</th>`;
    });

    // TAMBAHKAN HEADER BARU 'STATUS' DI AKHIR
    tableHeaderRow.innerHTML += `<th>Status</th>`;

    tableHeaderThead.innerHTML = '';
    tableHeaderThead.appendChild(tableHeaderRow);

    productListTitle.textContent = `Produk untuk: ${allGames.find(g => g.id == gameId)?.name || 'Pilih Game'}`;

    if (filteredProducts.length === 0) {
        // PERBARUI COLSPAN
        const colspan = 4 + displayRoles.length;
        productsTableBody.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center;">Belum ada produk untuk game ini.</td></tr>`;
        return;
    }

    filteredProducts.forEach(product => {
        const row = document.createElement('tr');
        // TAMBAHKAN data-product-id KE ROW
        row.dataset.productId = product.id; 
        
        const formattedBasePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product.price);
        let rowHtml = `<td>${product.name}</td><td>${formattedBasePrice}</td><td>${product.provider_sku}</td>`;

        displayRoles.forEach(role => {
            const rolePriceKey = `price_${role.name.toLowerCase()}`;
            const formattedRolePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product[rolePriceKey] || 0);
            rowHtml += `<td>${formattedRolePrice}</td>`;
        });

        // ====================================================================
        // INI BAGIAN PENTING: TAMBAHKAN KOLOM DENGAN TOGGLE SWITCH
        // ====================================================================
        const isChecked = product.status === 'Active' ? 'checked' : '';
        rowHtml += `
            <td>
                <label class="switch">
                    <input type="checkbox" class="product-status-toggle" ${isChecked}>
                    <span class="slider"></span>
                </label>
            </td>
        `;
        // ====================================================================

        row.innerHTML = rowHtml;
        productsTableBody.appendChild(row);
    });
}


    async function fetchAndDisplayMargins() {
        if (!marginFieldsContainer) return;
        try {
            const response = await fetch(`${ADMIN_API_URL}/roles`, { headers: { 'Authorization': `Bearer ${token}` } });
            const roles = await response.json();
            marginFieldsContainer.innerHTML = '';
            roles.forEach(role => {
                // ====================================================================
                // PERUBAHAN DI SINI: Hanya tampilkan margin untuk role yang bisa diubah (User, Gold, Silver, Bronze, Partner)
                // Admin dan Owner tidak perlu diubah marginnya secara terpisah jika mereka punya margin 0% atau dikelola berbeda.
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

    // === Menambahkan Event Listeners ===
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
                await populateGamesDropdown();
            } catch (error) {
                alert(`Error: ${error.message}`);
            }
        });
    }

    if (addProductForm) {
        addProductForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                game_id: document.getElementById('product-game').value,
                name: document.getElementById('product-name').value,
                provider_sku: document.getElementById('product-sku').value,
                price: document.getElementById('product-price').value,
                // Kita perlu cara untuk memilih category_id di form
            };
            if (!data.game_id) {
                alert('Silakan pilih game terlebih dahulu.');
                return;
            }
            alert("Fitur tambah produk manual akan disempurnakan nanti, gunakan sinkronisasi untuk sekarang.");
        });
    }
    
    if (gamesTableBody) {
        gamesTableBody.addEventListener('click', (e) => {
            const clickedRow = e.target.closest('tr');
            if (!clickedRow || !clickedRow.dataset.gameId) return;
            document.querySelectorAll('#games-table tbody tr').forEach(row => row.classList.remove('active-row'));
            clickedRow.classList.add('active-row');
            const gameId = clickedRow.dataset.gameId;
            const game = allGames.find(g => g.id == gameId);
            if (game) {
                productListTitle.textContent = `Produk untuk: ${game.name}`;
                renderProductsForGame(gameId);
            }
        });
    }

    if(syncForm) {
        syncForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const marginInput = document.getElementById('margin-percent');
            const syncButton = syncForm.querySelector('button');
            if (confirm(`Anda yakin ingin sinkronisasi produk dengan margin ${marginInput.value}%?`)) {
                syncButton.disabled = true;
                syncButton.textContent = 'Mensinkronkan...';
                try {
                    const response = await fetch(`${ADMIN_API_URL}/sync-products`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ margin_percent: parseFloat(marginInput.value) })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
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

    if (productsTableBody) {
    productsTableBody.addEventListener('change', async (e) => {
        // Cek apakah elemen yang diubah adalah toggle switch kita
        if (e.target.classList.contains('product-status-toggle')) {
            const toggleSwitch = e.target;
            const row = toggleSwitch.closest('tr');
            const productId = row.dataset.productId;
            
            // Tentukan status baru berdasarkan posisi toggle
            const newStatus = toggleSwitch.checked ? 'Active' : 'Inactive';

            // Nonaktifkan tombol sementara untuk mencegah klik ganda
            toggleSwitch.disabled = true;

            try {
                const response = await fetch(`${ADMIN_API_URL}/products/${productId}/status`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ status: newStatus })
                });

                const result = await response.json();

                if (!response.ok) {
                    // Jika gagal, kembalikan posisi toggle ke semula
                    toggleSwitch.checked = !toggleSwitch.checked; 
                    throw new Error(result.message);
                }

                alert(result.message); // Tampilkan pesan sukses

                // Perbarui data produk di state lokal (allProducts) agar tampilan konsisten
                const productIndex = allProducts.findIndex(p => p.id == productId);
                if (productIndex > -1) {
                    allProducts[productIndex].status = newStatus;
                }

            } catch (error) {
                alert(`Error: ${error.message}`);
            } finally {
                // Aktifkan kembali tombol
                toggleSwitch.disabled = false;
            }
        }
    });
}

    if (gamesTableBody) {
    gamesTableBody.addEventListener('change', async (e) => {
        // Cek apakah elemen yang diubah adalah toggle switch game
        if (e.target.classList.contains('game-status-toggle')) {
            const toggleSwitch = e.target;
            const row = toggleSwitch.closest('tr');
            const gameId = row.dataset.gameId;
            
            // Tentukan status baru berdasarkan posisi toggle
            const newStatus = toggleSwitch.checked ? 'Active' : 'Inactive';

            toggleSwitch.disabled = true; // Nonaktifkan sementara

            try {
                const response = await fetch(`${ADMIN_API_URL}/games/${gameId}/status`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ status: newStatus })
                });

                const result = await response.json();

                if (!response.ok) {
                    toggleSwitch.checked = !toggleSwitch.checked; // Kembalikan posisi jika gagal
                    throw new Error(result.message);
                }

                alert(result.message);

                // Perbarui juga data di state lokal (allGames) agar konsisten
                const gameIndex = allGames.findIndex(g => g.id == gameId);
                if (gameIndex > -1) {
                    allGames[gameIndex].status = newStatus;
                }

            } catch (error) {
                alert(`Error: ${error.message}`);
            } finally {
                toggleSwitch.disabled = false; // Aktifkan kembali
            }
        }
    });
}

    // === Menjalankan Fungsi Awal Saat Halaman Dimuat ===
    async function initAdminPage() {
        await fetchAdminGames();
        await fetchAdminProducts();
        await fetchPendingDeposits();
        await populateGamesDropdown();
        await fetchAndDisplayMargins();
    }
    
    initAdminPage();
});