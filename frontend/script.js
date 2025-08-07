document.addEventListener('DOMContentLoaded', function () {
    const logoutMessage = sessionStorage.getItem('logoutMessage');
    if (logoutMessage) {
        // Kita gunakan alert() sederhana di sini, atau Anda bisa buat toast juga
        alert(logoutMessage);
        sessionStorage.removeItem('logoutMessage'); // Hapus pesan agar tidak muncul lagi
    }
    // === 1. DEKLARASI KONSTANTA & ELEMEN ===
    const API_URL_AUTH = '/api/auth';
    const API_URL = '/api';
    const PUBLIC_API_URL = '/api';
    const token = localStorage.getItem('authToken');

    // Elemen Header & Dropdown
    const header = document.querySelector('header');
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const dropdownMenu = document.getElementById('dropdown-menu');
    const userAuthButton = document.getElementById('user-auth-button');
    const headerRight = document.querySelector('.header-right');

    // Elemen Modal Login/Register
    const modal = document.getElementById('auth-modal');
    const closeModalButton = document.getElementById('close-modal-btn');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const dropdownLoginBtn = document.getElementById('dropdown-login-btn');

    // Elemen Search
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    
    const notificationContainer = document.getElementById('notification-container');
    const notificationBadge = document.getElementById('notification-badge');
    const notificationPanel = document.getElementById('notification-panel');
    const notificationList = document.getElementById('notification-list');

    let allGamesData = [];

    // === 2. DEFINISI SEMUA FUNGSI ===

    function showModal() { if (modal) modal.classList.remove('hidden'); }
    function hideModal() { if (modal) modal.classList.add('hidden'); }

   

    async function updateAuthButton() {
        const userAuthButton = document.getElementById('user-auth-button');
        const dropdownAuthButton = document.getElementById('dropdown-auth-btn'); 
        

        if (!userAuthButton || !dropdownAuthButton) return; // Pastikan kedua tombol ada

        if (token) {
            try {
                const response = await fetch(`${API_URL}/user/profile`, { headers: { 'Authorization': `Bearer ${token}` } });
                if (!response.ok) throw new Error('Sesi tidak valid.');
                const user = await response.json();

                // --- UPDATE KEDUA TOMBOL SAAT LOGIN ---
                const loggedInHtml = `<i class="fas fa-user-circle"></i> ${user.username}`;
                userAuthButton.innerHTML = loggedInHtml;
                userAuthButton.href = 'dashboard.html';
                userAuthButton.onclick = null;

                dropdownAuthButton.textContent = 'Keluar'; // Ubah teks menjadi "Keluar"
                dropdownAuthButton.href = '#';
                dropdownAuthButton.onclick = (e) => { // Tambahkan fungsi logout
                    e.preventDefault();
                    localStorage.removeItem('authToken');
                    window.location.reload();
                };
                // --------------------------------------

            } catch (error) {
                localStorage.removeItem('authToken');
                updateAuthButton(); // Panggil ulang fungsi untuk reset
            }
        } else {
            // --- UPDATE KEDUA TOMBOL SAAT LOGOUT ---
            userAuthButton.textContent = 'Masuk';
            userAuthButton.href = '#';
            userAuthButton.onclick = (e) => {
                e.preventDefault();
                showModal();
            };

            dropdownAuthButton.textContent = 'Masuk'; // Kembalikan teks menjadi "Masuk"
            dropdownAuthButton.href = '#';
            dropdownAuthButton.onclick = (e) => { // Kembalikan fungsi untuk buka modal
                e.preventDefault();
                showModal();
            };
            
        }
    }

    function renderGameGrid(games, containerId) {
        const gridContainer = document.getElementById(containerId);
        if (!gridContainer) return;
        gridContainer.innerHTML = '';
        const parentSection = gridContainer.closest('.content-section');
        if (games.length === 0) {
            if (parentSection) parentSection.classList.add('hidden');
        } else {
            if (parentSection) parentSection.classList.remove('hidden');
        }
        games.forEach(game => {
            const card = document.createElement('a');
            card.href = `product.html?gameId=${game.id}`;
            card.className = 'product-card';
            card.innerHTML = `<img src="${game.image_url || 'https://via.placeholder.com/150'}" alt="${game.name}"><span>${game.name}</span>`;
            gridContainer.appendChild(card);
        });
    }

    async function displayGames() {
        try {
            const response = await fetch(`${API_URL}/games`);
            if (!response.ok) throw new Error('Gagal mengambil data game');
            allGamesData = await response.json();
            const mobileGames = allGamesData.filter(g => g.category === 'Mobile Game' || g.category === 'Special MLBB');
            const pcGames = allGamesData.filter(g => g.category === 'PC Game');
            const voucherGames = allGamesData.filter(g => g.category === 'Voucher' || g.category === 'Life Style');
            renderGameGrid(mobileGames, 'mobile-games-grid');
            renderGameGrid(pcGames, 'pc-games-grid');
            renderGameGrid(voucherGames, 'voucher-grid');
        } catch (error) {
            console.error('Gagal menampilkan game:', error);
            document.getElementById('mobile-games-grid').innerHTML = '<p>Gagal memuat game. Coba lagi nanti.</p>';
        }
    }

    function handleSearch(term) {
        if (!searchResults) return;
        const lowerTerm = term.toLowerCase();
        
        if (lowerTerm.length < 1) {
            searchResults.classList.add('hidden');
            return;
        }
        
        const filtered = allGamesData.filter(game => game.name.toLowerCase().includes(lowerTerm));
        searchResults.innerHTML = '';
        searchResults.classList.remove('hidden');

        if (filtered.length === 0) {
            searchResults.innerHTML = '<p style="padding: 1rem; text-align: center; color: #aaa;">Game tidak ditemukan.</p>';
            return;
        }

        filtered.forEach(game => {
            const item = document.createElement('a');
            item.href = `product.html?gameId=${game.id}`;
            item.className = 'search-result-item';
            item.innerHTML = `<img src="${game.image_url || 'https://via.placeholder.com/40'}" alt="${game.name}"><span>${game.name}</span>`;
            searchResults.appendChild(item);
        });
    }

     async function checkUnreadNotifications() {
        if (!token) return; // Hanya jalankan jika user login
        try {
            const response = await fetch(`${API_URL}/user/notifications/unread-count`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await response.json();
            if (data.count > 0) {
                notificationBadge.textContent = data.count;
                notificationBadge.classList.remove('hidden');
            } else {
                notificationBadge.classList.add('hidden');
            }
        } catch (error) {
            console.error('Gagal mengecek notifikasi:', error);
        }
    }

    async function showNotifications() {
        if (!token) return;
        notificationList.innerHTML = '<p style="text-align: center; padding: 1rem;">Memuat...</p>';
        try {
            const response = await fetch(`${API_URL}/user/notifications`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const notifications = await response.json();
            notificationList.innerHTML = ''; // Kosongkan
            if (notifications.length === 0) {
                notificationList.innerHTML = '<p style="text-align: center; padding: 1rem;">Tidak ada notifikasi.</p>';
            } else {
                notifications.forEach(notif => {
                    const notifLink = document.createElement('a');
                    notifLink.href = notif.link || '#';
                    notifLink.className = 'notification-item';
                    if (!notif.is_read) {
                        notifLink.classList.add('unread');
                    }
                    notifLink.innerHTML = `<p style="margin:0; font-size: 0.9rem;">${notif.message}</p>
                                           <small style="color: #a7a9be;">${new Date(notif.created_at).toLocaleString('id-ID')}</small>`;
                    notificationList.appendChild(notifLink);
                });
            }
            // Tandai sudah dibaca di backend
            await fetch(`${API_URL}/user/notifications/mark-as-read`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            notificationBadge.classList.add('hidden'); // Sembunyikan badge
        } catch (error) {
            notificationList.innerHTML = '<p style="text-align: center; padding: 1rem; color: red;">Gagal memuat.</p>';
        }
    }

    async function displayFlashSales() {
    const flashSaleTrack = document.querySelector('.flash-sale-track');
    if (!flashSaleTrack) return;

    try {
        const response = await fetch(`${PUBLIC_API_URL}/public/flash-sales`);
        const flashSales = await response.json();
        
        flashSaleTrack.innerHTML = ''; // Kosongkan placeholder
        if (flashSales.length === 0) {
            flashSaleTrack.closest('.content-section').classList.add('hidden'); // Sembunyikan section jika tidak ada FS
            return;
        }

        flashSales.forEach(product => {
            const card = document.createElement('div');
            card.className = 'flash-sale-card';
            card.innerHTML = `
                <a href="product.html?gameId=${product.game_id}" style="text-decoration: none; color: inherit;">
                    <img src="${product.game_image_url}" alt="${product.product_name}">
                    <div class="flash-sale-info">
                        <span class="fs-product-name">${product.product_name}</span>
                        <span class="fs-price-discounted">${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product.discount_price)}</span>
                        <span class="fs-price-original">${new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(product.original_price)}</span>
                    </div>
                </a>
            `;
            flashSaleTrack.appendChild(card);
        });
        
        // Duplikasi kartu untuk efek scroll tak terbatas jika item cukup
        if (flashSales.length > 2) {
            flashSales.forEach(product => {
                const card = document.createElement('div');
                card.className = 'flash-sale-card';
                card.innerHTML = `...`; // Salin innerHTML dari atas
                flashSaleTrack.appendChild(card);
            });
        }

    } catch (error) {
        console.error("Gagal memuat flash sale:", error);
    }
}

    if (notificationContainer) {
        notificationContainer.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = notificationPanel.classList.toggle('hidden');
            if (!isHidden) { // Jika panel baru saja ditampilkan
                showNotifications();
            }
        });
    }
    // Sembunyikan panel jika klik di luar
    window.addEventListener('click', (e) => {
        if (notificationPanel && !notificationPanel.classList.contains('hidden') && !notificationContainer.contains(e.target)) {
            notificationPanel.classList.add('hidden');
        }
    });

    // === 3. EVENT LISTENERS & PANGGILAN AWAL ===

    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdownMenu) dropdownMenu.classList.toggle('active');
        });
    }
    
