document.addEventListener('DOMContentLoaded', function() {
    // --- KODE UNTUK MENU HAMBURGER DI DASHBOARD ---
    const sidebar = document.querySelector('.sidebar');
    document.querySelectorAll('#menu-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebar.classList.toggle('active');
        document.body.classList.toggle('menu-open');
    });
});

document.addEventListener('click', function (event) {
        if (sidebar && sidebar.classList.contains('active')) {
            if (!sidebar.contains(event.target) && !event.target.closest('#menu-toggle-btn')) {
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
    const apiKeyDisplay = document.getElementById('api-key-display');
    const cekPesananForm = document.getElementById('cek-pesanan-form');
    const hasilCekPesanan = document.getElementById('hasil-cek-pesanan');
    const whitelistIpForm = document.getElementById('whitelist-ip-form');
    const currentIpsList = document.getElementById('current-ips-list');
    
    let apiKeyFetched = false;
    let mutasiLoaded = false;
    let transaksiLoaded = false;
    let depositFormSetup = false;



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
    } catch (error) {
        console.error('Gagal memuat ringkasan transaksi:', error);
    }
}

            // Fungsi dari transaksi.js
        async function fetchTransactions() {
            const tableBody = document.querySelector("#transactions-table tbody");
            if (!tableBody) return;
            tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center;">Memuat riwayat...</td></tr>`;
            try {
                const response = await fetch(`${API_URL}/transactions`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!response.ok) throw new Error('Gagal mengambil data transaksi.');
                const transactions = await response.json();
                renderTransactionsTable(transactions, tableBody);
                transaksiLoaded = true;
            } catch (error) {
                tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: red;">${error.message}</td></tr>`;
            }
        }

        // Fungsi dari transaksi.js
        function renderTransactionsTable(transactions, tableBody) {
            if (!tableBody) return;
            tableBody.innerHTML = '';
            if (transactions.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Anda belum memiliki riwayat transaksi.</td></tr>';
                return;
            }
            transactions.forEach(tx => {
                const row = document.createElement('tr');
                const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(tx.price);
                const statusClass = `status-${tx.status.toLowerCase()}`;
                row.innerHTML = `
                    <td><a href="invoice.html?id=${tx.invoice_id}" class="history-link">${tx.invoice_id}</a></td>
                    <td>${new Date(tx.created_at).toLocaleString('id-ID')}</td>
                    <td>${tx.product_name}</td>
                    <td>${tx.target_game_id}</td>
                    <td>${formattedPrice}</td>
                    <td><span class="status-badge ${statusClass}">${tx.status}</span></td>
                `;
                tableBody.appendChild(row);
            });
        }

        // Fungsi dari deposit.js
        function setupDepositForm() {
            const depositForm = document.getElementById('deposit-form');
            const paymentInstructionsSection = document.getElementById('payment-instructions');
            const instructionText = document.getElementById('instruction-text');
            if (!depositForm) return;

            depositForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                const amount = this.querySelector('input[name="amount"]').value;
                paymentInstructionsSection.classList.remove('hidden');
                instructionText.innerHTML = 'Memproses permintaan Anda...';
                try {
                    const response = await fetch('/api/deposit/request', { // Langsung ke endpoint
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ amount: parseInt(amount) })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    instructionText.innerHTML = result.deposit.paymentInstructions;
                    depositForm.reset();
                } catch (error) {
                    instructionText.innerHTML = `<strong>Error:</strong> ${error.message}`;
                }
            });
            depositFormSetup = true;
        }

    function updateDashboardUI(data) {
        document.getElementById('profile-fullname').textContent = data.full_name;
        document.getElementById('profile-username').textContent = data.username;
        document.getElementById('profile-email').textContent = data.email;
        document.getElementById('profile-nomorwa').textContent = data.nomor_wa;
        document.getElementById('profile-role').textContent = data.role;
        document.getElementById('profile-balance').textContent = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(data.balance);
        
        if (editProfileForm) {
            editProfileForm.querySelector('[name="fullName"]').value = data.full_name;
            editProfileForm.querySelector('[name="email"]').value = data.email;
            editProfileForm.querySelector('[name="nomorWa"]').value = data.nomor_wa;
        }
    }

    async function fetchApiKey() {
    if (!apiKeyDisplay) return;
    
    // Deklarasi elemen baru
    const toggleBtn = document.getElementById('toggle-apikey-btn');
    const copyBtn = document.getElementById('copy-apikey-btn');
    let fullApiKey = '';
    let isKeyVisible = false;

    apiKeyDisplay.textContent = 'Memuat...';

    // Fungsi untuk update tampilan key (bintang-bintang atau teks asli)
    function updateKeyVisibility() {
        if (isKeyVisible) {
            apiKeyDisplay.textContent = fullApiKey;
            toggleBtn.innerHTML = '<i class="fas fa-eye-slash"></i>';
        } else {
            apiKeyDisplay.textContent = '•'.repeat(fullApiKey.length > 0 ? 32 : 0);
            toggleBtn.innerHTML = '<i class="fas fa-eye"></i>';
        }
    }

    try {
        const response = await fetch(`${API_URL}/apikey`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) throw new Error('Gagal mengambil API Key.');
        const data = await response.json();
        
        fullApiKey = data.apiKey || 'Belum ada. Klik tombol untuk membuat.';
        apiKeyFetched = true;
        updateKeyVisibility(); // Tampilkan key dalam bentuk tersembunyi

    } catch (error) {
        console.error(error);
        apiKeyDisplay.textContent = 'Gagal memuat API Key.';
    }

    // Event listener untuk tombol hide/view
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            isKeyVisible = !isKeyVisible;
            updateKeyVisibility();
        });
    }

    // Event listener untuk tombol copy
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            if (fullApiKey && !fullApiKey.startsWith('Belum ada')) {
                navigator.clipboard.writeText(fullApiKey).then(() => {
                    copyBtn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => {
                        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
                    }, 2000);
                });
            }
        });
    }
    }

    async function fetchBalanceHistory() {
    const tableBody = document.querySelector("#mutasi-table tbody");
    if (!tableBody) return;
    tableBody.innerHTML = `<tr><td colspan="4" style="text-align: center;">Memuat riwayat...</td></tr>`;
    try {
        const response = await fetch(`${API_URL}/balance-history`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) throw new Error('Gagal mengambil data mutasi.');
        const history = await response.json();
        renderMutasiTable(history, tableBody);
        mutasiLoaded = true;
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: red;">${error.message}</td></tr>`;
    }
    }

    function renderMutasiTable(history, tableBody) {
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (history.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Belum ada riwayat mutasi.</td></tr>';
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
        const response = await fetch(`${API_URL}/whitelisted-ips`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!response.ok) throw new Error('Gagal memuat IP.');
        const ips = await response.json();

        ipInput.value = ips.join(', ');
        ipListContainer.innerHTML = '';
        if (ips.length > 0) {
            ips.forEach(ip => {
                const ipTag = document.createElement('div');
                ipTag.className = 'ip-tag';
                ipTag.innerHTML = `
                    <span>${ip}</span>
                    <button class="ip-tag-delete" data-ip="${ip}" title="Hapus IP">&times;</button>
                `;
                ipListContainer.appendChild(ipTag);
            });
        } else {
            ipListContainer.innerHTML = '<p style="color: #aaa;">Belum ada IP yang didaftarkan.</p>';
        }
    } catch (error) {
        console.error(error);
        ipListContainer.innerHTML = `<p style="color:red;">${error.message}</p>`;
    }
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
                link.classList.add('active');

                dashboardSections.forEach(section => {
                    if (section) {
                       section.classList.toggle('hidden', section.id !== targetId);
                    }
                });

                if (targetId === 'integrasi' && !apiKeyFetched) {
                    fetchApiKey();
                    fetchAndDisplayWhitelistedIPs();
                }  

                if (targetId === 'mutasi-saldo' && !mutasiLoaded) {
                    fetchBalanceHistory();
                }

                if (targetId === 'transaksi-tab' && !transaksiLoaded) {
                    fetchTransactions();
                }
                if (targetId === 'deposit-tab' && !depositFormSetup) {
                    setupDepositForm();
                }

            });
        });
    }

    if (generateApiKeyBtn) {
        generateApiKeyBtn.addEventListener('click', async () => {
            if (confirm('Anda yakin ingin membuat API Key baru? Key yang lama akan diganti dan tidak bisa digunakan lagi.')) {
                try {
                    const response = await fetch(`${API_URL}/generate-apikey`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    alert(result.message);
                    apiKeyDisplay.textContent = result.apiKey;
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            }
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
            // Ubah string menjadi array, bersihkan spasi, dan buang entri kosong
            const ips = input.value.split(',').map(ip => ip.trim()).filter(ip => ip);

            try {
                const response = await fetch(`${API_URL}/whitelisted-ips`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ips: ips })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);

                alert(result.message);
                fetchAndDisplayWhitelistedIPs(); // Muat ulang daftar IP
            } catch (error) {
                alert(`Error: ${error.message}`);
            }
        });
    }

    if (currentIpsList) {
        currentIpsList.addEventListener('click', async (e) => {
            if (e.target.classList.contains('ip-tag-delete')) {
                const ipToDelete = e.target.dataset.ip;
                if (!confirm(`Anda yakin ingin menghapus IP "${ipToDelete}" dari whitelist?`)) {
                    return;
                }

                const input = document.getElementById('whitelist-ip-input');
                const currentIps = input.value.split(',').map(ip => ip.trim()).filter(ip => ip);
                const newIps = currentIps.filter(ip => ip !== ipToDelete);

                try {
                    const response = await fetch(`${API_URL}/whitelisted-ips`, {
                        method: 'PUT',
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ips: newIps })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);

                    alert(result.message);
                    fetchAndDisplayWhitelistedIPs(); // Muat ulang daftar IP
                } catch (error) {
                    alert(`Error: ${error.message}`);
                }
            }
        });
    }

    if (cekPesananForm) {
        cekPesananForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const invoiceInput = document.getElementById('invoice-search-input');
            const invoiceId = invoiceInput.value.trim();
            const submitButton = cekPesananForm.querySelector('button');

            if (!invoiceId) return;

            submitButton.disabled = true;
            submitButton.textContent = 'Mencari...';
            hasilCekPesanan.classList.add('hidden'); // Sembunyikan hasil lama

            try {
                // Kita gunakan endpoint yang sudah ada
                const response = await fetch(`${API_URL}/transaction/${invoiceId}`, {
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
                hasilCekPesanan.innerHTML = `<p style="color: var(--danger-color); text-align: center;">${error.message}</p>`;
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Cari Transaksi';
            }
        });
    }

    function renderHasilPencarian(tx) {
        const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(tx.price);
        const formattedDate = new Date(tx.created_at).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
        const statusClass = `status-${tx.status.toLowerCase()}`;

        hasilCekPesanan.innerHTML = `
            <h4>Detail Transaksi</h4>
            <div class="profile-details">
                <div>
                    <p>No. Invoice: <strong>${tx.invoice_id}</strong></p>
                    <p>Tanggal: <strong>${formattedDate}</strong></p>
                    <p>Produk: <strong>${tx.product_name} (${tx.game_name})</strong></p>
                    <p>ID Tujuan: <strong>${tx.target_game_id.replace('|', ' ')}</strong></p>
                    <p>Total Bayar: <strong>${formattedPrice}</strong></p>
                    <p>Status: <strong><span class="status-badge ${statusClass}">${tx.status}</span></strong></p>
                </div>
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
});