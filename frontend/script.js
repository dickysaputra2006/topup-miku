document.addEventListener('DOMContentLoaded', function () {
    // === 1. DEKLARASI KONSTANTA & ELEMEN ===
    const API_URL_AUTH = 'https://topup-miku.onrender.com/api/auth';
    const API_URL = 'https://topup-miku.onrender.com/api';
    const token = localStorage.getItem('authToken');

    // Elemen Header & Dropdown
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const dropdownMenu = document.getElementById('dropdown-menu');
    const userAuthButton = document.getElementById('user-auth-button');

    // Elemen Modal Login/Register
    const modal = document.getElementById('auth-modal');
    const closeModalButton = document.getElementById('close-modal-btn');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    // Elemen Search (Dropdown)
    const searchBtn = document.getElementById('search-btn');
    const searchContainer = document.getElementById('search-container');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    
    let allGamesData = [];

    // === 2. DEFINISI SEMUA FUNGSI ===

    function showModal() { if (modal) modal.classList.remove('hidden'); }
    function hideModal() { if (modal) modal.classList.add('hidden'); }

    async function updateAuthButton() {
        if (!userAuthButton) return;

        if (token) {
            try {
                const response = await fetch(`${API_URL}/user/profile`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!response.ok) throw new Error('Sesi tidak valid.');
                const user = await response.json();
                
                userAuthButton.innerHTML = `<i class="fas fa-user-circle"></i> ${user.username}`;
                userAuthButton.href = 'dashboard.html';
                userAuthButton.onclick = null;

            } catch (error) {
                localStorage.removeItem('authToken');
                userAuthButton.textContent = 'Masuk';
                userAuthButton.href = '#';
                userAuthButton.addEventListener('click', (e) => {
                    e.preventDefault();
                    showModal();
                });
            }
        } else {
            userAuthButton.textContent = 'Masuk';
            userAuthButton.href = '#';
            userAuthButton.addEventListener('click', (e) => {
                e.preventDefault();
                showModal();
            });
        }
    }

    function renderGameGrid(games, containerId) {
        const gridContainer = document.getElementById(containerId);
        if (!gridContainer) return;
        gridContainer.innerHTML = '';

        const parentSection = gridContainer.closest('.content-section');
        if (games.length === 0) {
            if (parentSection) parentSection.classList.add('hidden');
            return;
        }
        if (parentSection) parentSection.classList.remove('hidden');
        
        games.forEach(game => {
            const card = document.createElement('a');
            card.href = `product.html?gameId=${game.id}`;
            card.className = 'product-card';
            card.innerHTML = `
                <img src="${game.image_url || 'https://via.placeholder.com/150'}" alt="${game.name}">
                <span>${game.name}</span>
            `;
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
            const mobileGrid = document.getElementById('mobile-games-grid');
            if(mobileGrid) mobileGrid.innerHTML = '<p>Gagal memuat game. Coba lagi nanti.</p>';
        }
    }

    function handleSearch(term) {
        if (!searchResults) return;
        const lowerTerm = term.toLowerCase();
        searchResults.innerHTML = '';

        if (lowerTerm.length < 1) return;

        const filtered = allGamesData.filter(game => game.name.toLowerCase().includes(lowerTerm));

        if (filtered.length === 0) {
            searchResults.innerHTML = '<p style="padding: 1rem; text-align: center; color: #aaa;">Game tidak ditemukan.</p>';
            return;
        }

        filtered.forEach(game => {
            const item = document.createElement('a');
            item.href = `product.html?gameId=${game.id}`;
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '0.8rem 1rem';
            item.style.textDecoration = 'none';
            item.style.color = 'var(--text-color)';
            item.innerHTML = `
                <img src="${game.image_url || 'https://via.placeholder.com/40'}" alt="${game.name}" style="width: 40px; height: 40px; border-radius: 5px; object-fit: cover;">
                <span style="margin-left: 1rem;">${game.name}</span>
            `;
            item.onmouseover = () => item.style.backgroundColor = 'var(--primary-color)';
            item.onmouseout = () => item.style.backgroundColor = 'transparent';
            searchResults.appendChild(item);
        });
    }

    // === 3. SEMUA EVENT LISTENER ===

    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if(dropdownMenu) dropdownMenu.classList.toggle('hidden');
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

    if(searchBtn) {
        searchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(searchContainer) searchContainer.classList.toggle('hidden');
            if(searchInput && !searchContainer.classList.contains('hidden')) {
                searchInput.focus();
            }
        });
    }

    if(searchInput) {
        searchInput.addEventListener('input', () => handleSearch(searchInput.value));
    }

    window.addEventListener('click', (e) => {
        if (dropdownMenu && !dropdownMenu.classList.contains('hidden') && !hamburgerBtn.contains(e.target)) {
            dropdownMenu.classList.add('hidden');
        }
        if (searchContainer && !searchContainer.classList.contains('hidden') && !searchContainer.contains(e.target) && !searchBtn.contains(e.target)) {
            searchContainer.classList.add('hidden');
        }
    });

    // === 4. PANGGILAN FUNGSI AWAL ===
    updateAuthButton();
    displayGames();
});