// compare-prices.js - VERSI FINAL DENGAN PERBAIKAN
let allProductsData = [];
let allGamesData = [];
let allRolesData = [];
let displayRoles = [];

document.addEventListener('DOMContentLoaded', function () {
    const PUBLIC_API_URL = '/api';

    const gameSelectorDropdown = document.getElementById('game-selector-dropdown');
    const compareProductListTitle = document.getElementById('compare-product-list-title');
    const compareTableBody = document.querySelector("#compare-prices-table tbody");
    const compareTableHeader = document.querySelector("#compare-prices-table thead tr");
    const gameSearchInput = document.getElementById('game-search-input');
    
    // Deklarasi untuk tombol scroll
    const tableContainer = document.querySelector('.table-container');
    const scrollLeftBtn = document.getElementById('scroll-left-btn');
    const scrollRightBtn = document.getElementById('scroll-right-btn');

    const PUBLIC_ROLE_ORDER = ['BRONZE', 'PARTNER', 'SILVER', 'GOLD'];

    async function fetchAllCompareData() {
    // Diubah untuk memeriksa dropdown, bukan sidebar list
    if (!compareTableBody || !compareTableHeader || !gameSelectorDropdown) return;

    try {
        const response = await fetch(`${PUBLIC_API_URL}/public/compare-prices`);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Gagal memuat data perbandingan harga dari server.');
        }
        const data = await response.json();

        allProductsData = data.products;
        allGamesData = data.games;
        allRolesData = data.roles;

        displayRoles = allRolesData.filter(role =>
            PUBLIC_ROLE_ORDER.includes(role.name)
        ).sort((a, b) => {
            return PUBLIC_ROLE_ORDER.indexOf(a.name) - PUBLIC_ROLE_ORDER.indexOf(b.name);
        });

        // 1. Memanggil fungsi baru untuk mengisi dropdown
        renderGamesDropdown(allGamesData, displayRoles);
        
        // 2. Mengatur tampilan awal untuk meminta pengguna memilih game
        compareProductListTitle.textContent = "Silakan Pilih Game untuk Melihat Harga";
        renderProductsTable([], displayRoles); // Menampilkan tabel kosong

    } catch (error) {
        console.error('Error fetching compare prices:', error);
        // Menampilkan pesan error di judul dan tabel
        compareProductListTitle.textContent = `Error: ${error.message}`;
        compareTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
    }
}

        function renderGamesDropdown(gamesToRender, rolesToDisplay) {
        gameSelectorDropdown.innerHTML = ''; // Kosongkan pilihan lama
        
        // Tambahkan opsi default
        const defaultOption = document.createElement('option');
        defaultOption.value = "";
        defaultOption.textContent = "-- Pilih Game Disini --";
        gameSelectorDropdown.appendChild(defaultOption);

        if (gamesToRender.length === 0) {
            defaultOption.textContent = "Game tidak ditemukan";
            return;
        }

        gamesToRender.forEach(game => {
            const option = document.createElement('option');
            option.value = game.id; // Gunakan ID sebagai value
            option.textContent = game.name;
            gameSelectorDropdown.appendChild(option);
        });
    }

    function renderProductsTable(products, roles) {
        compareTableBody.innerHTML = '';
        compareTableHeader.innerHTML = '';

        let headerHtml = `<th>Nama Game</th><th>Produk</th><th>SKU</th>`;
        roles.forEach(role => {
            headerHtml += `<th>Harga ${role.name}</th>`;
        });
        compareTableHeader.innerHTML = headerHtml;

        if (products.length === 0) {
            const colspan = 3 + roles.length;
            compareTableBody.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center;">Belum ada produk untuk game ini.</td></tr>`;
            return;
        }

        products.sort((a, b) => parseFloat(a.base_price) - parseFloat(b.base_price));

        products.forEach(product => {
            const row = document.createElement('tr');
            let rowHtml = `<td>${product.game_name}</td><td>${product.product_name}</td><td>${product.provider_sku}</td>`;
            roles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                const formattedRolePrice = new Intl.NumberFormat('id-ID', {
                    style: 'currency', currency: 'IDR', minimumFractionDigits: 0
                }).format(product[rolePriceKey] || 0);
                rowHtml += `<td>${formattedRolePrice}</td>`;
            });
            row.innerHTML = rowHtml;
            compareTableBody.appendChild(row);
        });
    }

     if (gameSelectorDropdown) {
        gameSelectorDropdown.addEventListener('change', (e) => {
            const selectedGameId = e.target.value;

            if (selectedGameId) {
                const selectedGame = allGamesData.find(game => game.id == selectedGameId);
                if (selectedGame) {
                    compareProductListTitle.textContent = `Perbandingan Harga untuk: ${selectedGame.name}`;
                    const filteredProducts = allProductsData.filter(p => p.game_name === selectedGame.name);
                    renderProductsTable(filteredProducts, displayRoles);
                }
            } else {
                compareProductListTitle.textContent = "Silakan Pilih Game untuk Melihat Harga";
                renderProductsTable([], displayRoles);
            }
        });
    }

    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allGamesData.filter(game =>
                game.name.toLowerCase().includes(searchTerm)
            );
            renderGamesDropdown(filteredGames, displayRoles);
        });
    }

    

    fetchAllCompareData();
});