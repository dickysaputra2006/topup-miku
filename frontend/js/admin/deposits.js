(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    /**
     * Render daftar request deposit admin beserta tombol Approve/Reject atau badge Final.
     */
    function renderAdminDepositsTable(deposits) {
        const { formatRupiah, formatDateId } = global.MikuShared.format;
        const { adminDepositsTbody } = app.state.els;
        if (!adminDepositsTbody) return;
        adminDepositsTbody.innerHTML = '';
        if (!deposits || deposits.length === 0) {
            adminDepositsTbody.innerHTML = '<tr><td colspan="10" style="text-align:center">Tidak ada data deposit.</td></tr>';
            return;
        }
        const fmt = (n) => formatRupiah(n);
        const methodIcon = { GoPay: '🟢', DANA: '🟡', ShopeePay: '🟠', SeaBank: '🔵' };
        deposits.forEach(deposit => {
            const nominal = Number(deposit.amount) - Number(deposit.unique_code);
            const statusNorm = (deposit.status || '').toLowerCase();
            let badgeClass = 'status-pending';
            let badgeLabel = deposit.status || '-';
            if (statusNorm === 'approved') { badgeClass = 'status-success'; badgeLabel = 'Approved'; }
            else if (statusNorm === 'success') { badgeClass = 'status-success'; badgeLabel = 'Approved (Lama)'; }
            else if (statusNorm === 'rejected') { badgeClass = 'status-failed'; badgeLabel = 'Rejected'; }
            else if (statusNorm === 'pending') { badgeClass = 'status-pending'; badgeLabel = 'Pending'; }

            let actionsHtml;
            if (statusNorm === 'pending') {
                actionsHtml = `
                    <div class="admin-resolve-actions">
                        <button class="resolve-btn resolve-btn-success deposit-approve-btn"
                            data-id="${deposit.id}"
                            title="Approve deposit ini. Saldo user akan bertambah.">✓ Approve</button>
                        <button class="resolve-btn resolve-btn-refund deposit-reject-btn"
                            data-id="${deposit.id}"
                            title="Reject deposit ini. Saldo user TIDAK bertambah.">✗ Reject</button>
                    </div>`;
            } else {
                actionsHtml = `<span class="status-badge ${badgeClass}" style="font-size:0.8rem;">Final</span>`;
            }

            // Method cell
            const icon = methodIcon[deposit.method] || '';
            const methodCell = deposit.method
                ? `<span style="white-space:nowrap;">${icon} ${deposit.method}</span>`
                : `<span style="color:#6b7280;">-</span>`;

            // Note cell — truncate panjang, full text di title tooltip
            const noteRaw = deposit.note || '';
            const noteTruncated = noteRaw.length > 50 ? noteRaw.slice(0, 50) + '…' : noteRaw;
            const noteCell = noteRaw
                ? `<span title="${noteRaw.replace(/"/g, '&quot;')}" style="cursor:help;max-width:140px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;">${noteTruncated}</span>`
                : `<span style="color:#6b7280;">-</span>`;

            const row = document.createElement('tr');
            row.id = `admin-deposit-${deposit.id}`;
            row.innerHTML = `
                <td><strong>#${deposit.id}</strong></td>
                <td>${deposit.username || '-'}</td>
                <td>${fmt(nominal)}</td>
                <td style="font-family:monospace;">${deposit.unique_code}</td>
                <td><strong>${fmt(deposit.amount)}</strong></td>
                <td>${methodCell}</td>
                <td>${noteCell}</td>
                <td><span class="status-badge ${badgeClass}">${badgeLabel}</span></td>
                <td>${formatDateId(deposit.created_at)}</td>
                <td>${actionsHtml}</td>
            `;
            adminDepositsTbody.appendChild(row);
        });
    }

    /**
     * Ambil daftar deposit admin sesuai filter status lalu render ke tabel.
     */
    async function fetchAdminDeposits() {
        const { apiFetch } = global.MikuShared.api;
        const { adminDepositsTbody, depositStatusFilter } = app.state.els;
        if (!adminDepositsTbody) return;
        adminDepositsTbody.innerHTML = `<tr><td colspan="10" style="text-align:center">Memuat data deposit...</td></tr>`;
        try {
            const statusVal = depositStatusFilter ? depositStatusFilter.value : '';
            const url = statusVal
                ? `${app.ADMIN_API_URL}/deposits?status=${encodeURIComponent(statusVal)}`
                : `${app.ADMIN_API_URL}/deposits`;
            const response = await apiFetch(url, { auth: true, token: app.state.token });
            if (response.status === 403) throw new Error('Akses Ditolak: Anda bukan Admin.');
            if (!response.ok) throw new Error('Gagal mengambil data deposit.');
            const deposits = await response.json();
            renderAdminDepositsTable(deposits);
        } catch (error) {
            if (adminDepositsTbody) {
                adminDepositsTbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--error-color)">Error: ${error.message}</td></tr>`;
            }
        }
    }

    async function handleManualBalance(action) {
        const { apiFetch } = global.MikuShared.api;
        const { manualBalanceForm, addBalanceBtn, reduceBalanceBtn } = app.state.els;
        if (!manualBalanceForm) return;
        const username = document.getElementById('target-user').value;
        const amount = document.getElementById('manual-amount').value;
        const description = document.getElementById('manual-description').value;
        if (!username || !amount || !description) {
            alert('Semua kolom pada form manual wajib diisi!');
            return;
        }
        const endpoint = action === 'add' ? `${app.ADMIN_API_URL}/balance/add` : `${app.ADMIN_API_URL}/balance/reduce`;
        addBalanceBtn.disabled = true;
        reduceBalanceBtn.disabled = true;
        addBalanceBtn.textContent = 'Memproses...';
        reduceBalanceBtn.textContent = 'Memproses...';
        try {
            const response = await apiFetch(endpoint, {
                method: 'POST',
                auth: true,
                token: app.state.token,
                jsonBody: { username, amount: parseInt(amount), description }
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message);
            alert(result.message);
            manualBalanceForm.reset();
        } catch (error) {
            alert(`Error: ${error.message}`);
        } finally {
            addBalanceBtn.disabled = false;
            reduceBalanceBtn.disabled = false;
            addBalanceBtn.textContent = 'Tambah Saldo';
            reduceBalanceBtn.textContent = 'Kurangi Saldo';
        }
    }

    /**
     * Pasang listener form saldo manual, filter deposit, refresh, serta approve/reject.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
            addBalanceBtn,
            reduceBalanceBtn,
            depositStatusFilter,
            refreshDepositsBtn,
            adminDepositsTbody,
        } = app.state.els;

        if (addBalanceBtn) addBalanceBtn.addEventListener('click', () => handleManualBalance('add'));
        if (reduceBalanceBtn) reduceBalanceBtn.addEventListener('click', () => handleManualBalance('reduce'));

        // === DEPOSIT: Filter & Refresh ===
        if (depositStatusFilter) {
            depositStatusFilter.addEventListener('change', () => fetchAdminDeposits());
        }
        if (refreshDepositsBtn) {
            refreshDepositsBtn.addEventListener('click', () => fetchAdminDeposits());
        }

        // === DEPOSIT: Approve & Reject (event delegation) ===
        if (adminDepositsTbody) {
            adminDepositsTbody.addEventListener('click', async function (e) {
                const btn = e.target.closest('.deposit-approve-btn, .deposit-reject-btn');
                if (!btn) return;
                const depositId = btn.dataset.id;
                const isApprove = btn.classList.contains('deposit-approve-btn');

                const confirmMsg = isApprove
                    ? `Yakin approve deposit #${depositId}?\nSaldo user AKAN bertambah sesuai jumlah deposit.`
                    : `Yakin reject deposit #${depositId}?\nSaldo user TIDAK akan bertambah.`;
                if (!confirm(confirmMsg)) return;

                btn.disabled = true;
                const origText = btn.textContent;
                btn.textContent = 'Memproses...';

                const endpoint = isApprove
                    ? `${app.ADMIN_API_URL}/deposits/approve`
                    : `${app.ADMIN_API_URL}/deposits/reject`;

                try {
                    const response = await apiFetch(endpoint, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: { depositId }
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    // Tampilkan pesan sukses singkat lalu reload tabel
                    alert(result.message);
                    await fetchAdminDeposits();
                } catch (error) {
                    alert(`Gagal: ${error.message}`);
                    btn.disabled = false;
                    btn.textContent = origText;
                }
            });
        }
    }

    app.deposits = {
        fetchAdminDeposits,
        renderAdminDepositsTable,
        handleManualBalance,
        bindEvents,
    };
})(window);
