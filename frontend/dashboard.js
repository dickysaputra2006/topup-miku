document.addEventListener('DOMContentLoaded', function () {
    // --- KODE UNTUK MENU HAMBURGER DI DASHBOARD ---
    const sidebar = document.querySelector('.sidebar');
    document.querySelectorAll('#menu-toggle-btn, .menu-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('active');
            document.body.classList.toggle('menu-open');
        });
    });

    document.addEventListener('click', function (event) {
        if (sidebar && sidebar.classList.contains('active')) {
            if (!sidebar.contains(event.target) && !event.target.closest('#menu-toggle-btn') && !event.target.closest('.menu-toggle-btn')) {
                sidebar.classList.remove('active');
                document.body.classList.remove('menu-open');
            }
        }
    });

    const API_URL = '/api/user';
    const token = localStorage.getItem('authToken');

    if (!token) {
        window.location.href = 'index.html';
        return;
    }
    const logoutButton = document.getElementById('logout-button');
    const editProfileBtn = document.querySelector('.edit-btn');
    const editModal = document.getElementById('edit-profile-modal');
    const closeEditModalBtn = document.getElementById('close-edit-modal-btn');
    const editProfileForm = document.getElementById('edit-profile-form');
    const changePasswordForm = document.getElementById('change-password-form');

    const tabLinks = document.querySelectorAll('.tab-link');
    const tabContents = document.querySelectorAll('.tab-content');

    const dashboardNavLinks = document.querySelectorAll('.dashboard-nav-link');
    const dashboardSections = document.querySelectorAll('.dashboard-section');

    const generateApiKeyBtn = document.getElementById('generate-api-key-btn');
    const revokeApiKeyBtn = document.getElementById('revoke-api-key-btn');
    const apiKeyDisplay = document.getElementById('api-key-display');
    const apiKeyStatusBadge = document.getElementById('h2h-apikey-status-badge');
    const webhookSecretDisplay = document.getElementById('webhook-secret-display');
    const webhookStatusBadge = document.getElementById('h2h-webhook-status-badge');
    const rotateWebhookSecretBtn = document.getElementById('rotate-webhook-secret-btn');
    const h2hSecretModal = document.getElementById('h2h-secret-modal');
    const closeH2HSecretModalBtn = document.getElementById('close-h2h-secret-modal-btn');
    const h2hAckSecretModalBtn = document.getElementById('h2h-ack-secret-modal-btn');
    const h2hSecretModalTitle = document.getElementById('h2h-secret-modal-title');
    const h2hRevealedPrimaryLabel = document.getElementById('h2h-revealed-primary-label');
    const h2hRevealedPrimaryValue = document.getElementById('h2h-revealed-primary-value');
    const h2hCopyPrimaryBtn = document.getElementById('h2h-copy-primary-btn');
    const h2hRevealedSecondaryGroup = document.getElementById('h2h-revealed-secondary-group');
    const h2hRevealedSecondaryValue = document.getElementById('h2h-revealed-secondary-value');
    const h2hCopySecondaryBtn = document.getElementById('h2h-copy-secondary-btn');
    const h2hConfirmModal = document.getElementById('h2h-confirm-modal');
    const closeH2HConfirmModalBtn = document.getElementById('close-h2h-confirm-modal-btn');
    const h2hConfirmTitle = document.getElementById('h2h-confirm-title');
    const h2hConfirmMessage = document.getElementById('h2h-confirm-message');
    const h2hConfirmCancelBtn = document.getElementById('h2h-confirm-cancel-btn');
    const h2hConfirmAcceptBtn = document.getElementById('h2h-confirm-accept-btn');
    const cekPesananForm = document.getElementById('cek-pesanan-form');
    const hasilCekPesanan = document.getElementById('hasil-cek-pesanan');
    const whitelistIpForm = document.getElementById('whitelist-ip-form');
    const currentIpsList = document.getElementById('current-ips-list');

    let apiKeyFetched = false;
    let currentHasApiKey = false;
    let currentHasWebhookSecret = false;
    let h2hActionBusy = false;
    let mutasiLoaded = false;
    let transaksiLoaded = false;
    let depositFormSetup = false;
    let activePaymentMethods = [];

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isSafeImageUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return false;
        const trimmed = rawUrl.trim();
        if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
        try {
            const parsed = new URL(trimmed);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

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



    // Fungsi untuk menampilkan notifikasi melayang
    function showToast(message) {
        const toast = document.getElementById('toast-notification');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.add('show');

        // Sembunyikan notifikasi setelah 5 detik
        setTimeout(() => {
            toast.classList.remove('show');
            // Tambahkan sedikit jeda sebelum menyembunyikan total agar transisi selesai
            setTimeout(() => toast.classList.add('hidden'), 300);
        }, 5000);
    }

    function tableState(colspan, message, type = 'loading') {
        const rowClass = type === 'error' ? 'table-error-row' : type === 'empty' ? 'table-empty-row' : 'table-loading-row';
        return `<tr class="${rowClass}"><td colspan="${colspan}"><div class="ui-state ${type}">${message}</div></td></tr>`;
    }

    function statusClass(status) {
        return `status-${String(status || 'pending').toLowerCase().replace(/\s+/g, '-')}`;
    }

    function statusLabel(status) {
        const normalized = String(status || 'Pending').toLowerCase();
        if (normalized === 'success') return 'Berhasil';
        if (normalized === 'failed') return 'Gagal';
        if (normalized === 'refunded') return 'Refund';
        if (normalized === 'partial refund') return 'Perlu Review';
        return 'Pending';
    }

    // Fungsi untuk melakukan logout
    function forceLogout(message) {
        localStorage.removeItem('authToken'); // Hapus token yang tidak valid
        // Simpan pesan di sessionStorage untuk ditampilkan di halaman utama
        sessionStorage.setItem('logoutMessage', message);
        window.location.href = 'index.html'; // Arahkan ke halaman utama
    }

    async function fetchProfileData() {
        try {
            const response = await fetch(`${API_URL}/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            // --- INI BAGIAN PENTINGNYA ---
            if (response.status === 401) {
                // Jika token tidak valid/kadaluarsa (unauthorized)
                forceLogout('Sesi Anda telah berakhir, silakan login kembali.');
                return; // Hentikan eksekusi
            }

            if (!response.ok) throw new Error('Gagal memuat data profil.');

            const data = await response.json();
            updateDashboardUI(data);
        } catch (error) {
            // Jika error bukan karena token, tampilkan di console
            console.error('Error fetching profile data:', error);
        }
    }

    async function fetchTransactionSummary() {
        try {
            const response = await fetch(`${API_URL}/transaction-summary`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return; // Jangan lakukan apa-apa jika gagal
            const summary = await response.json();

            document.getElementById('count-berhasil').textContent = summary.berhasil;
            document.getElementById('count-pending').textContent = summary.pending;
            document.getElementById('count-gagal').textContent = summary.gagal;
            const reviewEl = document.getElementById('count-review');
            if (reviewEl) reviewEl.textContent = summary.review || 0;

            const totalTxEl = document.getElementById('count-total-tx');
            if (totalTxEl) {
                const totalTx = Number(summary.berhasil || 0)
                    + Number(summary.pending || 0)
                    + Number(summary.gagal || 0)
                    + Number(summary.review || 0);
                totalTxEl.textContent = totalTx.toLocaleString('id-ID');
            }
        } catch (error) {
            console.error('Gagal memuat ringkasan transaksi:', error);
        }
    }

    // Fungsi dari transaksi.js
    async function fetchTransactions() {
        const tableBody = document.querySelector("#transactions-table tbody");
        if (!tableBody) return;
        tableBody.innerHTML = tableState(6, 'Memuat riwayat transaksi...', 'loading');
        try {
            const response = await fetch(`${API_URL}/transactions`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal mengambil data transaksi.');
            const transactions = await response.json();
            renderTransactionsTable(transactions, tableBody);
            transaksiLoaded = true;
        } catch (error) {
            tableBody.innerHTML = tableState(6, error.message, 'error');
        }
    }

    // Fungsi dari transaksi.js
    function renderTransactionsTable(transactions, tableBody) {
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (transactions.length === 0) {
            tableBody.innerHTML = tableState(6, 'Belum ada transaksi. Pesanan baru akan muncul di sini.', 'empty');
            return;
        }
        transactions.forEach(tx => {
            const row = document.createElement('tr');
            const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(tx.price);
            row.innerHTML = `
                    <td><a href="invoice.html?id=${encodeURIComponent(tx.invoice_id)}" class="history-link">${escapeHtml(tx.invoice_id)}</a></td>
                    <td>${new Date(tx.created_at).toLocaleString('id-ID')}</td>
                    <td>${tx.product_name}</td>
                    <td>${tx.target_game_id}</td>
                    <td>${formattedPrice}</td>
                    <td><span class="status-badge ${statusClass(tx.status)}">${statusLabel(tx.status)}</span></td>
                `;
            tableBody.appendChild(row);
        });
    }

    // Fungsi deposit tab
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

    function formatRupiahId(val) {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(Number(val) || 0);
    }

    function findPaymentMethod(value) {
        if (!value) return null;
        const norm = String(value).trim().toLowerCase();
        return activePaymentMethods.find(pm =>
            String(pm.code || '').toLowerCase() === norm ||
            String(pm.name || '').toLowerCase() === norm
        ) || null;
    }

    function renderDepositMethodsGrid(selectedCode) {
        const grid = document.getElementById('deposit-methods-grid');
        if (!grid) return;
        if (!Array.isArray(activePaymentMethods) || activePaymentMethods.length === 0) {
            grid.innerHTML = '<div class="ui-state empty">Belum ada metode pembayaran aktif saat ini. Hubungi admin.</div>';
            return;
        }
        grid.innerHTML = activePaymentMethods.map(pm => {
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

    async function loadDepositPaymentMethods() {
        const grid = document.getElementById('deposit-methods-grid');
        const methodSelect = document.getElementById('deposit-method');
        const previousVal = methodSelect ? methodSelect.value : '';

        if (grid && activePaymentMethods.length === 0) {
            grid.innerHTML = '<div class="ui-state loading">Memuat metode pembayaran...</div>';
        }

        try {
            const response = await fetch('/api/payment-methods', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) throw new Error('Gagal memuat daftar metode pembayaran.');
            const methods = await response.json();
            activePaymentMethods = Array.isArray(methods) ? methods : [];

            if (methodSelect) {
                methodSelect.innerHTML = '<option value="" disabled selected>-- Pilih Metode Pembayaran --</option>';
                activePaymentMethods.forEach(pm => {
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

    function generateClientUuidV4() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            window.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        throw new Error('Browser tidak mendukung generator UUID yang aman.');
    }

    let depositIdempotencyKey = generateClientUuidV4();
    let depositAttemptSignature = null;

    function prepareDepositIdempotencyKey(payload) {
        const signature = JSON.stringify(payload);
        // Rotasi key jika payload berubah dibanding percobaan submit sebelumnya
        if (depositAttemptSignature !== null && depositAttemptSignature !== signature) {
            depositIdempotencyKey = generateClientUuidV4();
            depositAttemptSignature = null;
        }
        if (!depositIdempotencyKey) {
            depositIdempotencyKey = generateClientUuidV4();
        }
        return signature;
    }

    function setupDepositForm() {
        const depositForm = document.getElementById('deposit-form');
        const paymentInstructionsSection = document.getElementById('payment-instructions');
        const instructionText = document.getElementById('instruction-text');
        const methodSelect = document.getElementById('deposit-method');
        const methodError = document.getElementById('deposit-method-error');
        const methodsGrid = document.getElementById('deposit-methods-grid');
        if (!depositForm) return;

        if (depositFormSetup) return;

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
                depositAttemptSignature = currentSignature;
                const response = await fetch('/api/deposit/request', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Idempotency-Key': depositIdempotencyKey
                    },
                    body: JSON.stringify(body)
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
                    depositIdempotencyKey = generateClientUuidV4();
                    depositAttemptSignature = null;
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
        depositFormSetup = true;
    }

    // Fetch dan render riwayat deposit user
    async function loadDepositHistory() {
        const tbody = document.getElementById('deposit-history-body');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Memuat...</td></tr>';
        try {
            const response = await fetch('/api/user/deposits', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
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

    function getInitials(name, fallback) {
        const cleaned = String(name || fallback || 'MK').trim();
        if (!cleaned) return 'MK';
        const parts = cleaned.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return cleaned.slice(0, 2).toUpperCase();
    }

    function updateDashboardUI(data) {
        document.getElementById('profile-fullname').textContent = data.full_name;
        document.getElementById('profile-username').textContent = data.username;
        document.getElementById('profile-email').textContent = data.email;
        document.getElementById('profile-nomorwa').textContent = data.nomor_wa;
        document.getElementById('profile-role').textContent = data.role;
        document.getElementById('profile-balance').textContent = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(data.balance);

        const initials = getInitials(data.full_name, data.username);
        ['header-user-initials', 'sidebar-user-initials', 'profile-avatar-badge'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = initials;
        });

        const headerNameEl = document.getElementById('header-user-name');
        if (headerNameEl) headerNameEl.textContent = data.username || data.full_name || 'Member';
        const sidebarNameEl = document.getElementById('sidebar-user-name');
        if (sidebarNameEl) sidebarNameEl.textContent = data.username || data.full_name || 'Member';
        const sidebarRoleEl = document.getElementById('sidebar-user-role');
        if (sidebarRoleEl) sidebarRoleEl.textContent = data.role || 'Member';

        if (editProfileForm) {
            editProfileForm.querySelector('[name="fullName"]').value = data.full_name;
            editProfileForm.querySelector('[name="email"]').value = data.email;
            editProfileForm.querySelector('[name="nomorWa"]').value = data.nomor_wa;
        }
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) {
            throw new Error('Copy failed');
        }
    }

    function resetH2HCopyButton(button) {
        if (!button) return;
        if (button._copyResetTimer) {
            clearTimeout(button._copyResetTimer);
            button._copyResetTimer = null;
        }
        if (button.dataset.defaultHtml) {
            button.innerHTML = button.dataset.defaultHtml;
        }
        button.disabled = false;
    }

    function attachH2HCopyButton(button, getValue) {
        if (!button) return;
        if (!button.dataset.defaultHtml) {
            button.dataset.defaultHtml = button.innerHTML;
        }
        button.addEventListener('click', async () => {
            const value = getValue();
            if (!value) return;
            try {
                await copyTextToClipboard(value);
                if (button._copyResetTimer) {
                    clearTimeout(button._copyResetTimer);
                }
                button.innerHTML = '<i class="fas fa-check"></i> Tersalin';
                button.disabled = true;
                showToast('Kredensial berhasil disalin ke clipboard.');
                button._copyResetTimer = setTimeout(() => {
                    resetH2HCopyButton(button);
                }, 1500);
            } catch (err) {
                showToast('Gagal menyalin otomatis. Silakan salin teks secara manual.');
            }
        });
    }

    async function requestUserApi(path, options = {}) {
        const response = await fetch(`${API_URL}${path}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                ...(options.headers || {})
            }
        });
        if (response.status === 401) {
            forceLogout('Sesi Anda telah berakhir, silakan login kembali.');
            throw new Error('Sesi berakhir.');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || 'Permintaan gagal diproses.');
        }
        return data;
    }

    function applyCredentialStatusUI({ badgeEl, displayEl, active, prefix, activeLabel, inactiveLabel, inactiveDisplay }) {
        if (badgeEl) {
            badgeEl.textContent = active ? activeLabel : inactiveLabel;
            badgeEl.className = active ? 'status-badge status-success' : 'status-badge status-inactive';
        }
        if (displayEl) {
            displayEl.textContent = active
                ? (prefix ? `${prefix}••••••••` : 'Aktif (prefix tidak tersedia)')
                : inactiveDisplay;
        }
    }

    function renderApiKeyState({ hasApiKey, prefix }) {
        currentHasApiKey = Boolean(hasApiKey);
        applyCredentialStatusUI({
            badgeEl: apiKeyStatusBadge,
            displayEl: apiKeyDisplay,
            active: currentHasApiKey,
            prefix,
            activeLabel: 'Aktif',
            inactiveLabel: 'Belum Aktif',
            inactiveDisplay: 'Belum ada API Key aktif. Klik tombol untuk membuat.'
        });
        if (generateApiKeyBtn) {
            generateApiKeyBtn.innerHTML = currentHasApiKey
                ? '<i class="fas fa-sync-alt"></i> Regenerate API Key'
                : '<i class="fas fa-key"></i> Generate API Key';
        }
        if (revokeApiKeyBtn) {
            revokeApiKeyBtn.classList.toggle('hidden', !currentHasApiKey);
            revokeApiKeyBtn.disabled = !currentHasApiKey;
        }
    }

    function renderWebhookSecretState({ hasWebhookSecret, prefix }) {
        currentHasWebhookSecret = Boolean(hasWebhookSecret);
        applyCredentialStatusUI({
            badgeEl: webhookStatusBadge,
            displayEl: webhookSecretDisplay,
            active: currentHasWebhookSecret,
            prefix,
            activeLabel: 'Aktif',
            inactiveLabel: 'Belum Dibuat',
            inactiveDisplay: 'Belum dibuat. Akan dibuat otomatis atau klik Putar Webhook Secret.'
        });
        if (rotateWebhookSecretBtn) {
            rotateWebhookSecretBtn.innerHTML = currentHasWebhookSecret
                ? '<i class="fas fa-shield-alt"></i> Putar Webhook Secret'
                : '<i class="fas fa-plus"></i> Buat Webhook Secret';
        }
    }

    function openH2HSecretModal({ title, primaryLabel, primaryValue, secondaryValue = '' }) {
        if (!h2hSecretModal || !h2hRevealedPrimaryValue) return;
        if (h2hSecretModalTitle) {
            h2hSecretModalTitle.textContent = title;
        }
        if (h2hRevealedPrimaryLabel) {
            h2hRevealedPrimaryLabel.textContent = primaryLabel;
        }
        h2hRevealedPrimaryValue.textContent = primaryValue || '';
        resetH2HCopyButton(h2hCopyPrimaryBtn);
        resetH2HCopyButton(h2hCopySecondaryBtn);

        if (h2hRevealedSecondaryGroup && h2hRevealedSecondaryValue) {
            if (secondaryValue) {
                h2hRevealedSecondaryValue.textContent = secondaryValue;
                h2hRevealedSecondaryGroup.classList.remove('hidden');
            } else {
                h2hRevealedSecondaryValue.textContent = '';
                h2hRevealedSecondaryGroup.classList.add('hidden');
            }
        }
        h2hSecretModal.classList.remove('hidden');
    }

    function closeH2HSecretModal() {
        if (!h2hSecretModal) return;
        h2hSecretModal.classList.add('hidden');
        if (h2hRevealedPrimaryValue) h2hRevealedPrimaryValue.textContent = '';
        if (h2hRevealedSecondaryValue) h2hRevealedSecondaryValue.textContent = '';
        if (h2hRevealedSecondaryGroup) h2hRevealedSecondaryGroup.classList.add('hidden');
        resetH2HCopyButton(h2hCopyPrimaryBtn);
        resetH2HCopyButton(h2hCopySecondaryBtn);
    }

    let pendingConfirmHandler = null;

    function closeH2HConfirmModal(force = false) {
        if (!h2hConfirmModal || (h2hActionBusy && !force)) return;
        pendingConfirmHandler = null;
        h2hConfirmModal.classList.add('hidden');
        if (h2hConfirmAcceptBtn) h2hConfirmAcceptBtn.disabled = false;
        if (h2hConfirmCancelBtn) h2hConfirmCancelBtn.disabled = false;
    }

    function openH2HConfirmModal({ title, message, confirmLabel = 'Lanjutkan', danger = true, onConfirm }) {
        if (!h2hConfirmModal || !h2hConfirmAcceptBtn) return;
        if (h2hConfirmTitle) h2hConfirmTitle.textContent = title;
        if (h2hConfirmMessage) h2hConfirmMessage.textContent = message;
        h2hConfirmAcceptBtn.textContent = confirmLabel;
        h2hConfirmAcceptBtn.classList.toggle('h2h-btn-danger', danger);
        h2hConfirmAcceptBtn.classList.toggle('h2h-btn-primary', !danger);
        h2hConfirmAcceptBtn.disabled = false;
        if (h2hConfirmCancelBtn) h2hConfirmCancelBtn.disabled = false;
        pendingConfirmHandler = onConfirm;
        h2hConfirmModal.classList.remove('hidden');
    }

    async function fetchApiKey() {
        if (!apiKeyDisplay) return;
        apiKeyDisplay.textContent = 'Memuat status API Key...';
        try {
            const data = await requestUserApi('/apikey');
            renderApiKeyState({
                hasApiKey: data.hasApiKey,
                prefix: data.prefix
            });
            apiKeyFetched = true;
        } catch (error) {
            console.error(error);
            apiKeyDisplay.textContent = 'Gagal memuat status API Key.';
            if (apiKeyStatusBadge) {
                apiKeyStatusBadge.textContent = 'Gagal Muat';
                apiKeyStatusBadge.className = 'status-badge status-failed';
            }
        }
    }

    async function fetchWebhookSecretStatus() {
        if (!webhookSecretDisplay) return;
        webhookSecretDisplay.textContent = 'Memuat status Webhook Secret...';
        try {
            const data = await requestUserApi('/webhook-secret');
            renderWebhookSecretState({
                hasWebhookSecret: data.hasWebhookSecret,
                prefix: data.prefix
            });
        } catch (error) {
            console.error(error);
            webhookSecretDisplay.textContent = 'Gagal memuat status Webhook Secret.';
            if (webhookStatusBadge) {
                webhookStatusBadge.textContent = 'Gagal Muat';
                webhookStatusBadge.className = 'status-badge status-failed';
            }
        }
    }

    async function fetchBalanceHistory() {
        const tableBody = document.querySelector("#mutasi-table tbody");
        if (!tableBody) return;
        tableBody.innerHTML = tableState(4, 'Memuat riwayat mutasi saldo...', 'loading');
        try {
            const response = await fetch(`${API_URL}/balance-history`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal mengambil data mutasi.');
            const history = await response.json();
            renderMutasiTable(history, tableBody);
            mutasiLoaded = true;
        } catch (error) {
            tableBody.innerHTML = tableState(4, error.message, 'error');
        }
    }

    function renderMutasiTable(history, tableBody) {
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
                <td>${new Date(item.created_at).toLocaleString('id-ID')}</td>
                <td><span class="badge type-${item.type.toLowerCase()}">${item.type}</span></td>
                <td>${item.description}</td>
                <td class="${amountClass}">${amountSign} ${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(item.amount)}</td>
            `;
            tableBody.appendChild(row);
        });
    }

    async function fetchAndDisplayWhitelistedIPs() {
        const ipListContainer = document.getElementById('current-ips-list');
        const ipInput = document.getElementById('whitelist-ip-input');
        if (!ipListContainer || !ipInput) return;

        try {
            const ips = await requestUserApi('/whitelisted-ips');

            ipListContainer.innerHTML = '';
            if (ips.length > 0) {
                ips.forEach(ip => {
                    const ipTag = document.createElement('div');
                    ipTag.className = 'ip-tag';
                    ipTag.innerHTML = `
                    <span>${escapeHtml(ip)}</span>
                    <button type="button" class="ip-tag-delete" data-ip="${escapeHtml(ip)}" title="Hapus IP">&times;</button>
                `;
                    ipListContainer.appendChild(ipTag);
                });
            } else {
                ipListContainer.innerHTML = '<p class="h2h-muted">Belum ada IP yang didaftarkan.</p>';
            }
        } catch (error) {
            console.error(error);
            ipListContainer.innerHTML = `<div class="ui-state error">${escapeHtml(error.message)}</div>`;
        }
    }

    async function saveWhitelistedIps(ips) {
        const result = await requestUserApi('/whitelisted-ips', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips })
        });
        showToast(result.message || 'Daftar IP whitelist diperbarui.');
        await fetchAndDisplayWhitelistedIPs();
        return result;
    }

    function loadIntegrasiSectionData() {
        fetchApiKey();
        fetchWebhookSecretStatus();
        fetchAndDisplayWhitelistedIPs();
    }

    const integrasiSection = document.getElementById('integrasi');
    if (integrasiSection && !integrasiSection.classList.contains('hidden')) {
        loadIntegrasiSectionData();
    }

    if (dashboardNavLinks.length > 0 && dashboardSections.length > 0) {
        dashboardNavLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = link.dataset.target;
                if (!targetId) return;

                if (sidebar && sidebar.classList.contains('active')) {
                    sidebar.classList.remove('active');
                    document.body.classList.remove('menu-open');
                }

                dashboardNavLinks.forEach(navLink => navLink.classList.remove('active'));
                document.querySelectorAll(`.sidebar-nav .dashboard-nav-link[data-target="${targetId}"]`).forEach(navLink => {
                    navLink.classList.add('active');
                });

                dashboardSections.forEach(section => {
                    if (section) {
                        section.classList.toggle('hidden', section.id !== targetId);
                    }
                });

                window.scrollTo({ top: 0, behavior: 'smooth' });

                if (targetId === 'integrasi' && !apiKeyFetched) {
                    loadIntegrasiSectionData();
                }

                if (targetId === 'mutasi-saldo' && !mutasiLoaded) {
                    fetchBalanceHistory();
                }

                if (targetId === 'transaksi-tab' && !transaksiLoaded) {
                    fetchTransactions();
                }
                if (targetId === 'deposit-tab') {
                    if (depositAttemptSignature === null) {
                        depositIdempotencyKey = generateClientUuidV4();
                    }
                    setupDepositForm();
                    loadDepositPaymentMethods();
                    loadDepositHistory();
                }

            });
        });
    }

    attachH2HCopyButton(h2hCopyPrimaryBtn, () => (h2hRevealedPrimaryValue ? h2hRevealedPrimaryValue.textContent.trim() : ''));
    attachH2HCopyButton(h2hCopySecondaryBtn, () => (h2hRevealedSecondaryValue ? h2hRevealedSecondaryValue.textContent.trim() : ''));

    if (closeH2HSecretModalBtn) {
        closeH2HSecretModalBtn.addEventListener('click', closeH2HSecretModal);
    }
    if (h2hAckSecretModalBtn) {
        h2hAckSecretModalBtn.addEventListener('click', closeH2HSecretModal);
    }
    if (closeH2HConfirmModalBtn) {
        closeH2HConfirmModalBtn.addEventListener('click', () => closeH2HConfirmModal());
    }
    if (h2hConfirmCancelBtn) {
        h2hConfirmCancelBtn.addEventListener('click', () => closeH2HConfirmModal());
    }
    if (h2hConfirmModal) {
        h2hConfirmModal.addEventListener('click', (e) => {
            if (e.target === h2hConfirmModal) closeH2HConfirmModal();
        });
    }
    if (h2hConfirmAcceptBtn) {
        h2hConfirmAcceptBtn.addEventListener('click', async () => {
            if (!pendingConfirmHandler || h2hActionBusy) return;
            const action = pendingConfirmHandler;
            h2hActionBusy = true;
            h2hConfirmAcceptBtn.disabled = true;
            if (h2hConfirmCancelBtn) h2hConfirmCancelBtn.disabled = true;
            try {
                await action();
            } finally {
                h2hActionBusy = false;
                closeH2HConfirmModal(true);
            }
        });
    }

    async function executeGenerateOrRegenerate(isRegenerate) {
        if (generateApiKeyBtn) generateApiKeyBtn.disabled = true;
        try {
            const endpoint = isRegenerate ? '/apikey/regenerate' : '/generate-apikey';
            const result = await requestUserApi(endpoint, { method: 'POST' });
            renderApiKeyState({
                hasApiKey: result.hasApiKey !== undefined ? result.hasApiKey : true,
                prefix: result.prefix
            });
            apiKeyFetched = true;
            if (result.webhookSecret) {
                await fetchWebhookSecretStatus();
            }
            closeH2HConfirmModal(true);
            openH2HSecretModal({
                title: result.webhookSecret
                    ? 'API Key & Webhook Secret Baru'
                    : (isRegenerate ? 'API Key Baru (Regenerate)' : 'API Key H2H Baru'),
                primaryLabel: 'API Key H2H (tampil sekali)',
                primaryValue: result.apiKey,
                secondaryValue: result.webhookSecret || ''
            });
            showToast(result.message || 'API Key berhasil dibuat.');
        } catch (error) {
            showToast(`Error: ${error.message}`);
        } finally {
            if (generateApiKeyBtn) generateApiKeyBtn.disabled = false;
        }
    }

    if (generateApiKeyBtn) {
        generateApiKeyBtn.addEventListener('click', () => {
            if (currentHasApiKey) {
                openH2HConfirmModal({
                    title: 'Buat Ulang API Key H2H?',
                    message: 'API Key lama akan segera dinonaktifkan dan tidak dapat digunakan lagi. Pastikan Anda memperbarui konfigurasi integrasi H2H Anda setelah key baru dibuat.',
                    confirmLabel: 'Ya, Buat Ulang Key',
                    danger: true,
                    onConfirm: () => executeGenerateOrRegenerate(true)
                });
                return;
            }
            executeGenerateOrRegenerate(false);
        });
    }

    if (revokeApiKeyBtn) {
        revokeApiKeyBtn.addEventListener('click', () => {
            if (!currentHasApiKey) return;
            openH2HConfirmModal({
                title: 'Cabut API Key H2H?',
                message: 'API Key yang aktif akan langsung dicabut. Semua request ke /h2h/* menggunakan key ini akan ditolak sampai Anda membuat API Key baru.',
                confirmLabel: 'Ya, Cabut API Key',
                danger: true,
                onConfirm: async () => {
                    if (revokeApiKeyBtn) revokeApiKeyBtn.disabled = true;
                    try {
                        const result = await requestUserApi('/apikey', { method: 'DELETE' });
                        renderApiKeyState({
                            hasApiKey: result.hasApiKey,
                            prefix: result.prefix
                        });
                        showToast(result.message || 'API Key berhasil dicabut.');
                    } catch (error) {
                        showToast(`Error: ${error.message}`);
                    } finally {
                        if (revokeApiKeyBtn) revokeApiKeyBtn.disabled = !currentHasApiKey;
                    }
                }
            });
        });
    }

    async function executeRotateWebhookSecret() {
        if (rotateWebhookSecretBtn) rotateWebhookSecretBtn.disabled = true;
        try {
            const result = await requestUserApi('/webhook-secret/rotate', { method: 'POST' });
            renderWebhookSecretState({
                hasWebhookSecret: result.hasWebhookSecret !== undefined ? result.hasWebhookSecret : true,
                prefix: result.prefix
            });
            closeH2HConfirmModal(true);
            openH2HSecretModal({
                title: 'Webhook Secret Baru',
                primaryLabel: 'Webhook Secret HMAC-SHA256 (tampil sekali)',
                primaryValue: result.webhookSecret
            });
            showToast(result.message || 'Webhook Secret berhasil diperbarui.');
        } catch (error) {
            showToast(`Error: ${error.message}`);
        } finally {
            if (rotateWebhookSecretBtn) rotateWebhookSecretBtn.disabled = false;
        }
    }

    if (rotateWebhookSecretBtn) {
        rotateWebhookSecretBtn.addEventListener('click', () => {
            if (currentHasWebhookSecret) {
                openH2HConfirmModal({
                    title: 'Putar Webhook Secret?',
                    message: 'Webhook Secret lama akan langsung diganti dengan secret baru. Webhook berikutnya akan ditandatangani menggunakan secret baru ini.',
                    confirmLabel: 'Ya, Putar Secret',
                    danger: true,
                    onConfirm: executeRotateWebhookSecret
                });
                return;
            }
            executeRotateWebhookSecret();
        });
    }

    if (logoutButton) {
        logoutButton.addEventListener('click', (e) => {
            e.preventDefault();
            localStorage.removeItem('authToken');
            window.location.href = 'index.html';
        });
    }

    if (editProfileBtn && editModal && closeEditModalBtn) {
        editProfileBtn.addEventListener('click', () => editModal.classList.remove('hidden'));
        closeEditModalBtn.addEventListener('click', () => editModal.classList.add('hidden'));
    }

    if (tabLinks.length > 0 && tabContents.length > 0) {
        tabLinks.forEach(link => {
            link.addEventListener('click', () => {
                tabLinks.forEach(l => l.classList.remove('active'));
                tabContents.forEach(c => c.classList.add('hidden'));
                link.classList.add('active');
                document.getElementById(link.dataset.tab).classList.remove('hidden');
            });
        });
    }

    if (editProfileForm) {
        editProfileForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                fullName: editProfileForm.querySelector('[name="fullName"]').value,
                email: editProfileForm.querySelector('[name="email"]').value,
                nomorWa: editProfileForm.querySelector('[name="nomorWa"]').value,
            };
            try {
                const response = await fetch(`${API_URL}/profile`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                alert(result.message);
                fetchProfileData();
                if (editModal) editModal.classList.add('hidden');
            } catch (error) {
                alert(`Error: ${error.message}`);
            }
        });
    }

    if (changePasswordForm) {
        changePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPassword = changePasswordForm.querySelector('[name="newPassword"]').value;
            if (newPassword !== changePasswordForm.querySelector('[name="confirmNewPassword"]').value) {
                alert('Password Baru dan Konfirmasi tidak cocok!');
                return;
            }
            const data = {
                currentPassword: changePasswordForm.querySelector('[name="currentPassword"]').value,
                newPassword: newPassword,
            };
            try {
                const response = await fetch(`${API_URL}/password`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                alert(result.message);
                changePasswordForm.reset();
                if (editModal) editModal.classList.add('hidden');
            } catch (error) {
                alert(`Error: ${error.message}`);
            }
        });
    }

    if (whitelistIpForm) {
        whitelistIpForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = document.getElementById('whitelist-ip-input');
            const submitButton = whitelistIpForm.querySelector('button[type="submit"]');

            const existingIpTags = document.querySelectorAll('#current-ips-list .ip-tag span');
            const existingIps = Array.from(existingIpTags).map(tag => tag.textContent);
            const newIpsFromInput = input.value.split(',').map(ip => ip.trim()).filter(Boolean);
            if (newIpsFromInput.length === 0) {
                showToast('Masukkan alamat IP atau rentang CIDR terlebih dahulu.');
                return;
            }
            const combinedIps = [...new Set([...existingIps, ...newIpsFromInput])];

            if (submitButton) submitButton.disabled = true;
            try {
                await saveWhitelistedIps(combinedIps);
                input.value = '';
            } catch (error) {
                showToast(`Error: ${error.message}`);
            } finally {
                if (submitButton) submitButton.disabled = false;
            }
        });
    }

    if (currentIpsList) {
        currentIpsList.addEventListener('click', (e) => {
            if (!e.target.matches('.ip-tag-delete, .ip-tag-delete *')) return;
            const button = e.target.closest('.ip-tag-delete');
            const ipToDelete = button.dataset.ip;

            openH2HConfirmModal({
                title: 'Hapus IP Whitelist?',
                message: `Anda yakin ingin menghapus "${ipToDelete}" dari daftar IP whitelist H2H?`,
                confirmLabel: 'Ya, Hapus IP',
                danger: true,
                onConfirm: async () => {
                    const currentIpTags = document.querySelectorAll('#current-ips-list .ip-tag span');
                    const currentIps = Array.from(currentIpTags).map(tag => tag.textContent);
                    const newIps = currentIps.filter(ip => ip !== ipToDelete);

                    try {
                        await saveWhitelistedIps(newIps);
                    } catch (error) {
                        showToast(`Error: ${error.message}`);
                    }
                }
            });
        });
    }

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
                const response = await fetch(`${API_URL}/transaction/${encodeURIComponent(invoiceId)}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
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

    function renderHasilPencarian(tx) {
        const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(tx.price);
        const formattedDate = new Date(tx.created_at).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });

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

    fetchProfileData();
    fetchTransactionSummary();

    document.querySelectorAll('.toggle-password').forEach(icon => {
        icon.addEventListener('click', function () {
            const input = this.parentElement.querySelector('input');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            this.classList.toggle('fa-eye', !isPassword);
            this.classList.toggle('fa-eye-slash', isPassword);
        });
    });

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
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(number);
            } else {
                // Fallback untuk HTTP / browser lama
                const textarea = document.createElement('textarea');
                textarea.value = number;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
            }
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
});
