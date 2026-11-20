(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    /**
     * Hitung dua huruf inisial tampilan dari nama lengkap atau username.
     */
    function getInitials(name, fallback) {
        const cleaned = String(name || fallback || 'MK').trim();
        if (!cleaned) return 'MK';
        const parts = cleaned.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return cleaned.slice(0, 2).toUpperCase();
    }

    /**
     * Masking alamat email agar tidak terekspos utuh secara default (mis. m***@gmail.com).
     */
    function maskEmail(email) {
        const raw = String(email || '').trim();
        const atIdx = raw.indexOf('@');
        if (atIdx <= 0) return raw ? '***' : '-';
        const local = raw.slice(0, atIdx);
        const domain = raw.slice(atIdx);
        return `${local.slice(0, 1)}***${domain}`;
    }

    /**
     * Masking nomor WhatsApp agar digit tengah tersembunyi (mis. +62 8**-***-7964).
     */
    function maskPhone(phone) {
        const raw = String(phone || '').trim();
        if (!raw) return '-';
        const digits = raw.replace(/\D/g, '');
        if (digits.length <= 5) return '***';
        const hasPlus = raw.startsWith('+');
        if (hasPlus && digits.startsWith('62') && digits.length >= 9) {
            const firstAfter = digits.slice(2, 3);
            const last4 = digits.slice(-4);
            return `+62 ${firstAfter}**-***-${last4}`;
        }
        const prefix = raw.slice(0, hasPlus ? 4 : 2);
        return `${prefix}***-${digits.slice(-4)}`;
    }

    function renderMaskedContactFields() {
        const contact = app.state.profileContact || {};
        const emailEl = document.getElementById('profile-email');
        const phoneEl = document.getElementById('profile-nomorwa');
        const emailToggleBtn = document.getElementById('toggle-email-visibility');
        const phoneToggleBtn = document.getElementById('toggle-phone-visibility');

        if (emailEl) {
            emailEl.textContent = contact.showEmail ? (contact.email || '-') : maskEmail(contact.email);
        }
        if (phoneEl) {
            phoneEl.textContent = contact.showPhone ? (contact.phone || '-') : maskPhone(contact.phone);
        }
        if (emailToggleBtn) {
            const shown = Boolean(contact.showEmail);
            emailToggleBtn.textContent = shown ? 'Sembunyikan' : 'Tampilkan';
            emailToggleBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
            emailToggleBtn.setAttribute('aria-label', shown ? 'Sembunyikan email' : 'Tampilkan email');
        }
        if (phoneToggleBtn) {
            const shown = Boolean(contact.showPhone);
            phoneToggleBtn.textContent = shown ? 'Sembunyikan' : 'Tampilkan';
            phoneToggleBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
            phoneToggleBtn.setAttribute('aria-label', shown ? 'Sembunyikan nomor WhatsApp' : 'Tampilkan nomor WhatsApp');
        }
    }

    /**
     * Perbarui tampilan ringkasan profil, saldo, badge inisial, dan form edit profil.
     */
    function updateDashboardUI(data) {
        const { formatRupiah } = global.MikuShared.format;
        const { editProfileForm } = app.state.els;

        document.getElementById('profile-fullname').textContent = data.full_name;
        document.getElementById('profile-username').textContent = data.username;
        document.getElementById('profile-role').textContent = data.role;
        document.getElementById('profile-balance').textContent = formatRupiah(data.balance);

        const greetingEl = document.getElementById('overview-greeting-name');
        if (greetingEl) greetingEl.textContent = data.full_name || data.username || 'Member';

        app.state.profileContact = {
            email: data.email || '',
            phone: data.nomor_wa || '',
            showEmail: Boolean(app.state.profileContact && app.state.profileContact.showEmail),
            showPhone: Boolean(app.state.profileContact && app.state.profileContact.showPhone),
        };
        renderMaskedContactFields();

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
            editProfileForm.querySelector('[name="fullName"]').value = data.full_name || '';
            editProfileForm.querySelector('[name="email"]').value = data.email || '';
            editProfileForm.querySelector('[name="nomorWa"]').value = data.nomor_wa || '';
        }
    }

    /**
     * Muat data profil akun user yang sedang login.
     */
    async function fetchProfileData() {
        const { forceLogout } = global.MikuShared.auth;
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.API_URL}/profile`, { auth: true, token: app.state.token });
            if (response.status === 401) {
                forceLogout('Sesi Anda telah berakhir, silakan login kembali.');
                return;
            }
            if (!response.ok) throw new Error('Gagal memuat data profil.');
            const data = await response.json();
            updateDashboardUI(data);
        } catch (error) {
            console.error('Error fetching profile data:', error);
        }
    }

    /**
     * Muat 5 transaksi terbaru untuk preview utama pada Overview.
     */
    async function fetchRecentTransactions() {
        const { formatRupiah, formatDateId, statusClass, statusLabel } = global.MikuShared.format;
        const { escapeHtml, uiState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const container = document.getElementById('overview-recent-container');
        if (!container) return;

        container.innerHTML = uiState('Memuat transaksi terbaru...', 'loading');
        try {
            const response = await apiFetch(`${app.API_URL}/transactions`, { auth: true, token: app.state.token });
            if (!response.ok) throw new Error('Gagal memuat transaksi terbaru.');
            const transactions = await response.json();
            app.state.cachedTransactions = Array.isArray(transactions) ? transactions : [];

            if (app.state.cachedTransactions.length === 0) {
                container.innerHTML = `
                    <div class="empty-state-box">
                        <p>Belum ada transaksi. Mulai top up pertama Anda untuk mengisi katalog riwayat pesanan.</p>
                        <a href="index.html" class="topup-btn empty-cta-btn">Mulai Top Up</a>
                    </div>
                `;
                return;
            }

            const recent = app.state.cachedTransactions.slice(0, 5);
            const rowsHtml = recent.map(tx => {
                const label = statusLabel(tx.status, 'Perlu Review');
                return `<tr>
                    <td><a href="invoice.html?id=${encodeURIComponent(tx.invoice_id)}" class="history-link dashboard-tx-invoice-link" title="${escapeHtml(tx.invoice_id)}">${escapeHtml(tx.invoice_id)}</a></td>
                    <td>${escapeHtml(formatDateId(tx.created_at))}</td>
                    <td>${escapeHtml(tx.product_name)}</td>
                    <td title="${escapeHtml(tx.target_game_id)}">${escapeHtml(tx.target_game_id)}</td>
                    <td class="tabular-nums">${escapeHtml(formatRupiah(tx.price))}</td>
                    <td><span class="status-badge ${statusClass(tx.status)}">${escapeHtml(label)}</span></td>
                </tr>`;
            }).join('');

            container.innerHTML = `
                <div tabindex="0" role="region" aria-label="Daftar transaksi terbaru" class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Invoice ID</th>
                                <th>Tanggal</th>
                                <th>Produk</th>
                                <th>ID Tujuan</th>
                                <th>Harga</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            `;
        } catch (error) {
            container.innerHTML = uiState(escapeHtml(error.message || 'Gagal memuat transaksi terbaru.'), 'error');
        }
    }

    /**
     * Muat ringkasan jumlah transaksi berhasil, pending, gagal, dan review.
     */
    async function fetchTransactionSummary() {
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.API_URL}/transaction-summary`, { auth: true, token: app.state.token });
            if (!response.ok) return;
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

    app.overview = {
        getInitials,
        maskEmail,
        maskPhone,
        renderMaskedContactFields,
        updateDashboardUI,
        fetchProfileData,
        fetchRecentTransactions,
        fetchTransactionSummary,
    };
})(window);
