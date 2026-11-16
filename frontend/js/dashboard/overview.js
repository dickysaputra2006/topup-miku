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
     * Perbarui tampilan ringkasan profil, saldo, badge inisial, dan form edit profil.
     */
    function updateDashboardUI(data) {
        const { formatRupiah } = global.MikuShared.format;
        const { editProfileForm } = app.state.els;

        document.getElementById('profile-fullname').textContent = data.full_name;
        document.getElementById('profile-username').textContent = data.username;
        document.getElementById('profile-email').textContent = data.email;
        document.getElementById('profile-nomorwa').textContent = data.nomor_wa;
        document.getElementById('profile-role').textContent = data.role;
        document.getElementById('profile-balance').textContent = formatRupiah(data.balance);

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

    /**
     * Muat data profil akun user yang sedang login.
     */
    async function fetchProfileData() {
        const { forceLogout } = global.MikuShared.auth;
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.API_URL}/profile`, { auth: true, token: app.state.token });

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

    /**
     * Muat ringkasan jumlah transaksi berhasil, pending, gagal, dan review.
     */
    async function fetchTransactionSummary() {
        const { apiFetch } = global.MikuShared.api;
        try {
            const response = await apiFetch(`${app.API_URL}/transaction-summary`, { auth: true, token: app.state.token });
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

    app.overview = {
        getInitials,
        updateDashboardUI,
        fetchProfileData,
        fetchTransactionSummary,
    };
})(window);
