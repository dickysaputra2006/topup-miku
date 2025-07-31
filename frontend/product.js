document.addEventListener('DOMContentLoaded', function() {
    // === Bagian 1: Deklarasi Variabel & Elemen ===
    const AUTH_API_URL = '/api/auth';
    const PUBLIC_API_URL = '/api';
    const params = new URLSearchParams(window.location.search);
    const gameId = params.get('gameId');
    const token = localStorage.getItem('authToken');
    const validationResultEl = document.getElementById('validation-result');

    if (!gameId) {
        document.querySelector('main').innerHTML = '<h1 style="text-align:center;">Game tidak ditemukan. Silakan kembali ke halaman utama.</h1>';
        return;
    }

    // Elemen Halaman Produk
    const gameImageEl = document.getElementById('game-image');
    const gameNameEl = document.getElementById('game-name');
    const productListContainer = document.getElementById('product-list-container');
    const orderForm = document.getElementById('order-form');
    const totalPriceEl = document.getElementById('total-price');
    const submitOrderBtn = document.getElementById('submit-order-btn');
    const targetGameIdInput = document.getElementById('target-game-id'); 
    const serverInputContainer = document.getElementById('server-input-container'); 
    const userAuthButton = document.getElementById('user-auth-button');

    // Elemen Header & Modal Login
    const modal = document.getElementById('auth-modal');
    const closeModalButton = document.getElementById('close-modal-btn');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    let selectedProductId = null;

    // === Bagian 2: Definisi Semua Fungsi ===

    function showModal() { if (modal) modal.classList.remove('hidden'); }
    function hideModal() { if (modal) modal.classList.add('hidden'); }

    async function updateAuthButtonOnProductPage() {
    if (!userAuthButton) return;

    // Cek jika pengguna sudah login (ada token)
    if (token) {
        try {
            // Ambil data profil pengguna dari server
            const response = await fetch(`${PUBLIC_API_URL}/user/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) throw new Error('Sesi tidak valid.');

            const user = await response.json();

            // Ubah tombol menjadi nama pengguna dan arahkan ke dashboard
            userAuthButton.innerHTML = `<i class="fas fa-user-circle"></i> ${user.username}`;
            userAuthButton.href = 'dashboard.html';
            userAuthButton.onclick = null; // Hapus fungsi klik lama

        } catch (error) {
            // Jika token tidak valid/error, kembali ke 상태 "Masuk"
            localStorage.removeItem('authToken');
            userAuthButton.textContent = 'Masuk';
            userAuthButton.href = '#';
            userAuthButton.onclick = (e) => {
                e.preventDefault();
                showModal();
            };
        }
    } else {
        // Jika tidak ada token (belum login)
        userAuthButton.textContent = 'Masuk';
        userAuthButton.href = '#';
        userAuthButton.onclick = (e) => {
            e.preventDefault();
            showModal(); // Panggil fungsi untuk menampilkan modal login
        };
    }
}

    async function fetchGameData() {
    try {
        const headers = {};
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const response = await fetch(`${PUBLIC_API_URL}/games/${gameId}/products`, { headers });
        if (!response.ok) throw new Error('Gagal memuat data produk game.');
        const data = await response.json();

        gameImageEl.src = data.game.image_url;
        gameNameEl.textContent = data.game.name;

        if (data.game.target_id_label) {
    targetGameIdInput.placeholder = data.game.target_id_label;
            }

        
        serverInputContainer.innerHTML = ''; 

        if (data.game.needs_server_id) {
            // Panggil API untuk cek apakah ada daftar server tetap
            const serverListResponse = await fetch(`${PUBLIC_API_URL}/games/${gameId}/servers`);
            const serverList = await serverListResponse.json();

            if (serverList.length > 0) {
                // Jika ada daftar server, buat dropdown
                let optionsHtml = serverList.map(server => `<option value="${server}">${server}</option>`).join('');
                serverInputContainer.innerHTML = `
                    <select id="target-server-id" required>
                        <option value="" disabled selected>-- Pilih Server --</option>
                        ${optionsHtml}
                    </select>
                `;
            } else {
                // Jika tidak ada, buat input teks biasa
                serverInputContainer.innerHTML = `<input type="text" id="target-server-id" placeholder="Masukkan Server ID" required>`;
            }
        }
       

        renderProducts(data.products);
    } catch (error) {
        console.error('Error fetching game data:', error);
        productListContainer.innerHTML = `<p style="color:red;">${error.message}</p>`;
    }
}

    function renderProducts(products) {
        productListContainer.innerHTML = '';
        if (products.length === 0) {
            productListContainer.innerHTML = '<p>Saat ini belum ada produk untuk game ini.</p>';
            return;
        }
        products.forEach(product => {
            const card = document.createElement('div');
            card.className = 'product-card-selectable';
            card.dataset.productId = product.id;
            card.dataset.price = product.price;
            card.innerHTML = `
                <span>${product.name}</span>
                <small>${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(product.price)}</small>
            `;
            card.addEventListener('click', () => handleProductSelection(card, product.id, product.price));
            productListContainer.appendChild(card);
        });
    }

    function handleProductSelection(selectedCard, productId, productPrice) {
        document.querySelectorAll('.product-card-selectable').forEach(card => card.classList.remove('selected'));
        selectedCard.classList.add('selected');
        selectedProductId = productId;
        totalPriceEl.textContent = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(productPrice);
        submitOrderBtn.disabled = false;
        submitOrderBtn.textContent = 'Beli Sekarang';
    }

     async function setupLiveValidation() {
    const targetIdInput = document.getElementById('target-game-id');
    const serverIdInputContainer = document.getElementById('server-input-container');
    const resultContainer = document.getElementById('validation-result');
    const productListContainer = document.getElementById('product-list-container');
    
    // Pindahkan selectedProductId ke dalam scope fungsi ini agar tidak bentrok
    let currentSelectedProductId = null;
    let isValidationSuccess = false;

    // Fungsi inti yang akan menjalankan validasi
   const handleValidation = async () => {
        isValidationSuccess = false; // Reset status setiap kali validasi baru dimulai
        if (!currentSelectedProductId || !targetIdInput.value) {
            resultContainer.innerHTML = '';
            return;
        }

        const userId = targetIdInput.value;
        const serverIdInput = document.getElementById('target-server-id');
        const zoneId = serverIdInput ? serverIdInput.value : null;

        resultContainer.innerHTML = `<p style="color: #ccc;">Mengecek nickname...</p>`;

        try {
            const response = await fetch(`${PUBLIC_API_URL}/products/${currentSelectedProductId}/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, zoneId })
            });

            const result = await response.json();

            // Tampilan jika produk tidak memerlukan validasi
            if (result.message && result.message.includes('tidak memerlukan validasi')) {
                resultContainer.innerHTML = `<div class="validation-result-inline success">
                    <i class="fas fa-check-circle"></i> ${result.message}
                </div>`;
                return;
            }

            // Tampilan jika validasi gagal
            if (!response.ok) {
                resultContainer.innerHTML = `<div class="validation-result-inline error">
                    <i class="fas fa-times-circle"></i> ${result.message}
                </div>`;
                return;
            }

            // Tampilan jika validasi sukses
            let message = `<div class="validation-result-inline success">
                            <i class="fas fa-check-circle"></i> 
                            Nickname: <strong>${result.data.username}</strong>`;
            if (result.data.region) {
                message += ` (Region: ${result.data.region})`;
            }

            if (!response.ok) {
             isValidationSuccess = false; // <--- TAMBAHKAN INI
             resultContainer.innerHTML = `<div class="validation-result error">...</div>`;
             return;
        }

            message += `</div>`;
            resultContainer.innerHTML = message;
            isValidationSuccess = true;

        } catch (error) {
            resultContainer.innerHTML = `<div class="validation-result-inline error">
                <i class="fas fa-times-circle"></i> ${error.message}
            </div>`;
        }
    };

    // Saat pengguna memilih kartu produk
    if (productListContainer) {
        productListContainer.addEventListener('click', (e) => {
            const card = e.target.closest('.product-card-selectable');
            if (card && card.dataset.productId) {
                currentSelectedProductId = card.dataset.productId;
                handleValidation();
            }
        });
    }

    // Saat pengguna selesai mengetik di kolom ID atau Zone ID
    if (targetIdInput) {
        targetIdInput.addEventListener('blur', handleValidation);
    }
    
    if (serverIdInputContainer) {
        const observer = new MutationObserver(() => {
            const serverIdInput = document.getElementById('target-server-id');
            if (serverIdInput) {
                serverIdInput.addEventListener('blur', handleValidation);
                observer.disconnect();
            }
        });
        observer.observe(serverIdInputContainer, { childList: true, subtree: true });
    }
}
    // === Bagian 3: Menambahkan Semua Event Listeners ===

    if (closeModalButton) closeModalButton.addEventListener('click', hideModal);

    if (showRegisterLink) {
        showRegisterLink.addEventListener('click', (e) => {
            e.preventDefault();
            if(loginContainer && registerContainer) {
                loginContainer.classList.add('hidden');
                registerContainer.classList.remove('hidden');
            }
        });
    }
    if (showLoginLink) {
        showLoginLink.addEventListener('click', (e) => {
            e.preventDefault();
            if(loginContainer && registerContainer) {
                registerContainer.classList.add('hidden');
                loginContainer.classList.remove('hidden');
            }
        });
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                username: loginForm.querySelector('input[name="username"]').value,
                password: loginForm.querySelector('input[name="password"]').value
            };
            try {
                // Menggunakan AUTH_API_URL untuk login
                const response = await fetch(`${AUTH_API_URL}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                localStorage.setItem('authToken', result.token);
                alert(result.message);
                window.location.reload();
            } catch (error) {
                alert(`Error Login: ${error.message}`);
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const passwordInput = registerForm.querySelector('input[name="password"]');
            const confirmPasswordInput = registerForm.querySelector('input[name="confirmPassword"]');
            if (passwordInput.value !== confirmPasswordInput.value) {
                alert('Password dan Konfirmasi Password tidak cocok!');
                confirmPasswordInput.value = '';
                confirmPasswordInput.focus();
                return;
            }
            const data = {
                fullName: registerForm.querySelector('input[name="fullName"]').value,
                username: registerForm.querySelector('input[name="username"]').value,
                email: registerForm.querySelector('input[name="email"]').value,
                nomorWa: registerForm.querySelector('input[name="nomorWa"]').value,
                password: passwordInput.value
            };
            try {
                // Menggunakan AUTH_API_URL untuk register
                const response = await fetch(`${AUTH_API_URL}/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                alert(result.message);
                registerForm.reset();
                if(showLoginLink) showLoginLink.click();
            } catch (error) {
                alert(`Error Registrasi: ${error.message}`);
            }
        });
    }

    if (submitOrderBtn) {
    // Deklarasikan elemen modal di luar event listener
    const confirmModal = document.getElementById('order-confirmation-modal');
    const closeConfirmBtn = document.getElementById('close-confirm-modal-btn');
    const cancelBtn = document.getElementById('cancel-order-btn');
    const confirmBtn = document.getElementById('confirm-order-btn');

    // Event listener untuk tombol "Beli Sekarang" utama
    submitOrderBtn.addEventListener('click', () => {
        // Cek dulu status validasi sebelum melanjutkan
        // 'isValidationSuccess' didapatkan dari fungsi setupLiveValidation
        if (!isValidationSuccess) {
            alert('Validasi ID gagal atau region tidak sesuai. Harap periksa kembali User ID Anda atau pilih produk lain yang sesuai.');
            return; // Hentikan proses jika validasi tidak sukses
        }

        if (!token) {
            alert('Anda harus login untuk melakukan transaksi.');
            showModal();
            return;
        }
        if (!selectedProductId) {
            alert('Silakan pilih nominal top up terlebih dahulu.');
            return;
        }
        
        const targetGameId = document.getElementById('target-game-id').value;
        const targetServerIdEl = document.getElementById('target-server-id');
        const targetServerId = targetServerIdEl ? targetServerIdEl.value : null;

        if (!targetGameId || (targetServerIdEl && targetServerIdEl.required && !targetServerId)) {
            alert('Silakan lengkapi User ID dan Server ID Anda.');
            return;
        }

        // Ambil data dari halaman untuk ditampilkan di modal
        const nickname = document.querySelector('#validation-result strong')?.textContent || 'Belum divalidasi';
        const gameCategory = gameNameEl.textContent;
        const selectedProductCard = document.querySelector('.product-card-selectable.selected');
        const productName = selectedProductCard ? selectedProductCard.querySelector('span').textContent : 'Tidak dipilih';
        const productPrice = selectedProductCard ? selectedProductCard.querySelector('small').textContent : '-';

        // Isi modal dengan data yang relevan
        document.getElementById('confirm-ign').textContent = nickname;
        document.getElementById('confirm-userid').textContent = targetGameId;
        document.getElementById('confirm-serverid').textContent = targetServerId || '-';
        document.getElementById('confirm-kategori').textContent = gameCategory;
        document.getElementById('confirm-produk').textContent = productName;
        document.getElementById('confirm-harga').textContent = productPrice;
        document.getElementById('confirm-total').textContent = totalPriceEl.textContent;

        // Tampilkan modal konfirmasi
        if (confirmModal) confirmModal.classList.remove('hidden');
    });

    // Fungsi untuk menyembunyikan modal
    const hideConfirmModal = () => {
        if (confirmModal) confirmModal.classList.add('hidden');
    };

    // Tambahkan event listener untuk tombol-tombol di dalam modal
    if (closeConfirmBtn) closeConfirmBtn.addEventListener('click', hideConfirmModal);
    if (cancelBtn) cancelBtn.addEventListener('click', hideConfirmModal);

    // Event listener untuk tombol "Bayar Sekarang" di DALAM MODAL
    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = 'Memproses...';

            const targetGameId = document.getElementById('target-game-id').value;
            const targetServerIdEl = document.getElementById('target-server-id');
            const targetServerId = targetServerIdEl ? targetServerIdEl.value : null;

            try {
                const response = await fetch(`${PUBLIC_API_URL}/order`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        productId: selectedProductId,
                        targetGameId: targetGameId,
                        targetServerId: targetServerId 
                    })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                
                hideConfirmModal();
                alert(`Transaksi Berhasil! Invoice ID Anda: ${result.invoiceId}\nAnda akan diarahkan ke halaman dashboard.`);
                window.location.href = 'dashboard.html';

            } catch (error) {
                alert(`Error: ${error.message}`);
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = 'Bayar Sekarang <i class="fas fa-arrow-right"></i>';
            }
        });
    }
}

    document.querySelectorAll('.toggle-password').forEach(icon => {
        icon.addEventListener('click', function() {
            const input = this.parentElement.querySelector('input');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            this.classList.toggle('fa-eye', !isPassword);
            this.classList.toggle('fa-eye-slash', isPassword);
        });
    });

    // === Bagian 4: Menjalankan Fungsi Awal ===
    fetchGameData();
    updateAuthButtonOnProductPage();
    setupLiveValidation();
});