(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    /**
     * Muat konfigurasi margin persentase global per role reseller.
     */
    async function fetchAndDisplayMargins() {
        const { escapeHtml } = global.MikuShared.dom;
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
                    group.innerHTML = `
                        <label for="margin-role-${escapeHtml(role.id)}">${escapeHtml(role.name)}</label>
                        <div>
                            <input type="number" id="margin-role-${escapeHtml(role.id)}" data-role-id="${escapeHtml(role.id)}" value="${escapeHtml(role.margin_percent)}" step="0.01" required>
                            <span>%</span>
                        </div>`;
                    marginFieldsContainer.appendChild(group);
                }
            });
        } catch (error) {
            console.error('Gagal memuat margin:', error);
            marginFieldsContainer.innerHTML = '<div class="ui-state error">Gagal memuat data margin.</div>';
        }
    }

    /**
     * Eksekusi resolusi transaksi admin (success, refund, atau keep_review).
     */
    async function adminResolveTransaction(invoiceId, action) {
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/transactions/${encodeURIComponent(invoiceId)}/resolve`, {
                method: 'PUT',
                auth: true,
                token: app.state.token,
                jsonBody: { action },
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message);
            app.notify(result.message || `Transaksi ${invoiceId} berhasil diproses.`, 'success');
            await fetchAdminTransactions();
        } catch (error) {
            app.notify(`Gagal: ${error.message}`, 'error');
        }
    }

    /**
     * Muat seluruh transaksi admin beserta tombol resolve terkonfirmasi dan harga tabular-nums.
     */
    async function fetchAdminTransactions() {
        const { formatRupiah, formatDateId, statusClass, statusLabel } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tbody = document.getElementById('admin-transactions-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr class="table-loading-row"><td colspan="7"><div class="ui-state loading">Memuat transaksi...</div></td></tr>';
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/transactions`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat transaksi.');
            const transactions = await response.json();
            tbody.innerHTML = '';
            if (!Array.isArray(transactions) || transactions.length === 0) {
                tbody.innerHTML = '<tr class="table-empty-row"><td colspan="7"><div class="ui-state empty">Belum ada transaksi.</div></td></tr>';
                return;
            }
            transactions.forEach(tx => {
                const statusNorm = String(tx.status || '').toLowerCase();
                const txStatusClass = statusClass(tx.status);
                const txStatusLabel = statusNorm === 'refunded' ? (tx.status || 'Pending') : statusLabel(tx.status, 'Perlu Review');
                const formattedPrice = formatRupiah(tx.price);
                const formattedDate = formatDateId(tx.created_at);
                const isPartialRefund = tx.status === 'Partial Refund';
                const isPending = tx.status === 'Pending';

                let actionsHtml = '<span class="text-muted-sm">-</span>';
                const dataCtx = `data-invoice="${escapeHtml(tx.invoice_id)}" data-user="${escapeHtml(tx.user_name || '-')}" data-product="${escapeHtml(tx.product_name || '-')}" data-price="${escapeHtml(formattedPrice)}"`;
                if (isPartialRefund) {
                    actionsHtml = `
                        <div class="admin-resolve-actions">
                            <button type="button" class="resolve-btn resolve-btn-success" ${dataCtx} data-action="success">Berhasil</button>
                            <button type="button" class="resolve-btn resolve-btn-refund" ${dataCtx} data-action="refund">Refund</button>
                            <button type="button" class="resolve-btn resolve-btn-review" ${dataCtx} data-action="keep_review">Review</button>
                        </div>`;
                } else if (isPending) {
                    actionsHtml = `
                        <div class="admin-resolve-actions">
                            <button type="button" class="resolve-btn resolve-btn-review" ${dataCtx} data-action="keep_review">Tandai Review</button>
                        </div>`;
                }

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td class="td-mono"><a href="/invoice.html?id=${encodeURIComponent(tx.invoice_id)}" target="_blank" class="history-link cell-truncate" title="${escapeHtml(tx.invoice_id)}">${escapeHtml(tx.invoice_id)}</a></td>
                    <td>${escapeHtml(tx.user_name || '-')}</td>
                    <td><span class="cell-truncate" title="${escapeHtml(tx.product_name || '-')}">${escapeHtml(tx.product_name || '-')}</span></td>
                    <td class="td-numeric">${escapeHtml(formattedPrice)}</td>
                    <td><span class="status-badge ${txStatusClass}">${escapeHtml(txStatusLabel)}</span></td>
                    <td>${escapeHtml(formattedDate)}</td>
                    <td>${actionsHtml}</td>
                `;
                tbody.appendChild(row);
            });
        } catch (error) {
            tbody.innerHTML = `<tr class="table-error-row"><td colspan="7"><div class="ui-state error">${escapeHtml(error.message)}</div></td></tr>`;
        }
    }

    /**
     * Render ringkasan info akun untuk panel Ubah Role.
     */
    function renderRoleUserPreview(user) {
        const { escapeHtml } = global.MikuShared.dom;
        const { formatRupiah } = global.MikuShared.format;
        const { roleUserPreviewEl, targetUserRoleSelect } = app.state.els;
        if (!roleUserPreviewEl) return;
        if (!user) {
            roleUserPreviewEl.innerHTML = '';
            roleUserPreviewEl.classList.add('hidden');
            return;
        }
        const safeRole = escapeHtml(user.role || '-');
        roleUserPreviewEl.innerHTML = `
            <div>
                <strong>${escapeHtml(user.username || '-')}</strong>
                ${user.email ? `<span class="text-muted-sm"> (${escapeHtml(user.email)})</span>` : ''}
                <div class="text-muted-sm">Saldo: <strong class="tabular-nums">${escapeHtml(formatRupiah(user.balance || 0))}</strong></div>
            </div>
            <span class="status-badge">Role: ${safeRole}</span>
        `;
        roleUserPreviewEl.classList.remove('hidden');
        if (targetUserRoleSelect && ['BRONZE', 'SILVER', 'GOLD', 'PARTNER'].includes(String(user.role || '').toUpperCase())) {
            targetUserRoleSelect.value = String(user.role).toUpperCase();
        }
    }

    /**
     * Muat profil ringkas pengguna berdasarkan username atau email untuk validasi sebelum ubah role.
     */
    async function lookupUserForRole(silentIfNotFound = false) {
        const { apiFetch } = global.MikuShared.api;
        const { roleTargetUserInput, lookupUserRoleBtn } = app.state.els;
        const identifier = roleTargetUserInput ? String(roleTargetUserInput.value || '').trim() : '';
        if (!identifier) {
            app.notify('Masukkan username atau email pengguna terlebih dahulu.', 'error');
            return null;
        }
        if (lookupUserRoleBtn) lookupUserRoleBtn.disabled = true;
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/users/lookup?q=${encodeURIComponent(identifier)}`, {
                auth: true,
                token: app.state.token,
            });
            const result = await response.json();
            if (!response.ok) {
                renderRoleUserPreview(null);
                if (!silentIfNotFound) throw new Error(result.message || 'Pengguna tidak ditemukan.');
                return null;
            }
            renderRoleUserPreview(result.user);
            return result.user;
        } catch (error) {
            if (!silentIfNotFound) app.notify(`Error: ${error.message}`, 'error');
            return null;
        } finally {
            if (lookupUserRoleBtn) lookupUserRoleBtn.disabled = false;
        }
    }

    /**
     * Eksekusi pembaruan role pengguna setelah konfirmasi modal admin.
     */
    async function submitUserRoleUpdate(identifier, role) {
        const { apiFetch } = global.MikuShared.api;
        const { updateUserRoleBtn } = app.state.els;
        if (updateUserRoleBtn) {
            updateUserRoleBtn.disabled = true;
            updateUserRoleBtn.textContent = 'Menyimpan...';
        }
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/users/role`, {
                method: 'PUT',
                auth: true,
                token: app.state.token,
                jsonBody: { identifier, role },
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Gagal mengubah role pengguna.');
            app.notify(result.message || `Role ${identifier} berhasil diubah menjadi ${role}.`, 'success');
            await lookupUserForRole(true);
        } catch (error) {
            app.notify(`Gagal: ${error.message}`, 'error');
        } finally {
            if (updateUserRoleBtn) {
                updateUserRoleBtn.disabled = false;
                updateUserRoleBtn.textContent = 'Ubah Role Pengguna';
            }
        }
    }

    /**
     * Pasang listener form pembaruan margin global, ubah role user, dan delegasi resolusi transaksi.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
            marginForm,
            marginFieldsContainer,
            userRoleForm,
            roleTargetUserInput,
            lookupUserRoleBtn,
            targetUserRoleSelect,
        } = app.state.els;
        const txTbody = document.getElementById('admin-transactions-tbody');

        if (lookupUserRoleBtn) {
            lookupUserRoleBtn.addEventListener('click', () => {
                lookupUserForRole(false);
            });
        }
        if (userRoleForm) {
            userRoleForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const identifier = roleTargetUserInput ? String(roleTargetUserInput.value || '').trim() : '';
                const targetRole = targetUserRoleSelect ? String(targetUserRoleSelect.value || '').trim() : '';
                if (!identifier || !targetRole) {
                    app.notify('Username/email dan role tujuan wajib diisi.', 'error');
                    return;
                }
                const matchedUser = await lookupUserForRole(false);
                if (!matchedUser) return;
                app.openConfirmModal({
                    title: `Ubah Role ${matchedUser.username}?`,
                    message: 'Perubahan role berlaku segera dan mencabut sesi login lama pengguna agar tier baru langsung aktif.',
                    details: [
                        { label: 'Username', value: matchedUser.username },
                        { label: 'Email', value: matchedUser.email || '-' },
                        { label: 'Role Saat Ini', value: matchedUser.role || '-' },
                        { label: 'Role Tujuan', value: targetRole },
                    ],
                    confirmLabel: `Ya, Ubah ke ${targetRole}`,
                    danger: false,
                    onConfirm: () => submitUserRoleUpdate(matchedUser.username, targetRole),
                });
            });
        }

        if (txTbody) {
            txTbody.addEventListener('click', (e) => {
                const btn = e.target.closest('.resolve-btn');
                if (!btn) return;
                const invoiceId = btn.dataset.invoice;
                const action = btn.dataset.action;
                const meta = {
                    success: {
                        title: `Tandai Transaksi ${invoiceId} Berhasil?`,
                        message: 'Pastikan produk benar-benar sudah terkirim ke tujuan pelanggan.',
                        confirmLabel: 'Ya, Tandai Berhasil',
                        danger: false,
                    },
                    refund: {
                        title: `Refund Transaksi ${invoiceId}?`,
                        message: 'Saldo akan dikembalikan ke akun pengguna dan status transaksi berubah menjadi Gagal.',
                        confirmLabel: 'Ya, Refund Saldo',
                        danger: true,
                    },
                    keep_review: {
                        title: `Tandai Review Transaksi ${invoiceId}?`,
                        message: 'Transaksi akan ditempatkan atau dipertahankan dalam status Perlu Review Admin.',
                        confirmLabel: 'Ya, Tandai Review',
                        danger: false,
                    },
                }[action];
                if (!meta) return;

                app.openConfirmModal({
                    title: meta.title,
                    message: meta.message,
                    details: [
                        { label: 'Invoice', value: invoiceId },
                        { label: 'Pengguna', value: btn.dataset.user || '-' },
                        { label: 'Produk', value: btn.dataset.product || '-' },
                        { label: 'Nominal', value: btn.dataset.price || '-' },
                    ],
                    confirmLabel: meta.confirmLabel,
                    danger: meta.danger,
                    onConfirm: () => adminResolveTransaction(invoiceId, action),
                });
            });
        }

        if (marginForm) {
            marginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const saveButton = marginForm.querySelector('button[type="submit"]');
                if (saveButton) {
                    saveButton.disabled = true;
                    saveButton.textContent = 'Menyimpan...';
                }

                const marginInputs = marginFieldsContainer.querySelectorAll('input[type="number"]');
                const marginsToUpdate = Array.from(marginInputs).map(input => ({
                    id: input.dataset.roleId,
                    margin: parseFloat(input.value),
                }));

                try {
                    const response = await apiFetch(`${app.ADMIN_API_URL}/roles`, {
                        method: 'PUT', auth: true, token: app.state.token, jsonBody: marginsToUpdate,
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    app.notify('Margin keuntungan global berhasil diperbarui.', 'success');
                } catch (error) {
                    app.notify(`Error: ${error.message}`, 'error');
                } finally {
                    if (saveButton) {
                        saveButton.disabled = false;
                        saveButton.textContent = 'Simpan Semua Margin';
                    }
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
