(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    const formatRupiahId = (val) => global.MikuShared.format.formatRupiah(Number(val) || 0);

    function getMethodVisualMeta(name, type) {
        const lowerName = String(name || '').toLowerCase();
        const lowerType = String(type || '').toLowerCase();
        if (lowerType === 'qris' || lowerName.includes('qris')) {
            return { typeLabel: 'QRIS', iconClass: 'fas fa-qrcode' };
        }
        if (lowerType === 'bank' || lowerName.includes('bank') || lowerName.includes('bca') || lowerName.includes('bri') || lowerName.includes('bni') || lowerName.includes('mandiri')) {
            return { typeLabel: 'Bank Transfer', iconClass: 'fas fa-university' };
        }
        if (lowerName.includes('gopay')) return { typeLabel: 'E-Wallet', iconClass: 'fas fa-money-bill-wave' };
        if (lowerName.includes('shopee')) return { typeLabel: 'E-Wallet', iconClass: 'fas fa-shopping-bag' };
        return { typeLabel: 'E-Wallet', iconClass: 'fas fa-wallet' };
    }

    function syncSelectAriaState(selectEl, errorEl, showError) {
        if (!selectEl) return;
        const errorId = selectEl.dataset.error || (errorEl && errorEl.id) || '';
        const isInvalid = Boolean(showError && !selectEl.validity.valid);
        selectEl.setAttribute('aria-invalid', isInvalid ? 'true' : 'false');
        selectEl.classList.toggle('user-invalid-fallback', isInvalid);
        if (errorEl) errorEl.classList.toggle('is-visible', isInvalid);
        if (errorId) {
            const ids = (selectEl.getAttribute('aria-describedby') || '')
                .split(/\s+/)
                .filter(id => id && id !== errorId);
            if (isInvalid) ids.push(errorId);
            if (ids.length) selectEl.setAttribute('aria-describedby', ids.join(' '));
            else selectEl.removeAttribute('aria-describedby');
        }
    }

    function findPaymentMethod(value) {
        if (!value) return null;
        const norm = String(value).trim().toLowerCase();
        return app.state.activePaymentMethods.find(pm =>
            String(pm.code || '').toLowerCase() === norm ||
            String(pm.name || '').toLowerCase() === norm
        ) || null;
    }

    function updateDepositPreview() {
        const amountEl = document.getElementById('amount');
        const methodSelect = document.getElementById('deposit-method');
        const amountSummaryEl = document.getElementById('deposit-summary-amount');
        const uniqueSummaryEl = document.getElementById('deposit-summary-unique');
        const totalSummaryEl = document.getElementById('deposit-summary-total');
        const presetBtns = document.querySelectorAll('.deposit-preset-chip');

        const rawAmount = amountEl ? Number(amountEl.value) : 0;
        const validAmount = Number.isFinite(rawAmount) && rawAmount > 0 ? Math.trunc(rawAmount) : 0;
        const pm = findPaymentMethod(methodSelect ? methodSelect.value : '');

        presetBtns.forEach(btn => {
            const match = Number(btn.dataset.amount) === validAmount;
            btn.classList.toggle('active', match);
            btn.setAttribute('aria-pressed', match ? 'true' : 'false');
        });

        if (amountSummaryEl) {
            amountSummaryEl.textContent = validAmount > 0 ? formatRupiahId(validAmount) : '-';
        }
        if (uniqueSummaryEl) {
            uniqueSummaryEl.textContent = pm && pm.is_qris
                ? 'Rp 0 (QRIS tanpa kode unik)'
                : 'Otomatis +3 digit saat diajukan';
        }
        if (totalSummaryEl) {
            if (validAmount > 0) {
                totalSummaryEl.textContent = pm && pm.is_qris
                    ? formatRupiahId(validAmount)
                    : `${formatRupiahId(validAmount)} + kode unik`;
            } else {
                totalSummaryEl.textContent = '-';
            }
        }
    }

    function renderSelectedDepositMethodInfo(selectedValue) {
        const { escapeHtml, isSafeImageUrl } = global.MikuShared.dom;
        const methodInfo = document.getElementById('deposit-method-info');
        const amountInput = document.getElementById('amount');
        const amountHint = document.getElementById('deposit-amount-hint');
        const pm = findPaymentMethod(selectedValue);

        updateDepositPreview();

        if (!methodInfo) return;
        if (!pm) {
            methodInfo.classList.add('hidden');
            methodInfo.innerHTML = '';
            if (amountInput) amountInput.min = '10000';
            if (amountHint) {
                amountHint.textContent = 'Minimum deposit Rp 10.000. Nominal akhir ditambah kode unik 3 digit (kecuali metode QRIS) untuk memudahkan verifikasi.';
            }
            return;
        }

        const meta = getMethodVisualMeta(pm.name, pm.type);
        const minAmount = Math.max(10000, Number(pm.min_amount) || 10000);
        const minFormatted = formatRupiahId(minAmount);

        if (amountInput) {
            amountInput.min = String(minAmount);
            amountInput.placeholder = `Minimal ${new Intl.NumberFormat('id-ID').format(minAmount)}`;
        }
        if (amountHint) {
            amountHint.textContent = pm.is_qris
                ? `Minimum deposit ${minFormatted}. Metode QRIS tidak memakai kode unik 3 digit.`
                : `Minimum deposit ${minFormatted}. Nominal akhir ditambah kode unik 3 digit untuk memudahkan verifikasi.`;
        }

        const acctNumberHtml = pm.account_number
            ? `<div class="selected-target-row">
                   <div>
                       <span class="selected-meta-label">Nomor Rekening / HP Tujuan</span>
                       <strong class="selected-account-number">${escapeHtml(pm.account_number)}</strong>
                   </div>
                   <button type="button" class="copy-deposit-number-btn" data-number="${escapeHtml(pm.account_number)}">
                       <i class="fas fa-copy" aria-hidden="true"></i> Salin
                   </button>
               </div>`
            : '';

        const acctNameHtml = pm.account_name
            ? `<p class="selected-owner-row"><span>Atas Nama:</span> <strong>${escapeHtml(pm.account_name)}</strong></p>`
            : '';

        let qrisHtml = '';
        if (pm.is_qris || pm.type === 'qris') {
            if (isSafeImageUrl(pm.qris_image_url)) {
                qrisHtml = `<div class="selected-qris-box">
                    <span class="selected-meta-label">Scan QRIS Pembayaran</span>
                    <img src="${escapeHtml(pm.qris_image_url)}" alt="Kode QRIS ${escapeHtml(pm.name)}" class="deposit-qris-image" loading="lazy">
                </div>`;
            } else {
                qrisHtml = '<p class="selected-instructions-box">Hubungi admin jika gambar QRIS belum tampil.</p>';
            }
        }

        const instructionsHtml = pm.instructions
            ? `<div class="selected-instructions-box">
                   <strong><i class="fas fa-info-circle" aria-hidden="true"></i> Instruksi Transfer:</strong>
                   <p>${escapeHtml(pm.instructions)}</p>
               </div>`
            : '';

        methodInfo.innerHTML = `
            <div class="selected-card-head">
                <div class="selected-method-title">
                    <i class="${meta.iconClass}" aria-hidden="true"></i>
                    <span>${escapeHtml(pm.name)}</span>
                </div>
                <div class="selected-method-badges">
                    <span class="method-type-badge">${escapeHtml(meta.typeLabel)}</span>
                    <span class="method-min-badge">Min. ${escapeHtml(minFormatted)}</span>
                </div>
            </div>
            ${acctNumberHtml}
            ${acctNameHtml}
            ${qrisHtml}
            ${instructionsHtml}
        `;
        methodInfo.classList.remove('hidden');
    }

    /**
     * Muat daftar metode pembayaran aktif dari API untuk form deposit.
     */
    async function loadDepositPaymentMethods() {
        const { apiFetch } = global.MikuShared.api;
        const methodSelect = document.getElementById('deposit-method');
        const previousVal = methodSelect ? methodSelect.value : '';

        try {
            const response = await apiFetch('/api/payment-methods', { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat daftar metode pembayaran.');
            const methods = await response.json();
            app.state.activePaymentMethods = Array.isArray(methods) ? methods : [];

            if (methodSelect) {
                if (app.state.activePaymentMethods.length === 0) {
                    methodSelect.innerHTML = '<option value="" disabled selected>-- Belum ada metode pembayaran aktif --</option>';
                    renderSelectedDepositMethodInfo('');
                    return;
                }
                methodSelect.innerHTML = '<option value="" disabled selected>-- Pilih Metode Pembayaran --</option>';
                app.state.activePaymentMethods.forEach(pm => {
                    const option = document.createElement('option');
                    option.value = pm.code;
                    option.textContent = pm.is_qris ? `${pm.name} (QRIS - Tanpa Kode Unik)` : pm.name;
                    methodSelect.appendChild(option);
                });
                const stillExists = findPaymentMethod(previousVal);
                methodSelect.value = stillExists ? stillExists.code : '';
                renderSelectedDepositMethodInfo(methodSelect.value);
            }
        } catch (error) {
            if (methodSelect) methodSelect.innerHTML = '<option value="" disabled selected>-- Gagal memuat metode --</option>';
        }
    }

    function prepareDepositIdempotencyKey(payload) {
        const { generateIdempotencyKey } = global.MikuShared.api;
        const signature = JSON.stringify(payload);
        if (app.state.depositAttemptSignature !== null && app.state.depositAttemptSignature !== signature) {
            app.state.depositIdempotencyKey = generateIdempotencyKey();
            app.state.depositAttemptSignature = null;
        }
        if (!app.state.depositIdempotencyKey) {
            app.state.depositIdempotencyKey = generateIdempotencyKey();
        }
        return signature;
    }

    function renderSubmittedDepositInstructions(deposit, selectedPm) {
        const { escapeHtml } = global.MikuShared.dom;
        const targetAcct = selectedPm && selectedPm.account_number
            ? `<button type="button" class="copy-deposit-number-btn" data-number="${escapeHtml(selectedPm.account_number)}">
                   <i class="fas fa-copy" aria-hidden="true"></i> Salin Tujuan
               </button>`
            : '';
        return `
            <div class="ui-state success" style="text-align:left;">
                <p><strong>Permintaan Deposit #${escapeHtml(deposit.id)} berhasil dibuat</strong></p>
                <div class="deposit-instruction-amount-row">
                    <div>
                        <span class="selected-meta-label">Total Yang Harus Ditransfer</span>
                        <span class="deposit-instruction-amount">${escapeHtml(formatRupiahId(deposit.amount))}</span>
                    </div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        <button type="button" class="copy-deposit-number-btn" data-number="${escapeHtml(String(deposit.amount))}">
                            <i class="fas fa-copy" aria-hidden="true"></i> Salin Nominal
                        </button>
                        ${targetAcct}
                    </div>
                </div>
                <p class="deposit-instruction-copy">${deposit.paymentInstructions}</p>
            </div>
        `;
    }

    /**
     * Siapkan event listener form pengajuan deposit, preset nominal, dan pilihan metode via kartu.
     */
    function setupDepositForm() {
        const { escapeHtml } = global.MikuShared.dom;
        const { generateIdempotencyKey, apiFetch } = global.MikuShared.api;
        const depositForm = document.getElementById('deposit-form');
        const paymentInstructionsSection = document.getElementById('payment-instructions');
        const instructionText = document.getElementById('instruction-text');
        const methodSelect = document.getElementById('deposit-method');
        const methodError = document.getElementById('deposit-method-error');
        const amountInput = document.getElementById('amount');
        const presetsContainer = document.getElementById('deposit-presets');
        if (!depositForm || app.state.depositFormSetup) return;

        if (presetsContainer && amountInput) {
            presetsContainer.addEventListener('click', (event) => {
                const chip = event.target.closest('.deposit-preset-chip');
                if (!chip || !chip.dataset.amount) return;
                amountInput.value = chip.dataset.amount;
                updateDepositPreview();
            });
        }
        if (amountInput) {
            amountInput.addEventListener('input', updateDepositPreview);
        }

        if (methodSelect) {
            methodSelect.setAttribute('aria-invalid', 'false');
            methodSelect.addEventListener('change', () => {
                syncSelectAriaState(methodSelect, methodError, true);
                renderSelectedDepositMethodInfo(methodSelect.value);
            });
            methodSelect.addEventListener('invalid', () => {
                syncSelectAriaState(methodSelect, methodError, true);
            });
        }

        depositForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const amtEl = this.querySelector('input[name="amount"]');
            const noteEl = this.querySelector('textarea[name="note"]');
            const method = methodSelect ? methodSelect.value : '';
            const amount = amtEl ? amtEl.value : '';
            const note = noteEl ? noteEl.value.trim() : '';
            const submitButton = this.querySelector('button[type="submit"]');

            if (!method) {
                syncSelectAriaState(methodSelect, methodError, true);
                if (methodSelect) methodSelect.focus();
                return;
            }
            const selectedPm = findPaymentMethod(method);
            const minRequired = selectedPm ? Math.max(10000, Number(selectedPm.min_amount) || 10000) : 10000;
            if (!amtEl || !Number.isFinite(Number(amount)) || Number(amount) < minRequired) {
                alert(`Minimal deposit untuk metode ini adalah ${formatRupiahId(minRequired)}.`);
                if (amtEl) amtEl.focus();
                return;
            }
            if (note.length > 200) {
                alert('Catatan terlalu panjang (maks 200 karakter).');
                if (noteEl) noteEl.focus();
                return;
            }

            if (paymentInstructionsSection) paymentInstructionsSection.classList.remove('hidden');
            if (instructionText) instructionText.innerHTML = '<div class="ui-state loading">Memproses permintaan deposit...</div>';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Memproses...';
            }
            try {
                const body = { amount: parseInt(amount, 10), method };
                if (note) body.note = note;
                app.state.depositAttemptSignature = prepareDepositIdempotencyKey(body);
                const response = await apiFetch('/api/deposit/request', {
                    method: 'POST',
                    auth: true,
                    token: app.state.token,
                    headers: { 'Idempotency-Key': app.state.depositIdempotencyKey },
                    jsonBody: body,
                });
                let result = null;
                let hasDefinitiveJson = false;
                try {
                    result = await response.json();
                    hasDefinitiveJson = result !== null && typeof result === 'object';
                } catch (_) {
                    hasDefinitiveJson = false;
                }

                // Pertahankan Idempotency-Key pada 5xx/jaringan error agar retry aman tanpa double request.
                if (response.status >= 200 && response.status < 500 && hasDefinitiveJson) {
                    app.state.depositIdempotencyKey = generateIdempotencyKey();
                    app.state.depositAttemptSignature = null;
                }
                if (!response.ok) {
                    throw new Error((result && result.message) ? result.message : `Gagal mengajukan deposit (HTTP ${response.status}).`);
                }

                if (instructionText) instructionText.innerHTML = renderSubmittedDepositInstructions(result.deposit, selectedPm);
                depositForm.reset();
                syncSelectAriaState(methodSelect, methodError, false);
                renderSelectedDepositMethodInfo('');
                setTimeout(loadDepositHistory, 500);
            } catch (error) {
                if (instructionText) instructionText.innerHTML = `<div class="ui-state error"><strong>Error:</strong> ${escapeHtml(error.message)}</div>`;
            } finally {
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Ajukan Deposit';
                }
            }
        });

        updateDepositPreview();
        app.state.depositFormSetup = true;
    }

    /**
     * Fetch dan render riwayat deposit user.
     */
    async function loadDepositHistory() {
        const { escapeHtml, tableState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tbody = document.getElementById('deposit-history-body');
        if (!tbody) return;
        tbody.innerHTML = tableState(6, 'Memuat riwayat deposit...', 'loading');
        try {
            const response = await apiFetch('/api/user/deposits', { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat riwayat deposit.');
            const deposits = await response.json();
            if (!Array.isArray(deposits) || deposits.length === 0) {
                tbody.innerHTML = tableState(6, 'Belum ada riwayat deposit. Ajukan isi saldo pada formulir di atas.', 'empty');
                return;
            }
            const statusClassMap = { 'Pending': 'status-pending', 'Success': 'status-success', 'Approved': 'status-success', 'Rejected': 'status-failed' };
            tbody.innerHTML = deposits.map(d => {
                const tgl = new Date(d.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
                const nominal = formatRupiahId(d.amount);
                const cls = statusClassMap[d.status] || 'status-pending';
                const uniqueLabel = Number(d.unique_code) > 0 ? `+${Number(d.unique_code)}` : '-';
                const methodCell = d.method ? escapeHtml(d.method) : '<span class="muted">-</span>';
                return `<tr>
                    <td class="tabular-nums">${escapeHtml(d.id)}</td>
                    <td class="tabular-nums">${escapeHtml(tgl)}</td>
                    <td class="tabular-nums">${escapeHtml(nominal)}</td>
                    <td class="tabular-nums">${escapeHtml(uniqueLabel)}</td>
                    <td>${methodCell}</td>
                    <td><span class="status-badge ${cls}">${escapeHtml(d.status)}</span></td>
                </tr>`;
            }).join('');
        } catch (err) {
            tbody.innerHTML = tableState(6, escapeHtml(err.message || 'Gagal memuat riwayat deposit.'), 'error');
        }
    }

    /**
     * Pasang delegasi klik tombol salin nomor rekening / e-wallet / nominal deposit.
     */
    function bindCopyDelegation() {
        const { copyToClipboard } = global.MikuShared.dom;
        document.addEventListener('click', async function (event) {
            const button = event.target.closest('.copy-deposit-number-btn');
            if (!button) return;

            const number = button.dataset.number || '';
            if (!number || number.startsWith('ISI_NOMOR_')) {
                alert('Nomor pembayaran belum diisi admin.');
                return;
            }

            const originalHTML = button.innerHTML;
            try {
                await copyToClipboard(number);
                button.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> Tersalin';
                button.disabled = true;
                setTimeout(() => {
                    button.innerHTML = originalHTML;
                    button.disabled = false;
                }, 1500);
            } catch (_) {
                alert('Gagal menyalin teks. Silakan salin secara manual.');
            }
        });
    }

    app.deposit = {
        loadDepositPaymentMethods,
        setupDepositForm,
        loadDepositHistory,
        bindCopyDelegation,
        updateDepositPreview,
    };
})(window);
