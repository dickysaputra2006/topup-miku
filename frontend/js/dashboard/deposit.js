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

    function renderDepositMethodsGrid(selectedCode) {
        const { escapeHtml } = global.MikuShared.dom;
        const grid = document.getElementById('deposit-methods-grid');
        if (!grid) return;
        if (!Array.isArray(app.state.activePaymentMethods) || app.state.activePaymentMethods.length === 0) {
            grid.innerHTML = '<div class="ui-state empty">Belum ada metode pembayaran aktif saat ini. Hubungi admin.</div>';
            return;
        }
        grid.innerHTML = app.state.activePaymentMethods.map(pm => {
            const meta = getMethodVisualMeta(pm.name, pm.type);
            const isSelected = selectedCode && String(pm.code).toLowerCase() === String(selectedCode).toLowerCase();
            const minFormatted = formatRupiahId(pm.min_amount || 10000);
            const ownerSuffix = pm.account_name ? ` &bull; A/N ${escapeHtml(pm.account_name)}` : '';
            const acctNumber = pm.account_number ? escapeHtml(pm.account_number) : '';
            const numberOrQrisHtml = acctNumber
                ? `<p class="deposit-method-number">${acctNumber}</p>
                   <button type="button" class="copy-deposit-number-btn" data-number="${acctNumber}">
                       <i class="fas fa-copy"></i> Copy Nomor
                   </button>`
                : (pm.is_qris
                    ? '<p class="deposit-method-number">Scan QRIS pada detail tujuan di bawah</p>'
                    : '<p class="deposit-method-number">-</p>');

            return `
                <div class="deposit-method-item deposit-method-selectable ${isSelected ? 'is-selected' : ''}" data-method-code="${escapeHtml(pm.code)}">
                    <small class="deposit-method-type-label">${escapeHtml(meta.typeLabel)}${ownerSuffix}</small>
                    <span class="deposit-method-label"><i class="${meta.iconClass}"></i> ${escapeHtml(pm.name)}</span>
                    ${numberOrQrisHtml}
                    <small class="deposit-method-min-label">Min. ${minFormatted}${pm.is_qris ? ' &bull; Tanpa kode unik' : ''}</small>
                </div>
            `;
        }).join('');
    }

    function renderSelectedDepositMethodInfo(selectedValue) {
        const { escapeHtml, isSafeImageUrl } = global.MikuShared.dom;
        const methodInfo = document.getElementById('deposit-method-info');
        const amountInput = document.getElementById('amount');
        const amountHint = document.getElementById('deposit-amount-hint');
        const pm = findPaymentMethod(selectedValue);

        renderDepositMethodsGrid(pm ? pm.code : '');

        if (!methodInfo) return;
        if (!pm) {
            methodInfo.classList.add('hidden');
            methodInfo.innerHTML = '';
            if (amountInput) amountInput.min = '10000';
            if (amountHint) {
                amountHint.textContent = 'Minimum deposit Rp 10.000. Nominal akhir akan ditambah kode unik 3 digit (kecuali metode QRIS) untuk memudahkan verifikasi.';
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
                : `Minimum deposit ${minFormatted}. Nominal akhir akan ditambah kode unik 3 digit untuk memudahkan verifikasi.`;
        }

        const acctNumberHtml = pm.account_number
            ? `<div class="selected-target-row">
                   <div>
                       <span class="selected-meta-label">NOMOR REKENING / HP TUJUAN</span>
                       <strong class="selected-account-number">${escapeHtml(pm.account_number)}</strong>
                   </div>
                   <button type="button" class="copy-deposit-number-btn" data-number="${escapeHtml(pm.account_number)}">
                       <i class="fas fa-copy"></i> Salin
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
                    <span class="selected-meta-label">SCAN QRIS PEMBAYARAN</span>
                    <img src="${escapeHtml(pm.qris_image_url)}" alt="Kode QRIS ${escapeHtml(pm.name)}" class="deposit-qris-image" loading="lazy">
                </div>`;
            } else {
                qrisHtml = '<p class="selected-instructions-box">Hubungi admin jika gambar QRIS belum tampil.</p>';
            }
        }

        const instructionsHtml = pm.instructions
            ? `<div class="selected-instructions-box">
                   <strong><i class="fas fa-info-circle"></i> Instruksi Transfer:</strong>
                   <p>${escapeHtml(pm.instructions)}</p>
               </div>`
            : '';

        methodInfo.innerHTML = `
            <div class="selected-card-head">
                <div class="selected-method-title">
                    <i class="${meta.iconClass}"></i>
                    <span>${escapeHtml(pm.name)}</span>
                </div>
                <div class="selected-method-badges">
                    <span class="method-type-badge">${escapeHtml(meta.typeLabel)}</span>
                    <span class="method-min-badge">Min. ${minFormatted}</span>
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
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const grid = document.getElementById('deposit-methods-grid');
        const methodSelect = document.getElementById('deposit-method');
        const previousVal = methodSelect ? methodSelect.value : '';

        if (grid && app.state.activePaymentMethods.length === 0) {
            grid.innerHTML = '<div class="ui-state loading">Memuat metode pembayaran...</div>';
        }

        try {
            const response = await apiFetch('/api/payment-methods', { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat daftar metode pembayaran.');
            const methods = await response.json();
            app.state.activePaymentMethods = Array.isArray(methods) ? methods : [];

            if (methodSelect) {
                methodSelect.innerHTML = '<option value="" disabled selected>-- Pilih Metode Pembayaran --</option>';
                app.state.activePaymentMethods.forEach(pm => {
                    const option = document.createElement('option');
                    option.value = pm.code;
                    option.textContent = pm.is_qris ? `${pm.name} (QRIS - Tanpa Kode Unik)` : pm.name;
                    methodSelect.appendChild(option);
                });
                const stillExists = findPaymentMethod(previousVal);
                if (stillExists) {
                    methodSelect.value = stillExists.code;
                } else {
                    methodSelect.value = '';
                }
                renderSelectedDepositMethodInfo(methodSelect.value);
            } else {
                renderDepositMethodsGrid('');
            }
        } catch (error) {
            if (grid) {
                grid.innerHTML = `<div class="ui-state error">${escapeHtml(error.message)}</div>`;
            }
            if (methodSelect) {
                methodSelect.innerHTML = '<option value="" disabled selected>-- Gagal memuat metode --</option>';
            }
        }
    }

    function prepareDepositIdempotencyKey(payload) {
        const { generateIdempotencyKey } = global.MikuShared.api;
        const signature = JSON.stringify(payload);
        // Rotasi key jika payload berubah dibanding percobaan submit sebelumnya
        if (app.state.depositAttemptSignature !== null && app.state.depositAttemptSignature !== signature) {
            app.state.depositIdempotencyKey = generateIdempotencyKey();
            app.state.depositAttemptSignature = null;
        }
        if (!app.state.depositIdempotencyKey) {
            app.state.depositIdempotencyKey = generateIdempotencyKey();
        }
        return signature;
    }

    /**
     * Siapkan event listener form pengajuan deposit user dan pemilihan metode via kartu.
     */
    function setupDepositForm() {
        const { escapeHtml } = global.MikuShared.dom;
        const { generateIdempotencyKey, apiFetch } = global.MikuShared.api;
        const depositForm = document.getElementById('deposit-form');
        const paymentInstructionsSection = document.getElementById('payment-instructions');
        const instructionText = document.getElementById('instruction-text');
        const methodSelect = document.getElementById('deposit-method');
        const methodError = document.getElementById('deposit-method-error');
        const methodsGrid = document.getElementById('deposit-methods-grid');
        if (!depositForm) return;

        if (app.state.depositFormSetup) return;

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

        if (methodsGrid && methodSelect) {
            methodsGrid.addEventListener('click', (event) => {
                if (event.target.closest('.copy-deposit-number-btn')) return;
                const card = event.target.closest('.deposit-method-selectable');
                if (!card || !card.dataset.methodCode) return;
                methodSelect.value = card.dataset.methodCode;
                syncSelectAriaState(methodSelect, methodError, true);
                renderSelectedDepositMethodInfo(methodSelect.value);
            });
        }

        depositForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const amountInput = this.querySelector('input[name="amount"]');
            const noteEl = this.querySelector('textarea[name="note"]');
            const method = methodSelect ? methodSelect.value : '';
            const amount = amountInput ? amountInput.value : '';
            const note = noteEl ? noteEl.value.trim() : '';
            const submitButton = this.querySelector('button[type="submit"]');

            if (!method) {
                syncSelectAriaState(methodSelect, methodError, true);
                if (methodSelect) methodSelect.focus();
                return;
            }
            const selectedPm = findPaymentMethod(method);
            const minRequired = selectedPm ? Math.max(10000, Number(selectedPm.min_amount) || 10000) : 10000;
            if (!amountInput || !Number.isFinite(Number(amount)) || Number(amount) < minRequired) {
                alert(`Minimal deposit untuk metode ini adalah ${formatRupiahId(minRequired)}.`);
                if (amountInput) amountInput.focus();
                return;
            }
            if (note.length > 200) {
                alert('Catatan terlalu panjang (maks 200 karakter).');
                if (noteEl) noteEl.focus();
                return;
            }

            paymentInstructionsSection.classList.remove('hidden');
            instructionText.innerHTML = '<div class="ui-state loading">Memproses permintaan deposit...</div>';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = 'Memproses...';
            }
            try {
                const body = { amount: parseInt(amount, 10), method };
                if (note) body.note = note;
                const currentSignature = prepareDepositIdempotencyKey(body);
                app.state.depositAttemptSignature = currentSignature;
                const response = await apiFetch('/api/deposit/request', {
                    method: 'POST',
                    auth: true,
                    token: app.state.token,
                    headers: {
                        'Idempotency-Key': app.state.depositIdempotencyKey
                    },
                    jsonBody: body
                });
                let result = null;
                let hasDefinitiveJson = false;
                try {
                    result = await response.json();
                    hasDefinitiveJson = result !== null && typeof result === 'object';
                } catch (_) {
                    hasDefinitiveJson = false;
                }

                // Rotasi key hanya pada respons definitif 2xx/4xx JSON agar user bisa mengajukan ulang dengan key baru.
                // Pertahankan key pada 5xx (meski JSON) dan error jaringan/timeout karena kondisi server bisa
                // ambigu (mis. transaksi sudah/sedang diproses), sehingga retry aman tanpa duplikasi deposit.
                if (response.status >= 200 && response.status < 500 && hasDefinitiveJson) {
                    app.state.depositIdempotencyKey = generateIdempotencyKey();
                    app.state.depositAttemptSignature = null;
                }

                if (!response.ok) {
                    throw new Error((result && result.message) ? result.message : `Gagal mengajukan deposit (HTTP ${response.status}).`);
                }
                instructionText.innerHTML = `<div class="ui-state success">
                        <p><strong>Request #${escapeHtml(result.deposit.id)} berhasil dibuat!</strong></p>
                        <p style="margin-top:0.5rem;">${result.deposit.paymentInstructions}</p>
                        <p style="margin-top:0.5rem; color:#ffc107;"><i class="fas fa-clock"></i> Saldo akan masuk setelah admin memverifikasi pembayaran Anda.</p>
                    </div>`;
                depositForm.reset();
                syncSelectAriaState(methodSelect, methodError, false);
                renderSelectedDepositMethodInfo('');
                setTimeout(loadDepositHistory, 500);
            } catch (error) {
                instructionText.innerHTML = `<div class="ui-state error"><strong>Error:</strong> ${escapeHtml(error.message)}</div>`;
            } finally {
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Ajukan Deposit';
                }
            }
        });
        app.state.depositFormSetup = true;
    }

    /**
     * Fetch dan render riwayat deposit user.
     */
    async function loadDepositHistory() {
        const { escapeHtml } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const tbody = document.getElementById('deposit-history-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Memuat...</td></tr>';
        try {
            const response = await apiFetch('/api/user/deposits', { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat riwayat');
            const deposits = await response.json();
            if (deposits.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#aaa;">Belum ada riwayat deposit.</td></tr>';
                return;
            }
            const statusClassMap = { 'Pending': 'status-pending', 'Success': 'status-success', 'Approved': 'status-success', 'Rejected': 'status-failed' };
            tbody.innerHTML = deposits.map(d => {
                const tgl = new Date(d.created_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
                const nominal = formatRupiahId(d.amount);
                const cls = statusClassMap[d.status] || 'status-pending';
                const uniqueLabel = Number(d.unique_code) > 0 ? `+${Number(d.unique_code)}` : '-';
                const methodCell = d.method ? escapeHtml(d.method) : '<span style="color:#6b7280;">-</span>';
                return `<tr>
                        <td>${escapeHtml(d.id)}</td>
                        <td>${escapeHtml(tgl)}</td>
                        <td>${escapeHtml(nominal)}</td>
                        <td>${escapeHtml(uniqueLabel)}</td>
                        <td style="white-space:nowrap;">${methodCell}</td>
                        <td><span class="badge ${cls}">${escapeHtml(d.status)}</span></td>
                    </tr>`;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#f87171;">Gagal memuat riwayat deposit.</td></tr>`;
        }
    }

    /**
     * Pasang delegasi klik tombol salin nomor rekening / e-wallet deposit.
     */
    function bindCopyDelegation() {
        const { copyToClipboard } = global.MikuShared.dom;
        // Copy nomor deposit — event delegation untuk .copy-deposit-number-btn
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
                button.innerHTML = '<i class="fas fa-check"></i> Tersalin!';
                button.disabled = true;
                setTimeout(() => {
                    button.innerHTML = originalHTML;
                    button.disabled = false;
                }, 1500);
            } catch (err) {
                alert('Gagal menyalin nomor. Silakan salin manual.');
            }
        });
    }

    app.deposit = {
        loadDepositPaymentMethods,
        setupDepositForm,
        loadDepositHistory,
        bindCopyDelegation,
    };
})(window);
