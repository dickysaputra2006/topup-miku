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

    function renderProductsTable(products, roles) {
        compareTableBody.innerHTML = '';
        compareTableHeader.innerHTML = '';

        let headerHtml = '<th>Nama Game</th><th>Produk</th><th>SKU</th>';
        roles.forEach(role => {
            headerHtml += `<th>Harga ${escapeHtml(role.name)}</th>`;
        });
        compareTableHeader.innerHTML = headerHtml;

        if (!Array.isArray(products) || products.length === 0) {
            const colspan = 3 + roles.length;
            compareTableBody.innerHTML = `<tr class="table-empty-row"><td colspan="${colspan}"><div class="ui-state empty">Pilih game di panel samping untuk melihat daftar harga produk.</div></td></tr>`;
            return;
        }

        const sorted = [...products].sort((a, b) => parseFloat(a.base_price) - parseFloat(b.base_price));
        sorted.forEach(product => {
            const row = document.createElement('tr');
            let rowHtml = `<td>${escapeHtml(product.game_name || '-')}</td><td>${escapeHtml(product.product_name || '-')}</td><td><code>${escapeHtml(product.provider_sku || '-')}</code></td>`;
            roles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                rowHtml += `<td>${escapeHtml(formatRupiah(product[rolePriceKey] || 0))}</td>`;
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