if (dropdownLoginBtn) {
    dropdownLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        showModal(); // Panggil fungsi untuk menampilkan modal login
    });
}

    if (closeModalButton) closeModalButton.addEventListener('click', hideModal);
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); loginContainer.classList.add('hidden'); registerContainer.classList.remove('hidden'); });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); registerContainer.classList.add('hidden'); loginContainer.classList.remove('hidden'); });

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
                const response = await fetch(`${API_URL_AUTH}/register`, {
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

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                username: loginForm.querySelector('input[name="username"]').value,
                password: loginForm.querySelector('input[name="password"]').value
            };
            try {
                const response = await fetch(`${API_URL_AUTH}/login`, {
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

    document.querySelectorAll('.toggle-password').forEach(icon => {
        icon.addEventListener('click', function () {
            const input = this.parentElement.querySelector('input');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            this.classList.toggle('fa-eye', !isPassword);
            this.classList.toggle('fa-eye-slash', isPassword);
        });
    });

    if (searchInput) {
        searchInput.addEventListener('input', () => handleSearch(searchInput.value));
        searchInput.addEventListener('focus', () => handleSearch(searchInput.value));
    }

    if (headerRight) {
        headerRight.addEventListener('click', (e) => {
            if (e.target === headerRight && window.getComputedStyle(headerRight, '::after').getPropertyValue('content') !== 'none') {
                const headerCenter = document.querySelector('.header-center');
                if (headerCenter) {
                    const isDisplayed = window.getComputedStyle(headerCenter).display === 'flex';
                    headerCenter.style.display = isDisplayed ? 'none' : 'flex';
                    if (!isDisplayed) searchInput.focus();
                }
            }
        });
    }
    
    window.addEventListener('click', (e) => {
    if (dropdownMenu && dropdownMenu.classList.contains('active') && !dropdownMenu.contains(e.target) && !hamburgerBtn.contains(e.target)) {
        dropdownMenu.classList.remove('active');
    }
    if (searchResults && !searchResults.classList.contains('hidden') && !searchInput.contains(e.target)) {
        searchResults.classList.add('hidden');
    }
});

    // === 4. PANGGILAN FUNGSI AWAL ===
    updateAuthButton();
    displayGames();
    checkUnreadNotifications();
    displayFlashSales();
});