// compare-prices.js - VERSI FINAL DENGAN PERBAIKAN
let allProductsData = [];
let allGamesData = [];
let allRolesData = [];
let displayRoles = [];

document.addEventListener('DOMContentLoaded', function () {
    const PUBLIC_API_URL = 'https://topup-miku.onrender.com/api';

    const compareGamesList = document.getElementById('compare-games-list');
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
        if (!compareTableBody || !compareTableHeader || !compareGamesList) return;

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

            renderGamesSidebar(allGamesData, displayRoles);

            if (allGamesData.length > 0) {
                const firstGame = allGamesData[0];
                compareProductListTitle.textContent = `Perbandingan Harga untuk: ${firstGame.name}`;

                const firstGameLink = compareGamesList.querySelector(`[data-game-id="${firstGame.id}"]`);
                if (firstGameLink) firstGameLink.classList.add('active');

                renderProductsTable(
                    allProductsData.filter(p => p.game_name === firstGame.name),
                    displayRoles
                );
            } else {
                compareProductListTitle.textContent = "Tidak ada game tersedia.";
                renderProductsTable([], displayRoles);
            }

        } catch (error) {
            console.error('Error fetching compare prices:', error);
            compareGamesList.innerHTML = `<p style="text-align: center; color: red;">Error: ${error.message}</p>`;
            compareTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        }
    }

    function renderGamesSidebar(gamesToRender, rolesToDisplay) {
        compareGamesList.innerHTML = '';
        if (gamesToRender.length === 0) {
            compareGamesList.innerHTML = '<p style="text-align: center; color: #aaa;">Tidak ada game ditemukan.</p>';
            return;
        }

        gamesToRender.forEach(game => {
            const gameLink = document.createElement('a');
            gameLink.href = "#";
            gameLink.classList.add('dashboard-nav-link');
            gameLink.dataset.gameId = game.id;
            gameLink.textContent = game.name;
            gameLink.addEventListener('click', (e) => {
                e.preventDefault();
                document.querySelectorAll('#compare-games-list .dashboard-nav-link').forEach(link => link.classList.remove('active'));
                gameLink.classList.add('active');
                compareProductListTitle.textContent = `Perbandingan Harga untuk: ${game.name}`;

                renderProductsTable(
                    allProductsData.filter(p => p.game_name === game.name),
                    rolesToDisplay
                );
            });

            compareGamesList.appendChild(gameLink);
        });

        // Pilih game pertama secara default jika ada
        const firstLink = compareGamesList.querySelector('.dashboard-nav-link');
        if (firstLink) {
            firstLink.classList.add('active');
        }
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

    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allGamesData.filter(game =>
                game.name.toLowerCase().includes(searchTerm)
            );
            renderGamesSidebar(filteredGames, displayRoles);
        });
    }

    // Fungsi untuk tombol scroll
    if (tableContainer && scrollLeftBtn && scrollRightBtn) {
        scrollLeftBtn.addEventListener('click', () => {
            tableContainer.scrollBy({ left: -250, behavior: 'smooth' });
        });
        scrollRightBtn.addEventListener('click', () => {
            tableContainer.scrollBy({ left: 250, behavior: 'smooth' });
        });
    }

    fetchAllCompareData();
});