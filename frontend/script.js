document.addEventListener('DOMContentLoaded', function () {
    // === 1. DEKLARASI KONSTANTA & ELEMEN ===
    const API_URL_AUTH = 'https://topup-miku.onrender.com/api/auth';
    const API_URL = 'https://topup-miku.onrender.com/api';

    // Elemen Header & Sidebar Baru
    const loginButtonHeader = document.getElementById('login-button'); // Tombol Masuk di header (sebelum ada sidebar)
    const openBtn = document.getElementById('open-sidebar-btn');
    const closeBtn = document.getElementById('close-sidebar-btn');
    const sidebar = document.getElementById('sidebar-nav');
    const overlay = document.getElementById('sidebar-overlay');
    const sidebarLoginBtn = document.getElementById('sidebar-login-btn'); // Tombol di dalam sidebar

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

    const closeSidebar = () => {
        if (sidebar && overlay) {
            sidebar.classList.remove('visible');
            overlay.classList.add('hidden');
        }
    };

    // FUNGSI INI DIMODIFIKASI: untuk update tombol di header DAN di sidebar
    function updateHeaderUI() {
        const token = localStorage.getItem('authToken');
        
        // Sembunyikan/tampilkan tombol Masuk di header lama (jika masih ada)
        if (loginButtonHeader) {
            loginButtonHeader.classList.toggle('hidden', !!token);
        }
        
        // Logika untuk tombol di dalam sidebar
        if (sidebarLoginBtn) {
            if (token) {
                try {
                    const payload = JSON.parse(atob(token.split('.')[1]));
                    sidebarLoginBtn.textContent = `Hi, ${payload.username}`;
                    sidebarLoginBtn.href = 'dashboard.html';
                    sidebarLoginBtn.classList.remove('sidebar-button'); // Hapus style tombol
                } catch (e) {
                    console.error("Token tidak valid:", e);
                    localStorage.removeItem('authToken');
                    sidebarLoginBtn.textContent = 'Masuk / Daftar';
                    sidebarLoginBtn.href = '#';
                    sidebarLoginBtn.classList.add('sidebar-button');
                }
            } else {
                sidebarLoginBtn.textContent = 'Masuk / Daftar';
                sidebarLoginBtn.href = '#';
                sidebarLoginBtn.classList.add('sidebar-button');
            }
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
                        mobileGames.push(game);
                        break;
                    case 'PC Game':
                        pcGames.push(game);
                        break;
                    case 'Voucher':
                    case 'Lifestyle':
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

    // Event Listener untuk Sidebar
    if (openBtn) {
        openBtn.addEventListener('click', () => {
            sidebar.classList.add('visible');
            overlay.classList.remove('hidden');
        });
    }
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    if (overlay) overlay.addEventListener('click', closeSidebar);

    // Event Listener untuk tombol login (baik di header lama maupun di sidebar baru)
    if (loginButtonHeader) {
        loginButtonHeader.addEventListener('click', (e) => {
            if (!localStorage.getItem('authToken')) {
                e.preventDefault();
                showModal();
            }
        });
    }
    if (sidebarLoginBtn) {
        sidebarLoginBtn.addEventListener('click', (e) => {
            if (!localStorage.getItem('authToken')) {
                e.preventDefault();
                showModal();
                closeSidebar(); // Tutup sidebar saat modal login muncul
            }
        });
    }

    // Event Listener untuk Modal
    if (closeModalButton) closeModalButton.addEventListener('click', hideModal);
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); loginContainer.classList.add('hidden'); registerContainer.classList.remove('hidden'); });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); registerContainer.classList.add('hidden'); loginContainer.classList.remove('hidden'); });

    // Event Listener untuk Form
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = registerForm.querySelector('input[name="password"]').value;
            const confirmPassword = registerForm.querySelector('input[name="confirmPassword"]').value;
            if (password !== confirmPassword) {
                alert('Password dan Konfirmasi Password tidak cocok!');
                return;
            }
            const data = {
                fullName: registerForm.querySelector('input[name="fullName"]').value,
                username: registerForm.querySelector('input[name="username"]').value,
                email: registerForm.querySelector('input[name="email"]').value,
                nomorWa: registerForm.querySelector('input[name="nomorWa"]').value,
                password: password
            };
            try {
                const response = await fetch(`${API_URL_AUTH}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
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
                const response = await fetch(`${API_URL_AUTH}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
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

    // Event Listener untuk toggle password
    document.querySelectorAll('.toggle-password').forEach(icon => {
        icon.addEventListener('click', function () {
            const input = this.parentElement.querySelector('input');
            input.type = input.type === 'password' ? 'text' : 'password';
            this.classList.toggle('fa-eye');
            this.classList.toggle('fa-eye-slash');
        });
    });

    // === 4. PANGGILAN FUNGSI AWAL ===
    updateHeaderUI();
    displayGames();
});