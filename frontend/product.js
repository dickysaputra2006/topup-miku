document.addEventListener('DOMContentLoaded', function() {
    // === Bagian 1: Deklarasi Variabel & Elemen ===
    const AUTH_API_URL = 'https://topup-miku.onrender.com/api/auth';
    const PUBLIC_API_URL = 'https://topup-miku.onrender.com/api'; // Pastikan ini juga benar
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
    submitOrderBtn.addEventListener('click', async () => {
        if (!token) {
            alert('Anda harus login untuk melakukan transaksi.');
            showModal();
            return;
        }
        if (!selectedProductId) {
            alert('Silakan pilih nominal top up terlebih dahulu.');
            return;
        }
        
        const targetGameId = targetGameIdInput.value;

        // --- Perubahan 1 ---
        const targetServerIdEl = document.getElementById('target-server-id');
        const targetServerId = targetServerIdEl ? targetServerIdEl.value : null;

        if (!targetGameId) {
            alert('Silakan masukkan User ID Anda terlebih dahulu.');
            return;
        }
        
        // --- Perubahan 2 ---
        if (targetServerIdEl && targetServerIdEl.required && !targetServerId) {
            alert('Silakan masukkan atau pilih Server ID Anda.');
            return;
        }

        // --- Perubahan 3 ---
        const finalTargetId = targetServerId ? `${targetGameId} (${targetServerId})` : targetGameId;
        
        if (confirm(`Anda akan membeli produk ini untuk ID: ${finalTargetId} seharga ${totalPriceEl.textContent}. Lanjutkan?`)) {
            submitOrderBtn.disabled = true;
            submitOrderBtn.textContent = 'Memproses...';
            try {
                const response = await fetch(`${PUBLIC_API_URL}/order`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        productId: selectedProductId,
                        targetGameId: targetGameId,
                        // --- Perubahan 4 ---
                        targetServerId: targetServerId 
                    })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                alert(`Transaksi Berhasil! Invoice ID Anda: ${result.invoiceId}\nSilakan cek riwayat transaksi di dashboard Anda.`);
                window.location.href = 'dashboard.html';
            } catch (error) {
                alert(`Error: ${error.message}`);
                submitOrderBtn.disabled = false;
                submitOrderBtn.textContent = 'Beli Sekarang';
            }
        }
    });
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
});