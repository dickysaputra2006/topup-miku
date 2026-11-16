(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});
    let activeRejectDeposit = null;
    let rejectBusy = false;

    function getDepositStatusMeta(rawStatus) {
        const statusNorm = String(rawStatus || '').toLowerCase();
        if (statusNorm === 'approved') return { badgeClass: 'status-success', label: 'Approved', isPending: false };
        if (statusNorm === 'success') return { badgeClass: 'status-success', label: 'Approved (Lama)', isPending: false };
        if (statusNorm === 'rejected') return { badgeClass: 'status-failed', label: 'Rejected', isPending: false };
        if (statusNorm === 'pending') return { badgeClass: 'status-pending', label: 'Pending', isPending: true };
        return { badgeClass: 'status-pending', label: rawStatus || '-', isPending: false };
    }

    function updateDepositSummaryBar(deposits, statusFilterVal) {
        const { formatRupiah } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const summaryEl = app.state.els.depositPendingSummary || document.getElementById('deposit-pending-summary');
        if (!summaryEl) return;

        const list = Array.isArray(deposits) ? deposits : [];
        const pendingRows = list.filter(d => String(d.status || '').toLowerCase() === 'pending');
        const pendingTotal = pendingRows.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
        const filterText = statusFilterVal ? `Filter: ${statusFilterVal}` : 'Filter: Semua';

        if (!statusFilterVal || statusFilterVal === 'Pending') {
            summaryEl.innerHTML = `
                <span>${escapeHtml(filterText)}</span>
                <span>Menunggu verifikasi: <strong>${pendingRows.length} permintaan</strong> (Total <strong>${escapeHtml(formatRupiah(pendingTotal))}</strong>)</span>
            `;
            return;
        }

        summaryEl.innerHTML = `
            <span>${escapeHtml(filterText)}</span>
            <span>Menampilkan <strong>${list.length}</strong> data · Antrean pending saat ini: <strong>${app.state.pendingDepositCount}</strong></span>
        `;
    }

    /**
     * Render daftar request deposit admin beserta detail pengirim, nominal tabular-nums, dan tombol aksi.
     */
    function renderAdminDepositsTable(deposits) {
        const { formatRupiah, formatDateId } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { adminDepositsTbody } = app.state.els;
        if (!adminDepositsTbody) return;

        const list = Array.isArray(deposits) ? deposits : [];
        app.state.allDeposits = list;
        adminDepositsTbody.innerHTML = '';

        if (list.length === 0) {
            adminDepositsTbody.innerHTML = '<tr class="table-empty-row"><td colspan="10"><div class="ui-state empty">Tidak ada data deposit pada filter ini.</div></td></tr>';
            return;
        }

        list.forEach(deposit => {
            const totalAmount = Number(deposit.amount) || 0;
            const uniqueCode = Number(deposit.unique_code) || 0;
            const nominal = Math.max(0, totalAmount - uniqueCode);
            const meta = getDepositStatusMeta(deposit.status);
            const senderContact = deposit.nomor_wa || deposit.email || '';

            const actionsHtml = meta.isPending
                ? `<div class="admin-resolve-actions">
                        <button type="button" class="resolve-btn resolve-btn-success deposit-approve-btn" data-id="${escapeHtml(deposit.id)}">Setujui</button>
                        <button type="button" class="resolve-btn resolve-btn-refund deposit-reject-btn" data-id="${escapeHtml(deposit.id)}">Tolak</button>
                   </div>`
                : `<span class="status-badge ${meta.badgeClass}">Final</span>`;

            const noteRaw = String(deposit.note || '').trim();
            const noteShort = noteRaw.length > 50 ? `${noteRaw.slice(0, 50)}…` : noteRaw;
            const noteCell = noteRaw
                ? `<span class="cell-truncate" title="${escapeHtml(noteRaw)}">${escapeHtml(noteShort)}</span>`
                : '<span class="text-muted-sm">-</span>';

            const row = document.createElement('tr');
            row.id = `admin-deposit-${deposit.id}`;
            row.innerHTML = `
                <td class="td-mono"><strong>#${escapeHtml(deposit.id)}</strong></td>
                <td>
                    <div class="deposit-sender-meta">
                        <strong>${escapeHtml(deposit.username || '-')}</strong>
                        ${senderContact ? `<span class="deposit-sender-sub">${escapeHtml(senderContact)}</span>` : ''}
                    </div>
                </td>
                <td class="td-numeric">${escapeHtml(formatRupiah(nominal))}</td>
                <td class="td-mono td-numeric">${escapeHtml(uniqueCode)}</td>
                <td class="td-numeric"><strong>${escapeHtml(formatRupiah(totalAmount))}</strong></td>
                <td>${deposit.method ? escapeHtml(deposit.method) : '<span class="text-muted-sm">-</span>'}</td>
                <td>${noteCell}</td>
                <td><span class="status-badge ${meta.badgeClass}">${escapeHtml(meta.label)}</span></td>
                <td>${escapeHtml(formatDateId(deposit.created_at))}</td>
                <td>${actionsHtml}</td>
            `;
            adminDepositsTbody.appendChild(row);
        });
    }

    async function syncPendingBadgeFromServer() {
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/deposits?status=Pending`, { auth: true, token: app.state.token });
            if (!response.ok) return;
            const pendingRows = await response.json();
            if (Array.isArray(pendingRows)) {
                app.updatePendingDepositBadge(pendingRows.length);
            }
        } catch (_) {
            // Abaikan error sinkronisasi badge sekunder agar tidak mengganggu tabel utama
        }
    }

    /**
     * Ambil daftar deposit admin sesuai filter status, perbarui badge sidebar, lalu render tabel.
     */
    async function fetchAdminDeposits() {
        const { apiFetch } = global.MikuShared.api;
        const { escapeHtml } = global.MikuShared.dom;
        const { adminDepositsTbody, depositStatusFilter } = app.state.els;
        if (!adminDepositsTbody) return;

        adminDepositsTbody.innerHTML = '<tr class="table-loading-row"><td colspan="10"><div class="ui-state loading">Memuat data deposit...</div></td></tr>';
        try {
            const statusVal = depositStatusFilter ? depositStatusFilter.value : '';
            const url = statusVal
                ? `${app.ADMIN_API_URL}/deposits?status=${encodeURIComponent(statusVal)}`
                : `${app.ADMIN_API_URL}/deposits`;
            const response = await apiFetch(url, { auth: true, token: app.state.token });
            if (response.status === 403) throw new Error('Akses Ditolak: Anda bukan Admin.');
            if (!response.ok) throw new Error('Gagal mengambil data deposit.');

            const deposits = await response.json();
            if (!statusVal || statusVal === 'Pending') {
                const pendingCount = Array.isArray(deposits)
                    ? deposits.filter(d => String(d.status || '').toLowerCase() === 'pending').length
                    : 0;
                app.updatePendingDepositBadge(pendingCount);
            } else {
                await syncPendingBadgeFromServer();
            }

            renderAdminDepositsTable(deposits);
            updateDepositSummaryBar(deposits, statusVal);
        } catch (error) {
            adminDepositsTbody.innerHTML = `<tr class="table-error-row"><td colspan="10"><div class="ui-state error">Error: ${escapeHtml(error.message)}</div></td></tr>`;
            updateDepositSummaryBar([], '');
        }
    }

    function openRejectDepositModal(deposit) {
        const { formatRupiah } = global.MikuShared.format;
        const {
            rejectDepositModal,
            rejectDepositSummary,
            rejectReasonInput,
            rejectReasonError,
            submitRejectDepositBtn,
        } = app.state.els;
        if (!rejectDepositModal) return;

        activeRejectDeposit = deposit;
        rejectBusy = false;
        const total = Number(deposit.amount) || 0;
        app.renderModalSummaryRows(rejectDepositSummary, [
            { label: 'ID Deposit', value: `#${deposit.id}` },
            { label: 'Pengirim', value: deposit.username || '-' },
            { label: 'Metode', value: deposit.method || '-' },
            { label: 'Total Transfer', value: formatRupiah(total) },
        ]);

        if (rejectReasonInput) rejectReasonInput.value = '';
        if (rejectReasonError) {
            rejectReasonError.textContent = '';
            rejectReasonError.classList.add('hidden');
        }
        if (submitRejectDepositBtn) {
            submitRejectDepositBtn.disabled = false;
            submitRejectDepositBtn.textContent = 'Tolak Deposit';
        }
        rejectDepositModal.classList.remove('hidden');
        if (rejectReasonInput && typeof rejectReasonInput.focus === 'function') rejectReasonInput.focus();
    }

    function closeRejectDepositModal(force = false) {
        const { rejectDepositModal, rejectReasonError, submitRejectDepositBtn } = app.state.els;
        if (!rejectDepositModal || (rejectBusy && !force)) return;
        activeRejectDeposit = null;
        rejectDepositModal.classList.add('hidden');
        if (rejectReasonError) {
            rejectReasonError.textContent = '';
            rejectReasonError.classList.add('hidden');
        }
        if (submitRejectDepositBtn) {
            submitRejectDepositBtn.disabled = false;
            submitRejectDepositBtn.textContent = 'Tolak Deposit';
        }
    }

    async function handleManualBalance(action) {
        const { formatRupiah } = global.MikuShared.format;
        const { apiFetch } = global.MikuShared.api;
        const { manualBalanceForm, addBalanceBtn, reduceBalanceBtn } = app.state.els;
        if (!manualBalanceForm) return;

        const usernameEl = document.getElementById('target-user');
        const amountEl = document.getElementById('manual-amount');
        const descEl = document.getElementById('manual-description');
        const username = usernameEl ? usernameEl.value.trim() : '';
        const parsedAmount = parseInt(amountEl ? amountEl.value : '', 10);
        const description = descEl ? descEl.value.trim() : '';

        if (!username || !Number.isFinite(parsedAmount) || parsedAmount <= 0 || !description) {
            app.notify('Lengkapi username/email, jumlah saldo positif (> 0), dan keterangan.', 'error');
            return;
        }

        const isAdd = action === 'add';
        const endpoint = isAdd ? `${app.ADMIN_API_URL}/balance/add` : `${app.ADMIN_API_URL}/balance/reduce`;

        app.openConfirmModal({
            title: isAdd ? 'Konfirmasi Tambah Saldo Manual' : 'Konfirmasi Kurangi Saldo Manual',
            message: isAdd
                ? 'Pastikan dana atau kompensasi valid sebelum menambahkan saldo ke akun pengguna.'
                : 'Saldo pengguna akan langsung dikurangi dan dicatat pada mutasi akun.',
            details: [
                { label: 'Target Pengguna', value: username },
                { label: 'Nominal', value: formatRupiah(parsedAmount) },
                { label: 'Keterangan', value: description },
            ],
            confirmLabel: isAdd ? 'Ya, Tambah Saldo' : 'Ya, Kurangi Saldo',
            danger: !isAdd,
            onConfirm: async () => {
                if (addBalanceBtn) addBalanceBtn.disabled = true;
                if (reduceBalanceBtn) reduceBalanceBtn.disabled = true;
                try {
                    const response = await apiFetch(endpoint, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: { username, amount: parsedAmount, description },
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    app.notify(result.message || 'Saldo pengguna berhasil diperbarui.', 'success');
                    manualBalanceForm.reset();
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (addBalanceBtn) addBalanceBtn.disabled = false;
                    if (reduceBalanceBtn) reduceBalanceBtn.disabled = false;
                }
            },
        });
    }

    /**
     * Pasang listener form saldo manual, filter deposit, refresh, serta approve/reject bermodal.
     */
    function bindEvents() {
        const { formatRupiah } = global.MikuShared.format;
        const { apiFetch } = global.MikuShared.api;
        const {
            addBalanceBtn,
            reduceBalanceBtn,
            depositStatusFilter,
            refreshDepositsBtn,
            adminDepositsTbody,
            rejectDepositModal,
            closeRejectDepositBtn,
            cancelRejectDepositBtn,
            rejectDepositForm,
            rejectReasonInput,
            rejectReasonError,
            submitRejectDepositBtn,
        } = app.state.els;

        app.registerModalCloser(() => closeRejectDepositModal());

        if (addBalanceBtn) addBalanceBtn.addEventListener('click', () => handleManualBalance('add'));
        if (reduceBalanceBtn) reduceBalanceBtn.addEventListener('click', () => handleManualBalance('reduce'));
        if (depositStatusFilter) depositStatusFilter.addEventListener('change', () => fetchAdminDeposits());
        if (refreshDepositsBtn) refreshDepositsBtn.addEventListener('click', () => fetchAdminDeposits());

        if (closeRejectDepositBtn) closeRejectDepositBtn.addEventListener('click', () => closeRejectDepositModal());
        if (cancelRejectDepositBtn) cancelRejectDepositBtn.addEventListener('click', () => closeRejectDepositModal());
        if (rejectDepositModal) {
            rejectDepositModal.addEventListener('click', (e) => {
                if (e.target === rejectDepositModal) closeRejectDepositModal();
            });
        }
        if (rejectReasonInput && rejectReasonError) {
            rejectReasonInput.addEventListener('input', () => rejectReasonError.classList.add('hidden'));
        }

        if (rejectDepositForm) {
            rejectDepositForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (!activeRejectDeposit || rejectBusy) return;
                const reason = rejectReasonInput ? rejectReasonInput.value.trim() : '';
                if (reason.length < 3) {
                    if (rejectReasonError) {
                        rejectReasonError.textContent = 'Alasan penolakan wajib diisi minimal 3 karakter.';
                        rejectReasonError.classList.remove('hidden');
                    }
                    if (rejectReasonInput && typeof rejectReasonInput.focus === 'function') rejectReasonInput.focus();
                    return;
                }

                rejectBusy = true;
                if (submitRejectDepositBtn) {
                    submitRejectDepositBtn.disabled = true;
                    submitRejectDepositBtn.textContent = 'Menolak...';
                }

                const targetDepositId = activeRejectDeposit.id;
                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/deposits/reject`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: { depositId: targetDepositId, reason },
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    closeRejectDepositModal(true);
                    app.notify(result.message || `Deposit #${targetDepositId} ditolak.`, 'success');
                    await fetchAdminDeposits();
                } catch (error) {
                    if (rejectReasonError) {
                        rejectReasonError.textContent = error.message;
                        rejectReasonError.classList.remove('hidden');
                    }
                    app.notify(`Gagal: ${error.message}`, 'error');
                } finally {
                    rejectBusy = false;
                    if (submitRejectDepositBtn) {
                        submitRejectDepositBtn.disabled = false;
                        submitRejectDepositBtn.textContent = 'Tolak Deposit';
                    }
                }
            });
        }

        if (adminDepositsTbody) {
            adminDepositsTbody.addEventListener('click', (e) => {
                const approveBtn = e.target.closest('.deposit-approve-btn');
                const rejectBtn = e.target.closest('.deposit-reject-btn');
                const targetBtn = approveBtn || rejectBtn;
                if (!targetBtn) return;

                const depositId = targetBtn.dataset.id;
                const deposit = app.state.allDeposits.find(item => String(item.id) === String(depositId))
                    || { id: depositId, username: '-', method: '-', amount: 0, unique_code: 0 };

                if (rejectBtn) {
                    openRejectDepositModal(deposit);
                    return;
                }

                const total = Number(deposit.amount) || 0;
                const nominal = Math.max(0, total - (Number(deposit.unique_code) || 0));
                app.openConfirmModal({
                    title: `Setujui Deposit #${deposit.id}?`,
                    message: 'Saldo pengguna akan langsung bertambah sesuai total transfer setelah Anda mengonfirmasi.',
                    details: [
                        { label: 'Pengirim', value: deposit.username || '-' },
                        { label: 'Metode', value: deposit.method || '-' },
                        { label: 'Nominal', value: formatRupiah(nominal) },
                        { label: 'Kode Unik', value: String(deposit.unique_code || 0) },
                        { label: 'Total Dikreditkan', value: formatRupiah(total) },
                    ],
                    confirmLabel: 'Ya, Setujui Deposit',
                    danger: false,
                    onConfirm: async () => {
                        approveBtn.disabled = true;
                        const origText = approveBtn.textContent;
                        approveBtn.textContent = 'Memproses...';
                        try {
                            const response = await apiFetch(`${app.ADMIN_API_URL}/deposits/approve`, {
                                method: 'POST',
                                auth: true,
                                token: app.state.token,
                                jsonBody: { depositId: deposit.id },
                            });
                            const result = await response.json();
                            if (!response.ok) throw new Error(result.message);
                            app.notify(result.message || `Deposit #${deposit.id} disetujui.`, 'success');
                            await fetchAdminDeposits();
                        } catch (error) {
                            app.notify(`Gagal: ${error.message}`, 'error');
                            approveBtn.disabled = false;
                            approveBtn.textContent = origText;
                        }
                    },
                });
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
