// compare-prices.js
document.addEventListener('DOMContentLoaded', function() {
    const PUBLIC_API_URL = 'https://topup-miku.onrender.com/api';
    const compareTableBody = document.querySelector("#compare-prices-table tbody");
    const compareTableHeader = document.querySelector("#compare-prices-table thead tr");

    async function fetchComparePrices() {
        if (!compareTableBody || !compareTableHeader) return;

        try {
            const response = await fetch(`${PUBLIC_API_URL}/public/compare-prices`);
            if (!response.ok) throw new Error('Gagal memuat data perbandingan harga.');
            const data = await response.json(); // Data akan berisi { products, roles }

            renderCompareTable(data.products, data.roles);

        } catch (error) {
            console.error('Error fetching compare prices:', error);
            compareTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        }
    }

    function renderCompareTable(products, roles) {
        compareTableBody.innerHTML = '';
        compareTableHeader.innerHTML = ''; // Kosongkan header

        if (products.length === 0) {
            compareTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Belum ada produk untuk perbandingan harga.</td></tr>';
            return;
        }

        // Bangun header tabel dinamis
        let headerHtml = `<th>Nama Game</th><th>Produk</th><th>SKU</th><th>Harga Pokok</th>`;
        const sortedRoles = roles.sort((a, b) => parseFloat(a.margin_percent) - parseFloat(b.margin_percent)); // Urutkan berdasarkan margin terendah
        sortedRoles.forEach(role => {
            headerHtml += `<th>Harga ${role.name}</th>`;
        });
        compareTableHeader.innerHTML = headerHtml;

        // Isi body tabel
        products.forEach(product => {
            const row = document.createElement('tr');
            const formattedBasePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product.base_price);
            let rowHtml = `<td>${product.game_name}</td><td>${product.product_name}</td><td>${product.provider_sku}</td><td>${formattedBasePrice}</td>`;
            
            sortedRoles.forEach(role => {
                const rolePriceKey = `price_${role.name.toLowerCase()}`;
                const formattedRolePrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product[rolePriceKey] || 0);
                rowHtml += `<td>${formattedRolePrice}</td>`;
            });
            row.innerHTML = rowHtml;
            compareTableBody.appendChild(row);
        });
    }

    fetchComparePrices();
});