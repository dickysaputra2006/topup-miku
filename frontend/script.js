document.addEventListener('DOMContentLoaded', function () {
    const { formatRupiah } = window.MikuShared.format;
    const { escapeHtml, uiState, setupPasswordToggles } = window.MikuShared.dom;
    const { getAuthToken, setAuthToken, clearAuthToken, consumeLogoutMessage } = window.MikuShared.auth;
    const { apiFetch } = window.MikuShared.api;
    const storefrontNav = window.MikuShared.storefrontNav;
    const {
        getInitials,
        attachSimpleThumbFallback,
        buildGameCard,
        buildFlashSaleCard,
    } = window.MikuShared.storefrontCards;

    const logoutMessage = consumeLogoutMessage();
    if (logoutMessage) alert(logoutMessage);

    const API_URL_AUTH = '/api/auth';
    const API_URL = '/api';

    const dropdownMenu = document.getElementById('dropdown-menu');
    const moreNavBtn = document.getElementById('more-nav-btn');
    const moreNavMenu = document.getElementById('more-nav-menu');
    const modal = document.getElementById('auth-modal');
    const closeModalButton = document.getElementById('close-modal-btn');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const forgotPasswordContainer = document.getElementById('forgot-password-container');
    const forgotPasswordForm = document.getElementById('forgot-password-form');
    const forgotPasswordLink = document.querySelector('.forgot-password');

    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const notificationBadge = document.getElementById('notification-badge');
    const categoryChips = document.querySelectorAll('.category-chip');
    const catalogCountEl = document.getElementById('catalog-count');

    let allGamesData = [];
    let activeCategory = 'all';
    let isFetchingProfile = false;
    let searchDebounceTimer = null;
    let flashSaleTimerInterval = null;

    function showLoginError(msg) {
        const errEl = document.getElementById('login-error-msg');
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.classList.toggle('hidden', !msg);
    }
    function showModal() { showLoginError(''); if (modal) modal.classList.remove('hidden'); }
    function hideModal() { showLoginError(''); if (modal) modal.classList.add('hidden'); }

    function setMoreNavOpen(open) {
        if (!moreNavMenu || !moreNavBtn) return;
        moreNavMenu.classList.toggle('hidden', !open);
        moreNavBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setLoggedOutUI() {
        clearAuthToken();
        const userAuthButton = document.getElementById('user-auth-button');
        const dropdownAuthButton = document.getElementById('dropdown-auth-btn');
        const drawerDashboardLink = document.getElementById('drawer-dashboard-link');
        if (drawerDashboardLink) drawerDashboardLink.classList.add('hidden');
        if (userAuthButton) {
            userAuthButton.textContent = 'Masuk';
            userAuthButton.href = '#';
            userAuthButton.onclick = (e) => { e.preventDefault(); showModal(); };
        }
        if (dropdownAuthButton) {
            dropdownAuthButton.textContent = 'Masuk';
            dropdownAuthButton.href = '#';
            dropdownAuthButton.onclick = (e) => {
                e.preventDefault();
                if (storefrontNav) storefrontNav.setDrawerOpen(false);
                else if (dropdownMenu) dropdownMenu.classList.remove('active');
                showModal();
            };
        }
        if (notificationBadge) notificationBadge.classList.add('hidden');
    }

    async function updateAuthButton() {
        const currentToken = getAuthToken();
        const userAuthButton = document.getElementById('user-auth-button');
        const dropdownAuthButton = document.getElementById('dropdown-auth-btn');
        if (!userAuthButton || !dropdownAuthButton) return;
        if (!currentToken) { setLoggedOutUI(); return; }
        if (isFetchingProfile) return;
        isFetchingProfile = true;

        try {
            const response = await apiFetch(`${API_URL}/user/profile`, { auth: true, token: currentToken });
            if (response.status === 401 || response.status === 403 || response.status === 429) {
                setLoggedOutUI();
                return;
            }
            if (!response.ok) return;
            const user = await response.json();
            userAuthButton.innerHTML = `<i class="fas fa-user-circle" aria-hidden="true"></i> ${escapeHtml(user.username)}`;
            userAuthButton.href = 'dashboard.html';
            userAuthButton.onclick = null;

            const drawerDashboardLink = document.getElementById('drawer-dashboard-link');
            if (drawerDashboardLink) drawerDashboardLink.classList.remove('hidden');
            dropdownAuthButton.textContent = 'Keluar';
            dropdownAuthButton.href = '#';
            dropdownAuthButton.onclick = (e) => {
                e.preventDefault();
                clearAuthToken();
                window.location.reload();
            };
        } catch (error) {
            console.warn('[auth] Network error saat cek profil:', error.message);
        } finally {
            isFetchingProfile = false;
        }
    }

    function renderGameGrid(games, containerId, forceHidden = false) {
        const gridContainer = document.getElementById(containerId);
        if (!gridContainer) return 0;
        gridContainer.innerHTML = '';
        const parentSection = gridContainer.closest('.content-section');
        if (forceHidden || games.length === 0) {
            if (parentSection) parentSection.classList.add('hidden');
            return 0;
        }
        if (parentSection) parentSection.classList.remove('hidden');

        games.forEach((game) => {
            gridContainer.appendChild(buildGameCard(game));
        });
        return games.length;
    }

    function renderCatalogByCategory(category) {
        activeCategory = category;
        const mobileGames = allGamesData.filter((g) => g.category === 'Mobile Game' || g.category === 'Special MLBB');
        const pcGames = allGamesData.filter((g) => g.category === 'PC Game');
        const voucherGames = allGamesData.filter((g) => g.category === 'Voucher' || g.category === 'Life Style');

        let visibleCount = 0;
        visibleCount += renderGameGrid(mobileGames, 'mobile-games-grid', category !== 'all' && category !== 'mobile');
        visibleCount += renderGameGrid(pcGames, 'pc-games-grid', category !== 'all' && category !== 'pc');
        visibleCount += renderGameGrid(voucherGames, 'voucher-grid', category !== 'all' && category !== 'voucher');

        const emptyStateEl = document.getElementById('catalog-empty-state');
        if (emptyStateEl) emptyStateEl.classList.toggle('hidden', !(allGamesData.length > 0 && visibleCount === 0));
        if (catalogCountEl) {
            catalogCountEl.textContent = allGamesData.length > 0 ? `${visibleCount} game ditampilkan` : '';
        }
        categoryChips.forEach((chip) => {
            const isMatch = chip.dataset.category === category;
            chip.classList.toggle('active', isMatch);
            chip.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
        });
    }

    async function displayGames() {
        try {
            const response = await fetch(`${API_URL}/games`);
            if (!response.ok) throw new Error('Gagal mengambil data game');
            allGamesData = await response.json();
            renderCatalogByCategory(activeCategory);
        } catch (error) {
            console.error('Gagal menampilkan game:', error);
            const mobileGrid = document.getElementById('mobile-games-grid');
            if (mobileGrid) mobileGrid.innerHTML = uiState('Gagal memuat katalog game. Silakan muat ulang halaman.', 'error');
        }
    }

    function handleSearch(term) {
        if (!searchResults) return;
        const lowerTerm = String(term || '').trim().toLowerCase();
        if (lowerTerm.length < 1) {
            searchResults.classList.add('hidden');
            searchResults.innerHTML = '';
            return;
        }
        const filtered = allGamesData.filter((game) => String(game.name || '').toLowerCase().includes(lowerTerm));
        searchResults.innerHTML = '';
        searchResults.classList.remove('hidden');

        if (filtered.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'search-results-empty';
            empty.textContent = 'Game tidak ditemukan.';
            searchResults.appendChild(empty);
            return;
        }

        filtered.forEach((game) => {
            const item = document.createElement('a');
            item.href = `product.html?gameId=${encodeURIComponent(game.id)}`;
            item.className = 'search-result-item';

            const thumb = document.createElement('div');
            thumb.className = 'search-result-thumb';
            attachSimpleThumbFallback(thumb, game.image_url, game.name, 'search-result-initials', getInitials(game.name));

            const meta = document.createElement('div');
            meta.className = 'search-result-meta';
            const nameEl = document.createElement('span');
            nameEl.className = 'search-result-name';
            nameEl.textContent = game.name;
            const catEl = document.createElement('span');
            catEl.className = 'search-result-cat';
            catEl.textContent = game.category || 'Game';

            meta.appendChild(nameEl);
            meta.appendChild(catEl);
            item.appendChild(thumb);
            item.appendChild(meta);
            searchResults.appendChild(item);
        });
    }

    function startFlashSaleCountdown(flashSales) {
        if (flashSaleTimerInterval) {
            clearInterval(flashSaleTimerInterval);
            flashSaleTimerInterval = null;
        }
        const countdownEl = document.getElementById('flash-sale-countdown');
        const hoursEl = document.getElementById('fs-hours');
        const minutesEl = document.getElementById('fs-minutes');
        const secondsEl = document.getElementById('fs-seconds');
        if (!countdownEl || !hoursEl || !minutesEl || !secondsEl) return;

        const now = Date.now();
        const futureEndTimes = Array.isArray(flashSales)
            ? flashSales.map((s) => Date.parse(s.end_time || s.end_at || '')).filter((ts) => Number.isFinite(ts) && ts > now)
            : [];
        if (futureEndTimes.length === 0) {
            countdownEl.classList.add('hidden');
            return;
        }
        const nearestEndTime = Math.min(...futureEndTimes);
        countdownEl.classList.remove('hidden');

        const updateCountdown = () => {
            const diff = nearestEndTime - Date.now();
            if (diff <= 0) {
                clearInterval(flashSaleTimerInterval);
                flashSaleTimerInterval = null;
                hoursEl.textContent = '00';
                minutesEl.textContent = '00';
                secondsEl.textContent = '00';
                const section = countdownEl.closest('.content-section');
                if (section) section.classList.add('hidden');
                return;
            }
            const totalSeconds = Math.floor(diff / 1000);
            hoursEl.textContent = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
            minutesEl.textContent = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
            secondsEl.textContent = String(totalSeconds % 60).padStart(2, '0');
        };
        updateCountdown();
        flashSaleTimerInterval = setInterval(updateCountdown, 1000);
    }

    async function displayFlashSales() {
        const flashSaleTrack = document.querySelector('.flash-sale-track');
        if (!flashSaleTrack) return;
        const section = flashSaleTrack.closest('.content-section');
        try {
            const response = await fetch(`${API_URL}/public/flash-sales`);
            const flashSales = await response.json();
            flashSaleTrack.innerHTML = '';
            if (!Array.isArray(flashSales) || flashSales.length === 0) {
                startFlashSaleCountdown([]);
                if (section) section.classList.add('hidden');
                return;
            }
            if (section) section.classList.remove('hidden');
            startFlashSaleCountdown(flashSales);

            flashSales.forEach((product) => {
                const matchedGame = allGamesData.find((g) => String(g.id) === String(product.game_id));
                const enriched = matchedGame && !product.game_category
                    ? { ...product, game_category: matchedGame.category }
                    : product;
                flashSaleTrack.appendChild(buildFlashSaleCard(enriched, formatRupiah));
            });
        } catch (error) {
            console.error('Gagal memuat flash sale:', error);
            if (section) section.classList.add('hidden');
        }
    }

    categoryChips.forEach((chip) => {
        chip.addEventListener('click', () => renderCatalogByCategory(chip.dataset.category || 'all'));
    });

    if (moreNavBtn && moreNavMenu) {
        moreNavBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (storefrontNav) storefrontNav.setNotificationOpen(false);
            setMoreNavOpen(moreNavMenu.classList.contains('hidden'));
        });
    }

    if (closeModalButton) closeModalButton.addEventListener('click', hideModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); loginContainer.classList.add('hidden'); registerContainer.classList.remove('hidden'); });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); registerContainer.classList.add('hidden'); loginContainer.classList.remove('hidden'); });
    if (forgotPasswordLink) forgotPasswordLink.addEventListener('click', (e) => { e.preventDefault(); loginContainer.classList.add('hidden'); forgotPasswordContainer.classList.remove('hidden'); });
    document.querySelectorAll('.show-login-from-forgot').forEach((link) => {
        link.addEventListener('click', (e) => { e.preventDefault(); forgotPasswordContainer.classList.add('hidden'); loginContainer.classList.remove('hidden'); });
    });

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
                countryCode: registerForm.querySelector('select[name="countryCode"]').value,
                nomorWa: registerForm.querySelector('input[name="nomorWa"]').value,
                password: passwordInput.value,
            };
            try {
                const response = await fetch(`${API_URL_AUTH}/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                alert(result.message);
                registerForm.reset();
                if (showLoginLink) showLoginLink.click();
            } catch (error) {
                alert(`Error Registrasi: ${error.message}`);
            }
        });
    }

    if (forgotPasswordForm) {
        forgotPasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = forgotPasswordForm.querySelector('input[name="email"]').value;
            const submitButton = forgotPasswordForm.querySelector('button');
            submitButton.disabled = true;
            submitButton.textContent = 'Mengirim...';
            try {
                const response = await fetch(`${API_URL_AUTH}/forgot-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                });
                const result = await response.json();
                alert(result.message);
                document.querySelector('.show-login-from-forgot').click();
            } catch (_) {
                alert('Terjadi kesalahan. Silakan coba lagi.');
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Kirim Link Reset';
                forgotPasswordForm.reset();
            }
        });
    }

    if (loginForm) {
        loginForm.addEventListener('input', () => showLoginError(''));
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            showLoginError('');
            const username = String(loginForm.querySelector('input[name="username"]').value || '').trim();
            const password = loginForm.querySelector('input[name="password"]').value;
            if (!username || !password) {
                showLoginError('Username dan kata sandi wajib diisi.');
                return;
            }
            try {
                const response = await fetch(`${API_URL_AUTH}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                setAuthToken(result.token);
                window.location.reload();
            } catch (error) {
                showLoginError(error.message || 'Gagal masuk. Periksa username dan kata sandi Anda.');
            }
        });
    }

    setupPasswordToggles();

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => handleSearch(searchInput.value), 250);
        });
        searchInput.addEventListener('focus', () => {
            if (searchInput.value.trim().length > 0) handleSearch(searchInput.value);
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && searchInput) {
            const tag = document.activeElement && document.activeElement.tagName;
            const isEditable = document.activeElement && document.activeElement.isContentEditable;
            if (!isEditable && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
                e.preventDefault();
                if (window.innerWidth <= 768 && storefrontNav) storefrontNav.setSearchOpen(true);
                else searchInput.focus();
            }
        } else if (e.key === 'Escape') {
            if (searchResults && !searchResults.classList.contains('hidden')) searchResults.classList.add('hidden');
            setMoreNavOpen(false);
            hideModal();
        }
    });

    window.addEventListener('click', (e) => {
        if (moreNavMenu && !moreNavMenu.classList.contains('hidden') && moreNavBtn && !moreNavBtn.contains(e.target) && !moreNavMenu.contains(e.target)) {
            setMoreNavOpen(false);
        }
        if (searchResults && !searchResults.classList.contains('hidden') && searchInput && !searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.classList.add('hidden');
        }
    });

    if (!getAuthToken() && new URLSearchParams(window.location.search).get('login') === '1') {
        showModal();
    }

    updateAuthButton();
    displayGames();
    displayFlashSales();
});
