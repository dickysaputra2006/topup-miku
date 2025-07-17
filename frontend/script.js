document.addEventListener('DOMContentLoaded', function () {
    // === 1. DEKLARASI KONSTANTA & ELEMEN ===
    const API_URL_AUTH = 'https://topup-miku.onrender.com/api/auth';
    const API_URL = 'https://topup-miku.onrender.com/api';

    // Elemen Header & Dropdown Baru
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const dropdownMenu = document.getElementById('dropdown-menu');
    const navLoginBtn = document.getElementById('nav-login-btn');
    const navDashboardBtn = document.getElementById('nav-dashboard-btn');

    // Elemen Modal Login/Register
    const modal = document.getElementById('auth-modal');
    const closeModalButton = document.getElementById('close-modal-btn');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    // === 2. DEFINISI SEMUA FUNGSI ===

    function showModal() { if (modal) modal.classList.remove('hidden'); }
    function hideModal() { if (modal) modal.classList.add('hidden'); }

    function updateMainNavButtons() {
        const token = localStorage.getItem('authToken');
        if (token) {
            if(navLoginBtn) navLoginBtn.classList.add('hidden');
            if(navDashboardBtn) navDashboardBtn.classList.remove('hidden');
        } else {
            if(navLoginBtn) navLoginBtn.classList.remove('hidden');
            if(navDashboardBtn) navDashboardBtn.classList.add('hidden');
        }
    }

    function renderGameGrid(games, containerId) {
        const gridContainer = document.getElementById(containerId);
        if (!gridContainer) return;
        gridContainer.innerHTML = '';
        if (games.length === 0) {
            const section = gridContainer.closest('.content-section');
            if (section) section.classList.add('hidden');
            return;
        }
        games.forEach(game => {
            const card = document.createElement('a');
            card.href = `product.html?gameId=${game.id}`;
            card.className = 'product-card';
            card.innerHTML = `
                <img src="${game.image_url || './path/to/default/image.png'}" alt="${game.name}">
                <span>${game.name}</span>
            `;
            gridContainer.appendChild(card);
        });
    }

    async function displayGames() {
        try {
            const response = await fetch(`${API_URL}/games`);
            if (!response.ok) throw new Error('Gagal mengambil data game');
            const allGames = await response.json();
            const mobileGames = [], pcGames = [], voucherGames = [];

            allGames.forEach(game => {
                switch (game.category) {
                    case 'Mobile Game':
                    case 'Special MLBB':
                        mobileGames.push(game);
                        break;
                    case 'PC Game':
                        pcGames.push(game);
                        break;
                    case 'Voucher':
                    case 'Life style':
                        voucherGames.push(game);
                        break;
                }
            });
            renderGameGrid(mobileGames, 'mobile-games-grid');
            renderGameGrid(pcGames, 'pc-games-grid');
            renderGameGrid(voucherGames, 'voucher-grid');
        } catch (error) {
            console.error('Gagal menampilkan game:', error);
            const mobileGrid = document.getElementById('mobile-games-grid');
            if(mobileGrid) mobileGrid.innerHTML = '<p>Gagal memuat game. Coba lagi nanti.</p>';
        }
    }

    // === 3. SEMUA EVENT LISTENER ===

    if (hamburgerBtn && dropdownMenu) {
        hamburgerBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            dropdownMenu.classList.toggle('hidden');
        });
    }
    window.addEventListener('click', () => {
        if (dropdownMenu && !dropdownMenu.classList.contains('hidden')) {
            dropdownMenu.classList.add('hidden');
        }
    });
    
    if (navLoginBtn) {
        navLoginBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showModal();
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
                showLoginLink.click();
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
                window.location.href = 'dashboard.html';
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

    // === 4. PANGGILAN FUNGSI AWAL ===
    updateMainNavButtons();
    displayGames();
});