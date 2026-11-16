(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    /**
     * Muat konfigurasi margin persentase global per role reseller.
     */
    async function fetchAndDisplayMargins() {
        const { apiFetch } = global.MikuShared.api;
        const { marginFieldsContainer } = app.state.els;
        if (!marginFieldsContainer) return;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/roles`, { auth: true, token: app.state.token });
            const roles = await response.json();
            marginFieldsContainer.innerHTML = '';
            roles.forEach(role => {
                if (role.name !== 'Admin' && role.name !== 'Owner') {
                    const group = document.createElement('div');
                    group.className = 'form-group-horizontal';
                    group.innerHTML = `<label for="margin-role-${role.id}">${role.name}</label><div><input type="number" id="margin-role-${role.id}" data-role-id="${role.id}" value="${role.margin_percent}" step="0.01" required><span>%</span></div>`;
                    marginFieldsContainer.appendChild(group);
                }
            });
        } catch (error) {
            console.error('Gagal memuat margin:', error);
            marginFieldsContainer.innerHTML = '<p style="color:red">Gagal memuat data margin.</p>';
        }
    }

    /**
     * Eksekusi resolusi transaksi admin (success, refund, atau keep_review).
     */
    async function adminResolveTransaction(invoiceId, action) {
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/transactions/${invoiceId}/resolve`, {
                method: 'PUT',
                auth: true,
                token: app.state.token,
                jsonBody: { action }
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message);
            alert(result.message);
            await fetchAdminTransactions(); // Reload tabel setelah sukses
        } catch (error) {
            alert(`Gagal: ${error.message}`);
        }
    }

    /**
     * Muat seluruh transaksi admin beserta tombol resolve untuk status Pending/Partial Refund.
     */
    async function fetchAdminTransactions() {
        const { formatRupiah, formatDateId, statusClass, statusLabel } = global.MikuShared.format;
        const { apiFetch } = global.MikuShared.api;
        const tbody = document.getElementById('admin-transactions-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center">Memuat transaksi...</td></tr>';
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/transactions`, {
                auth: true,
                token: app.state.token
            });
            if (!response.ok) throw new Error('Gagal memuat transaksi.');
            const transactions = await response.json();
            tbody.innerHTML = '';
            if (transactions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center">Belum ada transaksi.</td></tr>';
                return;
            }
            transactions.forEach(tx => {
                const statusNorm = String(tx.status || '').toLowerCase();
                const txStatusClass = statusClass(tx.status);
                const txStatusLabel = statusNorm === 'refunded'
                    ? (tx.status || 'Pending')
                    : statusLabel(tx.status, 'Perlu Review');
                const formattedPrice = formatRupiah(tx.price);
                const formattedDate = formatDateId(tx.created_at);
                const isPartialRefund = tx.status === 'Partial Refund';
                const isPending = tx.status === 'Pending';
                let actionsHtml = '-';
                if (isPartialRefund) {
                    // Semua aksi tersedia untuk Partial Refund
                    actionsHtml = `
                    <div class="admin-resolve-actions">
                        <button class="resolve-btn resolve-btn-success"
                            data-invoice="${tx.invoice_id}" data-action="success"
                            title="Mark berhasil">✓ Berhasil</button>
                        <button class="resolve-btn resolve-btn-refund"
                            data-invoice="${tx.invoice_id}" data-action="refund"
                            title="Refund dan gagalkan">↩ Refund</button>
                        <button class="resolve-btn resolve-btn-review"
                            data-invoice="${tx.invoice_id}" data-action="keep_review"
                            title="Tandai perlu review">⏸ Review</button>
                    </div>
                    `;
                } else if (isPending) {
                    // Pending: hanya boleh dipindah ke Partial Refund via keep_review
                    actionsHtml = `
                    <div class="admin-resolve-actions">
                        <button class="resolve-btn resolve-btn-review"
                            data-invoice="${tx.invoice_id}" data-action="keep_review"
                            title="Tandai perlu review admin">⏸ Tandai Review</button>
                    </div>
                    `;
                }
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><a href="/invoice.html?id=${tx.invoice_id}" target="_blank" class="history-link">${tx.invoice_id}</a></td>
                    <td>${tx.user_name || '-'}</td>
                    <td>${tx.product_name || '-'}</td>
                    <td>${formattedPrice}</td>
                    <td><span class="status-badge ${txStatusClass}">${txStatusLabel}</span></td>
                    <td>${formattedDate}</td>
                    <td>${actionsHtml}</td>
                `;
                tbody.appendChild(row);
            });

            // Event delegation untuk tombol resolve
            tbody.querySelectorAll('.resolve-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const invoiceId = btn.dataset.invoice;
                    const action = btn.dataset.action;
                    const confirmMessages = {
                        success: `Konfirmasi: Tandai invoice ${invoiceId} sebagai BERHASIL?\nPastikan produk benar-benar sudah dikirimkan ke pelanggan.`,
                        refund: `Konfirmasi: REFUND invoice ${invoiceId}?\nSaldo akan dikembalikan ke user dan status jadi Gagal.`,
                        keep_review: `Konfirmasi: Pertahankan invoice ${invoiceId} dalam status Review Admin?`
                    };
                    if (!confirm(confirmMessages[action])) return;
                    await adminResolveTransaction(invoiceId, action);
                });
            });
        } catch (error) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:red">${error.message}</td></tr>`;
        }
    }

    /**
     * Pasang listener form pembaruan margin global per role reseller.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const { marginForm, marginFieldsContainer } = app.state.els;

        if (marginForm) {
            marginForm.addEventListener('submit', async (e) => {
                e.preventDefault(); // Mencegah halaman refresh
                const saveButton = marginForm.querySelector('button');
                saveButton.disabled = true;
                saveButton.textContent = 'Menyimpan...';

                const marginInputs = marginFieldsContainer.querySelectorAll('input[type="number"]');
                const marginsToUpdate = Array.from(marginInputs).map(input => ({
                    id: input.dataset.roleId,
                    margin: parseFloat(input.value)
                }));

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/roles`, {
                        method: 'PUT',
                        auth: true,
                        token: app.state.token,
                        jsonBody: marginsToUpdate
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);

                    alert('Margin berhasil diperbarui!');
                } catch (error) {
                    alert(`Error: ${error.message}`);
                } finally {
                    saveButton.disabled = false;
                    saveButton.textContent = 'Simpan Semua Margin';
                }
            });
        }
    }

    app.transactionsAndRoles = {
        fetchAndDisplayMargins,
        fetchAdminTransactions,
        adminResolveTransaction,
        bindEvents,
    };
})(window);
