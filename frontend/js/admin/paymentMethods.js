(function (global) {
    'use strict';

    const app = (global.MikuAdmin = global.MikuAdmin || {});

    function setPmFormStatus(message, isError = false) {
        const { pmFormStatus } = app.state.els;
        if (!pmFormStatus) return;
        pmFormStatus.textContent = message || '';
        pmFormStatus.className = message
            ? `form-status-msg ${isError ? 'is-error' : 'is-success'}`
            : 'form-status-msg';
    }

    function resetPaymentMethodForm() {
        const {
            paymentMethodForm,
            pmEditIdInput,
            pmMinAmountInput,
            pmSortOrderInput,
            pmIsActiveCheckbox,
            pmIsQrisCheckbox,
            pmFormTitle,
            pmSubmitBtn,
            pmCancelEditBtn,
        } = app.state.els;
        if (!paymentMethodForm) return;
        paymentMethodForm.reset();
        if (pmEditIdInput) pmEditIdInput.value = '';
        if (pmMinAmountInput) pmMinAmountInput.value = '10000';
        if (pmSortOrderInput) pmSortOrderInput.value = '0';
        if (pmIsActiveCheckbox) pmIsActiveCheckbox.checked = true;
        if (pmIsQrisCheckbox) pmIsQrisCheckbox.checked = false;
        if (pmFormTitle) pmFormTitle.innerHTML = '<i class="fas fa-credit-card" aria-hidden="true"></i> Tambah Metode Pembayaran';
        if (pmSubmitBtn) pmSubmitBtn.textContent = 'Simpan Metode';
        if (pmCancelEditBtn) pmCancelEditBtn.classList.add('hidden');
        setPmFormStatus('');
    }

    function fillPaymentMethodForm(pm) {
        const {
            paymentMethodForm,
            pmEditIdInput,
            pmNameInput,
            pmCodeInput,
            pmTypeSelect,
            pmAccountNumberInput,
            pmAccountNameInput,
            pmQrisUrlInput,
            pmMinAmountInput,
            pmSortOrderInput,
            pmInstructionsInput,
            pmIsQrisCheckbox,
            pmIsActiveCheckbox,
            pmFormTitle,
            pmSubmitBtn,
            pmCancelEditBtn,
        } = app.state.els;
        if (!pm || !paymentMethodForm) return;
        if (pmEditIdInput) pmEditIdInput.value = pm.id;
        if (pmNameInput) pmNameInput.value = pm.name || '';
        if (pmCodeInput) pmCodeInput.value = pm.code || '';
        if (pmTypeSelect) pmTypeSelect.value = pm.type || 'ewallet';
        if (pmAccountNumberInput) pmAccountNumberInput.value = pm.account_number || '';
        if (pmAccountNameInput) pmAccountNameInput.value = pm.account_name || '';
        if (pmQrisUrlInput) pmQrisUrlInput.value = pm.qris_image_url || '';
        if (pmMinAmountInput) pmMinAmountInput.value = pm.min_amount != null ? Number(pm.min_amount) : 10000;
        if (pmSortOrderInput) pmSortOrderInput.value = pm.sort_order != null ? Number(pm.sort_order) : 0;
        if (pmInstructionsInput) pmInstructionsInput.value = pm.instructions || '';
        if (pmIsQrisCheckbox) pmIsQrisCheckbox.checked = Boolean(pm.is_qris);
        if (pmIsActiveCheckbox) pmIsActiveCheckbox.checked = Boolean(pm.is_active);
        if (pmFormTitle) pmFormTitle.innerHTML = `<i class="fas fa-edit" aria-hidden="true"></i> Edit Metode Pembayaran (#${pm.id})`;
        if (pmSubmitBtn) pmSubmitBtn.textContent = 'Update Metode';
        if (pmCancelEditBtn) pmCancelEditBtn.classList.remove('hidden');
        setPmFormStatus('');
        if (typeof paymentMethodForm.scrollIntoView === 'function') {
            paymentMethodForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        if (pmNameInput && typeof pmNameInput.focus === 'function') pmNameInput.focus();
    }

    /**
     * Render tabel CRUD metode pembayaran admin dengan nominal tabular-nums.
     */
    function renderAdminPaymentMethodsTable(methods) {
        const { formatRupiah } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { adminPaymentMethodsTbody } = app.state.els;
        if (!adminPaymentMethodsTbody) return;
        adminPaymentMethodsTbody.innerHTML = '';
        if (!Array.isArray(methods) || methods.length === 0) {
            adminPaymentMethodsTbody.innerHTML = '<tr class="table-empty-row"><td colspan="8"><div class="ui-state empty">Belum ada metode pembayaran.</div></td></tr>';
            return;
        }
        const typeLabelMap = { ewallet: 'E-Wallet', bank: 'Bank', qris: 'QRIS' };

        methods.forEach(pm => {
            const row = document.createElement('tr');
            const typeText = typeLabelMap[pm.type] || pm.type;
            const qrisTag = pm.is_qris ? ' <span class="badge status-pending">Tanpa Kode Unik</span>' : '';
            const targetParts = [];
            if (pm.account_number) targetParts.push(`<strong>${escapeHtml(pm.account_number)}</strong>`);
            if (pm.account_name) targetParts.push(`<small class="text-muted-sm">A/N ${escapeHtml(pm.account_name)}</small>`);
            if (pm.qris_image_url) targetParts.push('<small class="pm-qris-hint">QRIS image tersedia</small>');
            const targetHtml = targetParts.length > 0 ? targetParts.join('<br>') : '<span class="text-muted-sm">-</span>';
            const statusBadge = pm.is_active
                ? '<span class="status-badge status-success">Aktif</span>'
                : '<span class="status-badge status-failed">Nonaktif</span>';
            const toggleLabel = pm.is_active ? 'Nonaktifkan' : 'Aktifkan';
            const toggleClass = pm.is_active ? 'resolve-btn resolve-btn-review pm-toggle-btn' : 'resolve-btn resolve-btn-success pm-toggle-btn';

            row.innerHTML = `
                <td class="td-numeric">${Number(pm.sort_order) || 0}</td>
                <td class="td-mono"><code>${escapeHtml(pm.code)}</code></td>
                <td><strong>${escapeHtml(pm.name)}</strong>${qrisTag}</td>
                <td>${escapeHtml(typeText)}</td>
                <td>${targetHtml}</td>
                <td class="td-numeric">${escapeHtml(formatRupiah(pm.min_amount || 10000))}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="admin-resolve-actions">
                        <button type="button" class="edit-btn edit-btn-compact pm-edit-btn" data-id="${escapeHtml(pm.id)}">Edit</button>
                        <button type="button" class="${toggleClass}" data-id="${escapeHtml(pm.id)}" data-active="${pm.is_active ? '1' : '0'}">${toggleLabel}</button>
                        <button type="button" class="resolve-btn resolve-btn-refund pm-delete-btn" data-id="${escapeHtml(pm.id)}">Hapus</button>
                    </div>
                </td>
            `;
            adminPaymentMethodsTbody.appendChild(row);
        });
    }

    /**
     * Muat seluruh metode pembayaran admin dari API.
     */
    async function fetchAdminPaymentMethods() {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const { adminPaymentMethodsTbody } = app.state.els;
        if (!adminPaymentMethodsTbody) return;
        adminPaymentMethodsTbody.innerHTML = '<tr class="table-loading-row"><td colspan="8"><div class="ui-state loading">Memuat metode pembayaran...</div></td></tr>';
        try {
            const response = await apiFetch(`${app.ADMIN_API_URL}/payment-methods`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat daftar metode pembayaran.');
            app.state.allPaymentMethods = await response.json();
            renderAdminPaymentMethodsTable(app.state.allPaymentMethods);
        } catch (error) {
            adminPaymentMethodsTbody.innerHTML = `<tr class="table-error-row"><td colspan="8"><div class="ui-state error">${escapeHtml(error.message)}</div></td></tr>`;
        }
    }

    /**
     * Pasang listener form tambah/edit dan aksi tabel metode pembayaran berkonfirmasi.
     */
    function bindEvents() {
        const { apiFetch } = global.MikuShared.api;
        const {
            pmTypeSelect,
            pmIsQrisCheckbox,
            pmCancelEditBtn,
            refreshPmBtn,
            paymentMethodForm,
            pmEditIdInput,
            pmNameInput,
            pmCodeInput,
            pmAccountNumberInput,
            pmAccountNameInput,
            pmQrisUrlInput,
            pmInstructionsInput,
            pmMinAmountInput,
            pmSortOrderInput,
            pmIsActiveCheckbox,
            pmSubmitBtn,
            adminPaymentMethodsTbody,
        } = app.state.els;

        if (pmTypeSelect && pmIsQrisCheckbox) {
            pmTypeSelect.addEventListener('change', () => {
                pmIsQrisCheckbox.checked = pmTypeSelect.value === 'qris';
            });
        }
        if (pmCancelEditBtn) pmCancelEditBtn.addEventListener('click', resetPaymentMethodForm);
        if (refreshPmBtn) refreshPmBtn.addEventListener('click', () => fetchAdminPaymentMethods());

        if (paymentMethodForm) {
            paymentMethodForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (typeof paymentMethodForm.checkValidity === 'function' && !paymentMethodForm.checkValidity()) {
                    const firstInvalid = paymentMethodForm.querySelector(':invalid');
                    if (firstInvalid && typeof firstInvalid.focus === 'function') firstInvalid.focus();
                    paymentMethodForm.reportValidity();
                    return;
                }
                const editId = pmEditIdInput ? pmEditIdInput.value.trim() : '';
                const payload = {
                    name: pmNameInput ? pmNameInput.value.trim() : '',
                    code: pmCodeInput ? pmCodeInput.value.trim().toUpperCase() : '',
                    type: pmTypeSelect ? pmTypeSelect.value : 'ewallet',
                    account_number: pmAccountNumberInput ? pmAccountNumberInput.value.trim() : '',
                    account_name: pmAccountNameInput ? pmAccountNameInput.value.trim() : '',
                    qris_image_url: pmQrisUrlInput ? pmQrisUrlInput.value.trim() : '',
                    instructions: pmInstructionsInput ? pmInstructionsInput.value.trim() : '',
                    min_amount: pmMinAmountInput ? Number(pmMinAmountInput.value) : 10000,
                    sort_order: pmSortOrderInput && pmSortOrderInput.value !== '' ? parseInt(pmSortOrderInput.value, 10) : 0,
                    is_qris: pmIsQrisCheckbox ? pmIsQrisCheckbox.checked : false,
                    is_active: pmIsActiveCheckbox ? pmIsActiveCheckbox.checked : true,
                };

                if (pmSubmitBtn) {
                    pmSubmitBtn.disabled = true;
                    pmSubmitBtn.textContent = editId ? 'Menyimpan...' : 'Menambahkan...';
                }
                setPmFormStatus('');

                try {
                    const url = editId ? `${app.ADMIN_API_URL}/payment-methods/${editId}` : `${app.ADMIN_API_URL}/payment-methods`;
                    const response = await apiFetch(url, {
                        method: editId ? 'PUT' : 'POST', auth: true, token: app.state.token, jsonBody: payload,
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message || 'Gagal menyimpan metode pembayaran.');
                    const successMsg = result.message || 'Metode pembayaran berhasil disimpan.';
                    resetPaymentMethodForm();
                    setPmFormStatus(successMsg, false);
                    app.notify(successMsg, 'success');
                    await fetchAdminPaymentMethods();
                } catch (error) {
                    setPmFormStatus(error.message, true);
                    app.notify(`Gagal: ${error.message}`, 'error');
                } finally {
                    if (pmSubmitBtn) {
                        pmSubmitBtn.disabled = false;
                        const stillEditing = pmEditIdInput && pmEditIdInput.value.trim() !== '';
                        pmSubmitBtn.textContent = stillEditing ? 'Update Metode' : 'Simpan Metode';
                    }
                }
            });
        }

        if (adminPaymentMethodsTbody) {
            adminPaymentMethodsTbody.addEventListener('click', async (e) => {
                const editBtn = e.target.closest('.pm-edit-btn');
                if (editBtn) {
                    const pm = app.state.allPaymentMethods.find(item => String(item.id) === editBtn.dataset.id);
                    if (pm) fillPaymentMethodForm(pm);
                    return;
                }

                const toggleBtn = e.target.closest('.pm-toggle-btn');
                if (toggleBtn) {
                    const id = toggleBtn.dataset.id;
                    const currentActive = toggleBtn.dataset.active === '1';
                    toggleBtn.disabled = true;
                    try {
                        const response = await apiFetch(`${app.ADMIN_API_URL}/payment-methods/${id}`, {
                            method: 'PUT', auth: true, token: app.state.token, jsonBody: { is_active: !currentActive },
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.message);
                        app.notify(`Status metode diubah menjadi ${!currentActive ? 'Aktif' : 'Nonaktif'}.`, 'success');
                        await fetchAdminPaymentMethods();
                    } catch (error) {
                        app.notify(`Gagal: ${error.message}`, 'error');
                        toggleBtn.disabled = false;
                    }
                    return;
                }

                const deleteBtn = e.target.closest('.pm-delete-btn');
                if (deleteBtn) {
                    const id = deleteBtn.dataset.id;
                    const pm = app.state.allPaymentMethods.find(item => String(item.id) === id);
                    app.openConfirmModal({
                        title: 'Hapus Metode Pembayaran?',
                        message: 'Metode pembayaran akan dihapus dari daftar deposit pengguna.',
                        details: [
                            { label: 'Nama Metode', value: pm ? pm.name : `#${id}` },
                            { label: 'Kode', value: pm ? pm.code : '-' },
                            { label: 'Tipe', value: pm ? String(pm.type).toUpperCase() : '-' },
                        ],
                        confirmLabel: 'Ya, Hapus Metode',
                        danger: true,
                        onConfirm: async () => {
                            deleteBtn.disabled = true;
                            try {
                                const response = await apiFetch(`${app.ADMIN_API_URL}/payment-methods/${id}`, {
                                    method: 'DELETE', auth: true, token: app.state.token,
                                });
                                const result = await response.json();
                                if (!response.ok) throw new Error(result.message);
                                if (pmEditIdInput && pmEditIdInput.value === id) resetPaymentMethodForm();
                                const msg = result.message || 'Metode pembayaran berhasil dihapus.';
                                setPmFormStatus(msg, false);
                                app.notify(msg, 'success');
                                await fetchAdminPaymentMethods();
                            } catch (error) {
                                app.notify(`Gagal menghapus: ${error.message}`, 'error');
                                deleteBtn.disabled = false;
                            }
                        },
                    });
                }
            });
        }
    }

    app.paymentMethods = {
        fetchAdminPaymentMethods,
        renderAdminPaymentMethodsTable,
        bindEvents,
    };
})(window);
