/**
 * leaderboard.js — Phase 6A MIKU Store
 * Public read-only. No auth. No sensitive data display.
 * All username text from API is escaped before rendering.
 */
(function () {
    'use strict';

    const API_BASE = '/api/public/leaderboard';
    const container = document.getElementById('leaderboard-container');
    const tabs = document.querySelectorAll('.period-tab');

    let currentPeriod = 'all_time';

    /* ── Utilities ─────────────────────────────────────────── */

    /**
     * Escape HTML to prevent XSS when inserting API text into innerHTML.
     * @param {string} str
     * @returns {string}
     */
    function escapeHtml(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Format number to Rupiah string: 150000 → "Rp 150.000"
     * @param {number} amount
     * @returns {string}
     */
    function formatRupiah(amount) {
        const num = Number(amount) || 0;
        return 'Rp ' + num.toLocaleString('id-ID');
    }

    /**
     * Return rank badge HTML for position 1/2/3 (emoji + class), else number.
     * @param {number} rank
     * @returns {{ icon: string, cls: string }}
     */
    function rankBadge(rank) {
        if (rank === 1) return { icon: '🥇', cls: 'gold' };
        if (rank === 2) return { icon: '🥈', cls: 'silver' };
        if (rank === 3) return { icon: '🥉', cls: 'bronze' };
        return { icon: String(rank), cls: '' };
    }

    /**
     * CSS class for rank label badge.
     * @param {string} label
     * @returns {string}
     */
    function rankLabelClass(label) {
        if (!label) return '';
        return 'label-' + escapeHtml(label.toLowerCase());
    }

    /* ── Render ─────────────────────────────────────────────── */

    function renderLoading() {
        container.innerHTML = `
            <div class="lb-state">
                <span class="lb-icon"><i class="fas fa-spinner fa-spin"></i></span>
                Memuat leaderboard...
            </div>`;
    }

    function renderError(msg) {
        container.innerHTML = `
            <div class="lb-state">
                <span class="lb-icon"><i class="fas fa-exclamation-circle"></i></span>
                ${escapeHtml(msg || 'Gagal memuat leaderboard. Silakan coba lagi.')}
            </div>`;
    }

    function renderEmpty() {
        container.innerHTML = `
            <div class="lb-state">
                <span class="lb-icon"><i class="fas fa-trophy"></i></span>
                Belum ada data leaderboard untuk periode ini.<br>
                <small>Jadilah yang pertama topup!</small>
            </div>`;
    }

    function renderLeaderboard(data) {
        const list = data.leaderboard;
        if (!Array.isArray(list) || list.length === 0) {
            renderEmpty();
            return;
        }

        const items = list.map((entry) => {
            const rank = Number(entry.rank) || 0;
            const badge = rankBadge(rank);
            const entryClass = rank <= 3 ? ` rank-${rank}` : '';

            // Safe: all values from API are escaped before use in innerHTML
            const safeName   = escapeHtml(String(entry.display_name || 'User***'));
            const safeLabel  = escapeHtml(String(entry.rank_label || 'Bronze'));
            const labelCls   = rankLabelClass(safeLabel);
            const safeOrders = Number(entry.total_success_orders) || 0;
            const safeSpent  = formatRupiah(entry.total_spent);

            return `
                <div class="lb-entry${entryClass}" role="listitem">
                    <div class="lb-rank-badge ${badge.cls}" aria-label="Rank ${rank}">
                        ${escapeHtml(badge.icon)}
                    </div>
                    <div class="lb-info">
                        <div class="lb-name">${safeName}</div>
                        <div class="lb-meta">
                            <span class="lb-rank-label ${labelCls}">${safeLabel}</span>
                        </div>
                    </div>
                    <div class="lb-stats">
                        <div class="lb-spent">${safeSpent}</div>
                        <div class="lb-orders">${safeOrders} transaksi berhasil</div>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = `<div class="leaderboard-list" role="list">${items}</div>`;
    }

    /* ── Fetch ──────────────────────────────────────────────── */

    async function loadLeaderboard(period) {
        renderLoading();
        try {
            const url = `${API_BASE}?period=${encodeURIComponent(period)}&limit=20`;
            const res = await fetch(url);
            if (!res.ok) {
                // Server returned error
                let errMsg = 'Gagal memuat leaderboard.';
                try {
                    const errData = await res.json();
                    if (errData && typeof errData.message === 'string') {
                        errMsg = errData.message;
                    }
                } catch (_) { /* ignore */ }
                renderError(errMsg);
                return;
            }
            const data = await res.json();
            renderLeaderboard(data);
        } catch (err) {
            // Network error
            renderError('Koneksi bermasalah. Silakan periksa internet Anda.');
        }
    }

    /* ── Tab switching ──────────────────────────────────────── */

    function setActiveTab(period) {
        tabs.forEach((tab) => {
            const isActive = tab.dataset.period === period;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-selected', String(isActive));
        });
    }

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const period = tab.dataset.period || 'all_time';
            if (period === currentPeriod) return;
            currentPeriod = period;
            setActiveTab(period);
            loadLeaderboard(period);
        });
    });

    /* ── Init ───────────────────────────────────────────────── */
    loadLeaderboard(currentPeriod);

})();
