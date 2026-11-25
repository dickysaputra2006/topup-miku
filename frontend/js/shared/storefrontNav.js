(function (global) {
    'use strict';

    const shared = (global.MikuShared = global.MikuShared || {});
    const RAIL_FILE_KEYS = {
        'cek-transaksi.html': 'cek-transaksi',
        'compare-prices.html': 'compare-prices',
        'leaderboard.html': 'leaderboard',
        'kontak.html': 'kontak',
    };

    function scrollToSection(targetEl) {
        if (!targetEl) return;
        const headerEl = document.querySelector('header');
        const offset = (headerEl ? headerEl.getBoundingClientRect().height : 60) + 16;
        const reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const top = Math.max(0, Math.round(targetEl.getBoundingClientRect().top + global.scrollY - offset));
        global.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    }

    function getActiveRailKey() {
        const file = (global.location.pathname.split('/').pop() || 'index.html').toLowerCase();
        if (file === '' || file === 'index.html') {
            const hash = String(global.location.hash || '').toLowerCase();
            if (hash === '#flash-sale-section') return 'flash-sale';
            if (hash === '#catalog' || hash === '#catalog-controls') return 'catalog';
            return 'home';
        }
        return RAIL_FILE_KEYS[file] || '';
    }

    function syncRailActiveState() {
        const activeKey = getActiveRailKey();
        document.querySelectorAll('.icon-rail .icon-rail-link').forEach((link) => {
            const match = Boolean(activeKey) && link.dataset.navKey === activeKey;
            link.classList.toggle('active', match);
            if (match) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
    }

    function initStorefrontNav() {
        const { formatDateId } = shared.format || {};
        const { escapeHtml } = shared.dom || {};
        const { getAuthToken, clearAuthToken } = shared.auth || {};
        const { apiFetch } = shared.api || {};

        const hamburgerBtn = document.getElementById('hamburger-btn');
        const closeDrawerBtn = document.getElementById('close-drawer-btn');
        const dropdownMenu = document.getElementById('dropdown-menu');
        const drawerBackdrop = document.getElementById('drawer-backdrop');
        const searchWrap = document.getElementById('header-search-wrap');
        const searchToggleBtn = document.getElementById('mobile-search-toggle');
        const searchCloseBtn = document.getElementById('mobile-search-close');
        const searchInput = document.getElementById('search-input');
        const searchResults = document.getElementById('search-results');
        const notifContainer = document.getElementById('notification-container');
        const notifBtn = document.getElementById('notification-toggle-btn');
        const notifBadge = document.getElementById('notification-badge');
        const notifPanel = document.getElementById('notification-panel');
        const notifList = document.getElementById('notification-list');

        const setDrawerOpen = (open) => {
            if (!dropdownMenu) return;
            dropdownMenu.classList.toggle('active', open);
            if (drawerBackdrop) drawerBackdrop.classList.toggle('hidden', !open);
            if (hamburgerBtn) hamburgerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };

        const setSearchOpen = (open) => {
            if (!searchWrap || !searchToggleBtn) return;
            searchWrap.classList.toggle('is-mobile-open', open);
            searchToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open && searchInput) searchInput.focus();
            else if (!open && searchResults) searchResults.classList.add('hidden');
        };

        const setNotificationOpen = (open) => {
            if (!notifPanel || !notifBtn) return;
            notifPanel.classList.toggle('hidden', !open);
            notifBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };

        async function checkUnreadNotifications() {
            const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
            if (!token || !notifBadge || typeof apiFetch !== 'function') return;
            try {
                const res = await apiFetch('/api/user/notifications/unread-count', { auth: true, token });
                if (!res.ok) return;
                const data = await res.json();
                notifBadge.textContent = String(data.count || 0);
                notifBadge.classList.toggle('hidden', !(data.count > 0));
            } catch (_) { /* abaikan gangguan jaringan */ }
        }

        async function loadNotificationsPanel() {
            if (!notifList) return;
            const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
            if (!token || typeof apiFetch !== 'function') {
                notifList.innerHTML = '<p class="notification-state">Masuk terlebih dahulu untuk melihat notifikasi.</p>';
                return;
            }
            notifList.innerHTML = '<p class="notification-state">Memuat...</p>';
            try {
                const res = await apiFetch('/api/user/notifications', { auth: true, token });
                if (res.status === 401 || res.status === 403) {
                    notifList.innerHTML = '<p class="notification-state">Masuk terlebih dahulu untuk melihat notifikasi.</p>';
                    return;
                }
                const list = await res.json();
                notifList.innerHTML = (!Array.isArray(list) || list.length === 0)
                    ? '<p class="notification-state">Tidak ada notifikasi.</p>'
                    : '';
                if (Array.isArray(list) && list.length > 0) {
                    list.forEach((n) => {
                        const a = document.createElement('a');
                        const raw = String(n.link || '#');
                        a.href = (raw.startsWith('/') || raw.startsWith('http') || raw === '#') ? raw : '#';
                        a.className = n.is_read ? 'notification-item' : 'notification-item unread';
                        const msg = escapeHtml ? escapeHtml(n.message) : String(n.message || '');
                        const dt = formatDateId ? formatDateId(n.created_at) : String(n.created_at || '');
                        a.innerHTML = `<p class="notification-item-msg">${msg}</p><small class="notification-item-date">${escapeHtml ? escapeHtml(dt) : dt}</small>`;
                        notifList.appendChild(a);
                    });
                }
                apiFetch('/api/user/notifications/mark-as-read', { method: 'POST', auth: true, token }).catch(() => {});
                if (notifBadge) notifBadge.classList.add('hidden');
            } catch (_) {
                notifList.innerHTML = '<p class="notification-state error">Gagal memuat notifikasi.</p>';
            }
        }

        async function syncPublicPageAuth() {
            if (document.getElementById('auth-modal')) return;
            const authBtn = document.getElementById('user-auth-button');
            const dropAuthBtn = document.getElementById('dropdown-auth-btn');
            const drawerDash = document.getElementById('drawer-dashboard-link');
            if (!authBtn) return;

            const setGuest = () => {
                if (drawerDash) drawerDash.classList.add('hidden');
                authBtn.textContent = 'Masuk';
                authBtn.href = 'index.html?login=1';
                if (dropAuthBtn) { dropAuthBtn.textContent = 'Masuk'; dropAuthBtn.href = 'index.html?login=1'; }
            };
            const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
            if (!token || typeof apiFetch !== 'function') { setGuest(); return; }

            try {
                const res = await apiFetch('/api/user/profile', { auth: true, token });
                if (!res.ok) {
                    if ((res.status === 401 || res.status === 403) && typeof clearAuthToken === 'function') clearAuthToken();
                    setGuest();
                    return;
                }
                const user = await res.json();
                const safeUser = escapeHtml ? escapeHtml(user.username) : String(user.username || 'Akun');
                authBtn.innerHTML = `<i class="fas fa-user-circle" aria-hidden="true"></i> ${safeUser}`;
                authBtn.href = 'dashboard.html';
                if (drawerDash) drawerDash.classList.remove('hidden');
                if (dropAuthBtn) {
                    dropAuthBtn.textContent = 'Keluar';
                    dropAuthBtn.href = '#';
                    dropAuthBtn.onclick = (e) => { e.preventDefault(); clearAuthToken?.(); global.location.reload(); };
                }
            } catch (_) { setGuest(); }
        }

        if (hamburgerBtn && dropdownMenu) {
            hamburgerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setNotificationOpen(false);
                setSearchOpen(false);
                setDrawerOpen(!dropdownMenu.classList.contains('active'));
            });
        }
        closeDrawerBtn?.addEventListener('click', () => setDrawerOpen(false));
        drawerBackdrop?.addEventListener('click', () => setDrawerOpen(false));
        searchToggleBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            setNotificationOpen(false);
            setSearchOpen(!searchWrap?.classList.contains('is-mobile-open'));
        });
        searchCloseBtn?.addEventListener('click', () => setSearchOpen(false));
        if (notifBtn && notifPanel) {
            notifBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setSearchOpen(false);
                const moreMenu = document.getElementById('more-nav-menu');
                const moreBtn = document.getElementById('more-nav-btn');
                if (moreMenu && moreBtn) { moreMenu.classList.add('hidden'); moreBtn.setAttribute('aria-expanded', 'false'); }
                const willOpen = notifPanel.classList.contains('hidden');
                setNotificationOpen(willOpen);
                if (willOpen) loadNotificationsPanel();
            });
        }

        document.querySelectorAll('.icon-rail .icon-rail-link').forEach((link) => {
            link.addEventListener('click', (e) => {
                const hash = link.getAttribute('href') || '';
                const idx = hash.indexOf('#');
                const file = (global.location.pathname.split('/').pop() || 'index.html').toLowerCase();
                if (idx === -1 || (file !== '' && file !== 'index.html')) return;
                const fragment = hash.slice(idx);
                let target = document.querySelector(fragment);
                if (fragment === '#flash-sale-section' && target && target.classList.contains('hidden')) {
                    target = document.getElementById('catalog') || document.getElementById('catalog-controls');
                }
                if (!target) return;
                e.preventDefault();
                scrollToSection(target);
                if (global.history && typeof global.history.replaceState === 'function') {
                    global.history.replaceState(null, '', target.id === 'flash-sale-section' ? '#flash-sale-section' : '#catalog');
                }
                syncRailActiveState();
            });
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            setNotificationOpen(false);
            setSearchOpen(false);
            if (dropdownMenu && dropdownMenu.classList.contains('active')) {
                setDrawerOpen(false);
                if (hamburgerBtn) hamburgerBtn.focus();
            }
        });
        document.addEventListener('click', (e) => {
            if (notifPanel && !notifPanel.classList.contains('hidden') && notifContainer && !notifContainer.contains(e.target)) setNotificationOpen(false);
            if (searchWrap && searchWrap.classList.contains('is-mobile-open') && !searchWrap.contains(e.target) && !(searchToggleBtn && searchToggleBtn.contains(e.target))) setSearchOpen(false);
        });
        global.addEventListener('resize', () => {
            if (global.innerWidth >= 900) setDrawerOpen(false);
            if (global.innerWidth > 768) setSearchOpen(false);
        });
        global.addEventListener('hashchange', syncRailActiveState);

        shared.storefrontNav = { setDrawerOpen, setSearchOpen, setNotificationOpen, scrollToSection };
        syncRailActiveState();
        syncPublicPageAuth();
        checkUnreadNotifications();
    }

    shared.storefrontNav = { setDrawerOpen: () => {}, setSearchOpen: () => {}, setNotificationOpen: () => {}, scrollToSection };
    document.addEventListener('DOMContentLoaded', initStorefrontNav);
})(window);
