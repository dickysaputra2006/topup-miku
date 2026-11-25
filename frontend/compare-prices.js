'use strict';

let allProductsData = [];
let allGamesData = [];
let allRolesData = [];
let displayRoles = [];

document.addEventListener('DOMContentLoaded', function () {
    const { formatRupiah } = window.MikuShared.format;
    const { escapeHtml } = window.MikuShared.dom;
    const PUBLIC_API_URL = '/api';

    const gameSelectorDropdown = document.getElementById('game-selector-dropdown');
    const compareProductListTitle = document.getElementById('compare-product-list-title');
    const compareTableBody = document.querySelector('#compare-prices-table tbody');
    const compareTableHeader = document.querySelector('#compare-prices-table thead tr');
    const gameSearchInput = document.getElementById('game-search-input');

    const PUBLIC_ROLE_ORDER = ['BRONZE', 'PARTNER', 'SILVER', 'GOLD'];

    async function fetchAllCompareData() {
        if (!compareTableBody || !compareTableHeader || !gameSelectorDropdown) return;

        try {
            const response = await fetch(`${PUBLIC_API_URL}/public/compare-prices`);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || 'Gagal memuat data perbandingan harga dari server.');
            }
            const data = await response.json();

            allProductsData = Array.isArray(data.products) ? data.products : [];
            allGamesData = Array.isArray(data.games) ? data.games : [];
            allRolesData = Array.isArray(data.roles) ? data.roles : [];

            displayRoles = allRolesData
                .filter(role => PUBLIC_ROLE_ORDER.includes(role.name))
                .sort((a, b) => PUBLIC_ROLE_ORDER.indexOf(a.name) - PUBLIC_ROLE_ORDER.indexOf(b.name));

            renderGamesDropdown(allGamesData);
            compareProductListTitle.textContent = 'Silakan Pilih Game untuk Melihat Harga';
            renderProductsTable([], displayRoles);
        } catch (error) {
            console.error('Error fetching compare prices:', error);
            compareProductListTitle.textContent = 'Gagal Memuat Perbandingan Harga';
            compareTableBody.innerHTML = `<tr class="table-error-row"><td colspan="5"><div class="ui-state error">Error: ${escapeHtml(error.message)}</div></td></tr>`;
        }
    }

    function renderGamesDropdown(gamesToRender) {
        gameSelectorDropdown.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = gamesToRender.length === 0 ? 'Game tidak ditemukan' : '-- Pilih Game Disini --';
        gameSelectorDropdown.appendChild(defaultOption);

        gamesToRender.forEach(game => {
            const option = document.createElement('option');
            option.value = game.id;
            option.textContent = game.name;
            gameSelectorDropdown.appendChild(option);
        });
    }

    function getSortPrice(product, roles) {
        const bronze = Number(product && product.price_bronze);
        if (Number.isFinite(bronze)) return bronze;
        if (Array.isArray(roles)) {
            for (const role of roles) {
                const val = Number(product && product[`price_${String(role.name || '').toLowerCase()}`]);
                if (Number.isFinite(val)) return val;
            }
        }
        return 0;
    }

    function findHighlightedTier(roles, products) {
        if (!Array.isArray(roles) || roles.length === 0) return '';
        if (Array.isArray(products) && products.length > 0) {
            const sample = products[0];
            let bestName = '';
            let lowestPrice = Infinity;
            roles.forEach(role => {
                const p = Number(sample[`price_${String(role.name || '').toLowerCase()}`]);
                if (Number.isFinite(p) && p > 0 && p < lowestPrice) {
                    lowestPrice = p;
                    bestName = role.name;
                } else if (Number.isFinite(p) && p === lowestPrice && (role.name === 'PARTNER' || role.name === 'GOLD')) {
                    bestName = role.name;
                }
            });
            if (bestName) return bestName;
        }
        if (roles.some(r => r.name === 'PARTNER')) return 'PARTNER';
        if (roles.some(r => r.name === 'GOLD')) return 'GOLD';
        return '';
    }

    function renderProductsTable(products, roles) {
        compareTableBody.innerHTML = '';
        compareTableHeader.innerHTML = '';
        const highlightedTier = findHighlightedTier(roles, products);

        let headerHtml = '<th>Nama Game</th><th>Produk</th><th>SKU</th>';
        roles.forEach(role => {
            if (role.name === highlightedTier) {
                headerHtml += `<th class="col-tier-highlight"><span class="tier-th-wrap"><span>Harga ${escapeHtml(role.name)}</span><span class="tier-highlight-badge">Terbaik Reseller</span></span></th>`;
            } else {
                headerHtml += `<th>Harga ${escapeHtml(role.name)}</th>`;
            }
        });
        compareTableHeader.innerHTML = headerHtml;

        if (!Array.isArray(products) || products.length === 0) {
            const colspan = 3 + roles.length;
            compareTableBody.innerHTML = `<tr class="table-empty-row"><td colspan="${colspan}"><div class="ui-state empty">Pilih game di panel samping untuk melihat daftar harga produk.</div></td></tr>`;
            return;
        }

        const sorted = [...products].sort((a, b) => getSortPrice(a, roles) - getSortPrice(b, roles));
        sorted.forEach(product => {
            const row = document.createElement('tr');
            let rowHtml = `<td>${escapeHtml(product.game_name || '-')}</td><td>${escapeHtml(product.product_name || '-')}</td><td><code>${escapeHtml(product.provider_sku || '-')}</code></td>`;
            roles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                const colClass = role.name === highlightedTier ? ' class="col-tier-highlight"' : '';
                rowHtml += `<td${colClass}>${escapeHtml(formatRupiah(product[rolePriceKey] || 0))}</td>`;
            });
            row.innerHTML = rowHtml;
            compareTableBody.appendChild(row);
        });
    }

    if (gameSelectorDropdown) {
        gameSelectorDropdown.addEventListener('change', (e) => {
            const selectedGameId = e.target.value;
            if (selectedGameId) {
                const selectedGame = allGamesData.find(game => String(game.id) === String(selectedGameId));
                if (selectedGame) {
                    compareProductListTitle.textContent = `Perbandingan Harga untuk: ${selectedGame.name}`;
                    const filteredProducts = allProductsData.filter(p => p.game_name === selectedGame.name);
                    renderProductsTable(filteredProducts, displayRoles);
                }
            } else {
                compareProductListTitle.textContent = 'Silakan Pilih Game untuk Melihat Harga';
                renderProductsTable([], displayRoles);
            }
        });
    }

    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allGamesData.filter(game => game.name.toLowerCase().includes(searchTerm));
            renderGamesDropdown(filteredGames);
        });
    }

    fetchAllCompareData();
});
