document.addEventListener('DOMContentLoaded', function() {
    const API_URL = 'http://localhost:3000/api/user/balance-history';
    const token = localStorage.getItem('authToken');
    const tableBody = document.querySelector("#mutasi-table tbody");

    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    async function fetchBalanceHistory() {
        try {
            const response = await fetch(API_URL, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (response.status === 401) throw new Error('Sesi habis.');
            if (!response.ok) throw new Error('Gagal mengambil data.');

            const history = await response.json();
            renderTable(history);
        } catch (error) {
            tableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        }
    }

    function renderTable(history) {
        tableBody.innerHTML = ''; // Kosongkan tabel
        if (history.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Belum ada riwayat mutasi saldo.</td></tr>';
            return;
        }

        history.forEach(item => {
            const row = document.createElement('tr');
            const amountClass = item.amount > 0 ? 'amount-in' : 'amount-out';
            const amountSign = item.amount > 0 ? '+' : '';

            row.innerHTML = `
                <td>${new Date(item.created_at).toLocaleString('id-ID')}</td>
                <td><span class="badge type-${item.type.toLowerCase()}">${item.type}</span></td>
                <td>${item.description}</td>
                <td class="${amountClass}">${amountSign} ${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(item.amount)}</td>
            `;
            tableBody.appendChild(row);
        });
    }

    fetchBalanceHistory();
});