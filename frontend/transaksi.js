document.addEventListener('DOMContentLoaded', function() {
    const API_URL = '/api/user/transactions';
    const token = localStorage.getItem('authToken');
    const tableBody = document.querySelector("#transactions-table tbody");

    // 1. Amankan Halaman: Jika tidak ada token, tendang ke halaman utama
    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    // 2. Fungsi untuk mengambil dan menampilkan riwayat transaksi
    async function fetchTransactions() {
        if (!tableBody) return; // Hentikan jika tabel tidak ditemukan

        try {
            const response = await fetch(API_URL, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.status === 401) { // Sesi habis atau token tidak valid
                localStorage.removeItem('authToken');
                window.location.href = 'index.html';
                return;
            }
            if (!response.ok) {
                throw new Error('Gagal mengambil data transaksi.');
            }

            const transactions = await response.json();
            renderTransactionsTable(transactions);

        } catch (error) {
            console.error('Error:', error);
            tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">Error: ${error.message}</td></tr>`;
        }
    }

    // 3. Fungsi untuk merender data ke dalam tabel
    function renderTransactionsTable(transactions) {
        tableBody.innerHTML = ''; // Kosongkan isi tabel terlebih dahulu

        if (transactions.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Anda belum memiliki riwayat transaksi.</td></tr>';
            return;
        }

        transactions.forEach(tx => {
            const row = document.createElement('tr');
            const formattedPrice = new Intl.NumberFormat('id-ID', {
                style: 'currency',
                currency: 'IDR',
                minimumFractionDigits: 0
            }).format(tx.price);

            // Menambahkan class berdasarkan status transaksi untuk pewarnaan
            const statusClass = `status-${tx.status.toLowerCase()}`;

            row.innerHTML = `
                <td><a href="invoice.html?id=${tx.invoice_id}" class="history-link">${tx.invoice_id}</a></td>
                <td>${new Date(tx.created_at).toLocaleString('id-ID')}</td>
                <td>${tx.product_name}</td>
                <td>${tx.target_game_id}</td>
                <td>${formattedPrice}</td>
                <td><span class="status-badge ${statusClass}">${tx.status}</span></td>
            `;
            tableBody.appendChild(row);
        });
    }

    // 4. Panggil fungsi utama saat halaman dimuat
    fetchTransactions();
});