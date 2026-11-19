(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    const statusLabel = (status) => global.MikuShared.format.statusLabel(status, 'Perlu Review');

    /**
     * Render baris tabel riwayat transaksi user sesuai filter status aktif.
     */
    function renderTransactionsTable(transactions, tableBody) {
        const { formatRupiah, formatDateId, statusClass } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        if (!tableBody) return;

        const filter = app.state.txStatusFilter || 'all';
        const filtered = filter === 'all'
            ? transactions
            : transactions.filter(tx => String(tx.status || '').toLowerCase() === filter.toLowerCase());

        const countEl = document.getElementById('tx-filter-count');
        if (countEl) {
            countEl.textContent = transactions.length > 0 ? `${filtered.length} dari ${transactions.length} transaksi` : '';
        }

        tableBody.innerHTML = '';
        if (transactions.length === 0) {
            tableBody.innerHTML = `
                <tr class="table-empty-row">
                    <td colspan="6">
                        <div class="table-empty-cta">
                            <p>Belum ada transaksi. Mulai top up pertama Anda.</p>
                            <a href="index.html" class="topup-btn empty-cta-btn">Mulai Top Up</a>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        if (filtered.length === 0) {
            tableBody.innerHTML = `
                <tr class="table-empty-row">
                    <td colspan="6">
                        <div class="table-empty-cta">
                            <p>Tidak ada transaksi untuk filter status ini.</p>
                            <button type="button" class="edit-btn reset-tx-filter-btn">Reset Filter</button>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        filtered.forEach(tx => {
            const row = document.createElement('tr');
            const formattedPrice = formatRupiah(tx.price);
            row.innerHTML = `
                <td><a href="invoice.html?id=${encodeURIComponent(tx.invoice_id)}" class="history-link dashboard-tx-invoice-link" title="${escapeHtml(tx.invoice_id)}">${escapeHtml(tx.invoice_id)}</a></td>
                <td class="tabular-nums">${escapeHtml(formatDateId(tx.created_at))}</td>
                <td>${escapeHtml(tx.product_name)}</td>
                <td title="${escapeHtml(tx.target_game_id)}">${escapeHtml(tx.target_game_id)}</td>
                <td class="tabular-nums">${escapeHtml(formattedPrice)}</td>
                <td><span class="status-badge ${statusClass(tx.status)}">${escapeHtml(statusLabel(tx.status))}</span></td>
            `;
            tableBody.appendChild(row);
        });
    }

    function setTxStatusFilter(statusValue) {
        app.state.txStatusFilter = statusValue || 'all';
        document.querySelectorAll('.tx-filter-chip').forEach(chip => {
            const isMatch = chip.dataset.status === app.state.txStatusFilter;
            chip.classList.toggle('active', isMatch);
            chip.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
        });
        const tableBody = document.querySelector('#transactions-table tbody');
        if (tableBody && app.state.transaksiLoaded) {
            renderTransactionsTable(app.state.cachedTransactions || [], tableBody);
        }
    }

    /**
     * Ambil dan tampilkan riwayat transaksi user pada tab Riwayat Transaksi.
     */
    async function fetchTransactions() {
        const { escapeHtml, tableState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tableBody = document.querySelector('#transactions-table tbody');
        if (!tableBody) return;
        tableBody.innerHTML = tableState(6, 'Memuat riwayat transaksi...', 'loading');
        try {
            const response = await apiFetch(`${app.API_URL}/transactions`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal mengambil data transaksi.');
            const transactions = await response.json();
            app.state.cachedTransactions = Array.isArray(transactions) ? transactions : [];
            app.state.transaksiLoaded = true;
            renderTransactionsTable(app.state.cachedTransactions, tableBody);
        } catch (error) {
            tableBody.innerHTML = tableState(6, escapeHtml(error.message), 'error');
        }
    }

    /**
     * Render baris tabel mutasi saldo user.
     */
    function renderMutasiTable(history, tableBody) {
        const { formatRupiah, formatDateId } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (!Array.isArray(history) || history.length === 0) {
            tableBody.innerHTML = `
                <tr class="table-empty-row">
                    <td colspan="4">
                        <div class="table-empty-cta">
                            <p>Belum ada mutasi saldo. Mutasi tercetak otomatis saat deposit disetujui atau order diproses.</p>
                            <a href="#" data-target="deposit-tab" class="edit-btn dashboard-nav-link">Isi Saldo</a>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }
        history.forEach(item => {
            const row = document.createElement('tr');
            const amountClass = item.amount > 0 ? 'amount-in' : 'amount-out';
            const amountSign = item.amount > 0 ? '+' : '';
            const safeType = String(item.type || 'Mutasi');
            row.innerHTML = `
                <td class="tabular-nums">${escapeHtml(formatDateId(item.created_at))}</td>
                <td><span class="badge type-${escapeHtml(safeType.toLowerCase())}">${escapeHtml(safeType)}</span></td>
                <td>${escapeHtml(item.description)}</td>
                <td class="${amountClass} tabular-nums">${amountSign} ${escapeHtml(formatRupiah(item.amount, { withDecimals: true }))}</td>
            `;
            tableBody.appendChild(row);
        });
    }

    /**
     * Ambil dan tampilkan riwayat mutasi saldo user.
     */
    async function fetchBalanceHistory() {
        const { escapeHtml, tableState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tableBody = document.querySelector('#mutasi-table tbody');
        if (!tableBody) return;
        tableBody.innerHTML = tableState(4, 'Memuat riwayat mutasi saldo...', 'loading');
        try {
            const response = await apiFetch(`${app.API_URL}/balance-history`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal mengambil data mutasi.');
            const history = await response.json();
            renderMutasiTable(history, tableBody);
            app.state.mutasiLoaded = true;
        } catch (error) {
            tableBody.innerHTML = tableState(4, escapeHtml(error.message), 'error');
        }
    }

    function renderHasilPencarian(tx) {
        const { formatRupiah, formatDateId, statusClass } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { hasilCekPesanan } = app.state.els;
        const formattedPrice = formatRupiah(tx.price, { withDecimals: true });
        const formattedDate = formatDateId(tx.created_at, { dateStyle: 'full', timeStyle: 'short' });

        hasilCekPesanan.innerHTML = `
            <h4>Detail Transaksi</h4>
            <div tabindex="0" role="region" aria-label="Detail transaksi pesanan" class="table-container">
                <table>
                    <tbody>
                        <tr><td>No. Invoice</td><td><strong>${escapeHtml(tx.invoice_id)}</strong></td></tr>
                        <tr><td>Tanggal</td><td><strong>${escapeHtml(formattedDate)}</strong></td></tr>
                        <tr><td>Produk</td><td><strong>${escapeHtml(tx.product_name)} (${escapeHtml(tx.game_name)})</strong></td></tr>
                        <tr><td>ID Tujuan</td><td><strong>${escapeHtml(String(tx.target_game_id || '').replace('|', ' '))}</strong></td></tr>
                        <tr><td>Total Bayar</td><td class="tabular-nums"><strong>${escapeHtml(formattedPrice)}</strong></td></tr>
                        <tr><td>Status</td><td><span class="status-badge ${statusClass(tx.status)}">${escapeHtml(statusLabel(tx.status))}</span></td></tr>
                    </tbody>
                </table>
            </div>
            <a href="invoice.html?id=${encodeURIComponent(tx.invoice_id)}" class="history-link detail-invoice-link">Lihat Halaman Invoice &rarr;</a>
        `;
        hasilCekPesanan.classList.remove('hidden');
    }

    /**
     * Pasang listener filter status transaksi, reset filter, dan pencarian invoice pesanan.
     */
    function bindEvents() {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const { cekPesananForm, hasilCekPesanan } = app.state.els;

        const filterBar = document.getElementById('tx-filter-bar');
        if (filterBar) {
            filterBar.addEventListener('click', (e) => {
                const chip = e.target.closest('.tx-filter-chip');
                if (chip) setTxStatusFilter(chip.dataset.status || 'all');
            });
        }

        const txTable = document.getElementById('transactions-table');
        if (txTable) {
            txTable.addEventListener('click', (e) => {
                if (e.target.closest('.reset-tx-filter-btn')) setTxStatusFilter('all');
            });
        }

        const mutasiTable = document.getElementById('mutasi-table');
        if (mutasiTable) {
            mutasiTable.addEventListener('click', (e) => {
                const link = e.target.closest('.dashboard-nav-link[data-target]');
                if (!link) return;
                e.preventDefault();
                const sidebarTarget = document.querySelector(`.sidebar-nav .dashboard-nav-link[data-target="${link.dataset.target}"]`);
                if (sidebarTarget) sidebarTarget.click();
            });
        }

        if (cekPesananForm) {
            cekPesananForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const invoiceInput = document.getElementById('invoice-search-input');
                const invoiceId = invoiceInput.value.trim();
                const submitButton = cekPesananForm.querySelector('button[type="submit"]');

                if (!invoiceId) return;
                if (!/^[A-Za-z0-9_-]{3,64}$/.test(invoiceId)) {
                    hasilCekPesanan.classList.remove('hidden');
                    hasilCekPesanan.innerHTML = '<div class="ui-state error">Format Invoice ID tidak valid (3-64 karakter huruf, angka, _ atau -).</div>';
                    return;
                }

                submitButton.disabled = true;
                submitButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Mencari...';
                hasilCekPesanan.classList.remove('hidden');
                hasilCekPesanan.innerHTML = '<div class="ui-state loading">Mencari transaksi...</div>';

                try {
                    const response = await apiFetch(`${app.API_URL}/transaction/${encodeURIComponent(invoiceId)}`, {
                        auth: true,
                        token: app.state.token,
                    });
                    if (response.status === 404) {
                        throw new Error(`Transaksi dengan Invoice ID "${invoiceId}" tidak ditemukan.`);
                    }
                    if (!response.ok) throw new Error('Gagal mengambil data transaksi.');
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
        renderTransactionsTable,
        renderMutasiTable,
        setTxStatusFilter,
        bindEvents,
    };
})(window);
