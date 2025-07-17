// compare-prices.js

let allProductsData = []; 
let allGamesData = [];    
let allRolesData = [];    
let displayRoles = []; 

document.addEventListener('DOMContentLoaded', function() {
    const PUBLIC_API_URL = 'https://topup-miku.onrender.com/api'; 
    
    const compareGamesList = document.getElementById('compare-games-list');
    const compareProductListTitle = document.getElementById('compare-product-list-title');
    const compareTableBody = document.querySelector("#compare-prices-table tbody");
    const compareTableHeader = document.querySelector("#compare-prices-table thead tr");
    const gameSearchInput = document.getElementById('game-search-input');
    
    const PUBLIC_ROLE_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PARTNER']; 

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

            console.log("DEBUG: Data fetched - Products:", allProductsData.length, "Games:", allGamesData.length, "Roles:", allRolesData.length);
            if (allProductsData.length > 0) {
                console.log("DEBUG: Example product object:", allProductsData[0]);
                console.log("DEBUG: Type of product.game_id:", typeof allProductsData[0].game_id); // Log tipe data game_id di produk
            }
            
            displayRoles = allRolesData.filter(role => 
                PUBLIC_ROLE_ORDER.includes(role.name) 
            ).sort((a, b) => { 
                const indexA = PUBLIC_ROLE_ORDER.indexOf(a.name);
                const indexB = PUBLIC_ROLE_ORDER.indexOf(b.name);
                return indexA - indexB;
            });

            console.log("DEBUG: Display Roles (filtered & sorted):", displayRoles);

            renderGamesSidebar(allGamesData, displayRoles); 
            
            if (allGamesData.length > 0) {
                const firstGameId = allGamesData[0].id;
                const firstGameName = allGamesData[0].name;
                compareProductListTitle.textContent = `Perbandingan Harga untuk: ${firstGameName}`;
                
                const firstGameLink = compareGamesList.querySelector(`[data-game-id="${firstGameId}"]`);
                if(firstGameLink) firstGameLink.classList.add('active');

                // === PERBAIKAN: Pastikan perbandingan ID adalah number untuk kedua sisi ===
                // Mengkonversi game_id dari produk ke number jika perlu, dan membandingkan dengan ID game yang sudah Number
                renderProductsTable(allProductsData.filter(p => Number(p.game_id) === Number(firstGameId)), displayRoles); 
                // =========================================================

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
            gameLink.dataset.gameId = game.id; // game.id sudah number dari backend
            gameLink.textContent = game.name;
            gameLink.addEventListener('click', (e) => {
                e.preventDefault();
                document.querySelectorAll('#compare-games-list .dashboard-nav-link').forEach(link => link.classList.remove('active'));
                gameLink.classList.add('active');
                compareProductListTitle.textContent = `Perbandingan Harga untuk: ${game.name}`;
                // === PERBAIKAN: Pastikan perbandingan ID adalah number untuk kedua sisi ===
                renderProductsTable(allProductsData.filter(p => Number(p.game_id) === Number(game.id)), rolesToDisplay); 
                // =========================================================
            });
            compareGamesList.appendChild(gameLink);
        });
        if (gamesToRender.length > 0 && compareGamesList.querySelector('.dashboard-nav-link')) {
            compareGamesList.querySelector('.dashboard-nav-link').classList.add('active');
        }
    }

    function renderProductsTable(products, roles) { 
        compareTableBody.innerHTML = '';
        compareTableHeader.innerHTML = ''; 

        let headerHtml = `<th>Nama Game</th><th>Produk</th><th>SKU</th><th>Harga Pokok</th>`;
        roles.forEach(role => {
            headerHtml += `<th>Harga ${role.name}</th>`; 
        });
        compareTableHeader.innerHTML = headerHtml;

        if (products.length === 0) {
            const colspan = 4 + roles.length; 
            compareTableBody.innerHTML = `<tr><td colspan="${colspan}" style="text-align: center;">Belum ada produk untuk game ini.</td></tr>`;
            return;
        }

        products.sort((a, b) => a.base_price - b.base_price);

        products.forEach(product => {
            const row = document.createElement('tr');
            // base_price dari backend adalah string ('10522.00'), harus diubah ke number untuk Intl.NumberFormat
            const formattedBasePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(parseFloat(product.base_price));
            let rowHtml = `<td>${product.game_name}</td><td>${product.product_name}</td><td>${product.provider_sku}</td><td>${formattedBasePrice}</td>`;
            
            roles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                const formattedRolePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(product[rolePriceKey] || 0);
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

    fetchAllCompareData(); 
});