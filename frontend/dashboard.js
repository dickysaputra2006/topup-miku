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
    
    let apiKeyFetched = false;
    let mutasiLoaded = false;
    let transaksiLoaded = false;
    let depositFormSetup = false;

    async function fetchProfileData() {
        try {
            const response = await fetch(`${API_URL}/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) throw new Error('Sesi habis, silakan login kembali.');
            const data = await response.json();
            updateDashboardUI(data);
        } catch (error) {
            localStorage.removeItem('authToken');
            window.location.href = 'index.html';
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
        apiKeyDisplay.textContent = 'Memuat...';
        try {
            const response = await fetch(`${API_URL}/apikey`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!response.ok) throw new Error('Gagal mengambil API Key.');
            const data = await response.json();
            
            apiKeyDisplay.textContent = data.apiKey ? data.apiKey : 'Belum ada. Klik tombol untuk membuat.';
            apiKeyFetched = true;
        } catch (error) {
            console.error(error);
            apiKeyDisplay.textContent = 'Gagal memuat API Key.';
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