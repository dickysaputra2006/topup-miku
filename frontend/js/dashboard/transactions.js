(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    const statusLabel = (status) => global.MikuShared.format.statusLabel(status, 'Perlu Review');

    /**
     * Render baris tabel riwayat transaksi user.
     */
    function renderTransactionsTable(transactions, tableBody) {
        const { formatRupiah, formatDateId, statusClass } = global.MikuShared.format;
        const { escapeHtml, tableState } = global.MikuShared.dom;
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (transactions.length === 0) {
            tableBody.innerHTML = tableState(6, 'Belum ada transaksi. Pesanan baru akan muncul di sini.', 'empty');
            return;
        }
        transactions.forEach(tx => {
            const row = document.createElement('tr');
            const formattedPrice = formatRupiah(tx.price);
            row.innerHTML = `
                    <td><a href="invoice.html?id=${encodeURIComponent(tx.invoice_id)}" class="history-link">${escapeHtml(tx.invoice_id)}</a></td>
                    <td>${formatDateId(tx.created_at)}</td>
                    <td>${tx.product_name}</td>
                    <td>${tx.target_game_id}</td>
                    <td>${formattedPrice}</td>
                    <td><span class="status-badge ${statusClass(tx.status)}">${statusLabel(tx.status)}</span></td>
                `;
            tableBody.appendChild(row);
        });
    }

    /**
     * Ambil dan tampilkan riwayat transaksi user pada tab Riwayat Transaksi.
     */
    async function fetchTransactions() {
        const { tableState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tableBody = document.querySelector("#transactions-table tbody");
        if (!tableBody) return;
        tableBody.innerHTML = tableState(6, 'Memuat riwayat transaksi...', 'loading');
        try {
            const response = await apiFetch(`${app.API_URL}/transactions`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal mengambil data transaksi.');
            const transactions = await response.json();
            renderTransactionsTable(transactions, tableBody);
            app.state.transaksiLoaded = true;
        } catch (error) {
            tableBody.innerHTML = tableState(6, error.message, 'error');
        }
    }

    /**
     * Render baris tabel mutasi saldo user.
     */
    function renderMutasiTable(history, tableBody) {
        const { formatRupiah, formatDateId } = global.MikuShared.format;
        const { tableState } = global.MikuShared.dom;
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (history.length === 0) {
            tableBody.innerHTML = tableState(4, 'Belum ada mutasi saldo.', 'empty');
            return;
        }
        history.forEach(item => {
            const row = document.createElement('tr');
            const amountClass = item.amount > 0 ? 'amount-in' : 'amount-out';
            const amountSign = item.amount > 0 ? '+' : '';
            row.innerHTML = `
                <td>${formatDateId(item.created_at)}</td>
                <td><span class="badge type-${item.type.toLowerCase()}">${item.type}</span></td>
                <td>${item.description}</td>
                <td class="${amountClass}">${amountSign} ${formatRupiah(item.amount, { withDecimals: true })}</td>
            `;
            tableBody.appendChild(row);
        });
    }

    /**
     * Ambil dan tampilkan riwayat mutasi saldo user.
     */
    async function fetchBalanceHistory() {
        const { tableState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tableBody = document.querySelector("#mutasi-table tbody");
        if (!tableBody) return;
        tableBody.innerHTML = tableState(4, 'Memuat riwayat mutasi saldo...', 'loading');
        try {
            const response = await apiFetch(`${app.API_URL}/balance-history`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal mengambil data mutasi.');
            const history = await response.json();
            renderMutasiTable(history, tableBody);
            app.state.mutasiLoaded = true;
        } catch (error) {
            tableBody.innerHTML = tableState(4, error.message, 'error');
        }
    }

    function renderHasilPencarian(tx) {
        const { formatRupiah, formatDateId, statusClass } = global.MikuShared.format;
        const { hasilCekPesanan } = app.state.els;
        const formattedPrice = formatRupiah(tx.price, { withDecimals: true });
        const formattedDate = formatDateId(tx.created_at, { dateStyle: 'full', timeStyle: 'short' });

        hasilCekPesanan.innerHTML = `
        <h4>Detail Transaksi</h4>
            <div class="table-container">
                <table style="white-space: nowrap;">
                    <tbody>
                        <tr><td>No. Invoice</td><td><strong>${tx.invoice_id}</strong></td></tr>
                        <tr><td>Tanggal</td><td><strong>${formattedDate}</strong></td></tr>
                        <tr><td>Produk</td><td><strong>${tx.product_name} (${tx.game_name})</strong></td></tr>
                        <tr><td>ID Tujuan</td><td><strong>${tx.target_game_id.replace('|', ' ')}</strong></td></tr>
                        <tr><td>Total Bayar</td><td><strong>${formattedPrice}</strong></td></tr>
                        <tr><td>Status</td><td><strong><span class="status-badge ${statusClass(tx.status)}">${statusLabel(tx.status)}</span></strong></td></tr>
                    </tbody>
                </table>
            </div>
            <a href="invoice.html?id=${tx.invoice_id}" class="history-link" style="margin-top: 1rem; display: inline-block;">Lihat Halaman Invoice &rarr;</a>
        `;
        hasilCekPesanan.classList.remove('hidden');
    }

    /**
     * Pasang listener pencarian pesanan berdasarkan nomor invoice.
     */
    function bindEvents() {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const { cekPesananForm, hasilCekPesanan } = app.state.els;

        if (cekPesananForm) {
            cekPesananForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const invoiceInput = document.getElementById('invoice-search-input');
                const invoiceId = invoiceInput.value.trim();
                const submitButton = cekPesananForm.querySelector('button');

                if (!invoiceId) return;
                if (!/^[A-Za-z0-9_-]{3,64}$/.test(invoiceId)) {
                    hasilCekPesanan.classList.remove('hidden');
                    hasilCekPesanan.innerHTML = '<div class="ui-state error">Format Invoice ID tidak valid (3-64 karakter huruf, angka, _ atau -).</div>';
                    return;
                }

                submitButton.disabled = true;
                submitButton.textContent = 'Mencari...';
                hasilCekPesanan.classList.remove('hidden');
                hasilCekPesanan.innerHTML = '<div class="ui-state loading">Mencari transaksi...</div>';

                try {
                    // Kita gunakan endpoint yang sudah ada
                    const response = await apiFetch(`${app.API_URL}/transaction/${encodeURIComponent(invoiceId)}`, {
                        auth: true,
                        token: app.state.token
                    });

                    if (response.status === 404) {
                        throw new Error(`Transaksi dengan Invoice ID "${invoiceId}" tidak ditemukan.`);
                    }
                    if (!response.ok) {
                        throw new Error('Gagal mengambil data transaksi.');
                    }

                    const tx = await response.json();
                    renderHasilPencarian(tx);

                } catch (error) {
                    hasilCekPesanan.classList.remove('hidden');
                    hasilCekPesanan.innerHTML = `<div class="ui-state error">${escapeHtml(error.message)}</div>`;
                } finally {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Cari Transaksi';
                }
            });
        }
    }

    app.transactions = {
        fetchTransactions,
        fetchBalanceHistory,
        bindEvents,
    };
})(window);
