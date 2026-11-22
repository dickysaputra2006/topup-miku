/**
 * leaderboard.js — Phase 6A MIKU Store
 * Public read-only. No auth. All username values escaped before rendering.
 */
(function () {
    'use strict';

    const { escapeHtml } = window.MikuShared.dom;
    const { formatRupiahPlain: formatRupiah } = window.MikuShared.format;
    const API_BASE = '/api/public/leaderboard';
    const container = document.getElementById('leaderboard-container');
    const tabs = document.querySelectorAll('.period-tab');

    let currentPeriod = 'all_time';

    function rankBadge(rank) {
        if (rank === 1) return { label: '#1', cls: 'gold', icon: 'fas fa-crown' };
        if (rank === 2) return { label: '#2', cls: 'silver', icon: 'fas fa-medal' };
        if (rank === 3) return { label: '#3', cls: 'bronze', icon: 'fas fa-medal' };
        return { label: String(rank), cls: '', icon: '' };
    }

    function rankLabelClass(label) {
        if (!label) return '';
        return 'label-' + escapeHtml(String(label).toLowerCase().replace(/[^a-z0-9_-]/g, ''));
    }

    function renderLoading() {
        container.innerHTML = `
            <div class="lb-state">
                <span class="lb-icon"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i></span>
                Memuat leaderboard...
            </div>`;
    }

    function renderError(msg) {
        container.innerHTML = `
            <div class="lb-state">
                <span class="lb-icon"><i class="fas fa-exclamation-circle" aria-hidden="true"></i></span>
                ${escapeHtml(msg || 'Gagal memuat leaderboard. Silakan coba lagi.')}
            </div>`;
    }

    function renderEmpty() {
        container.innerHTML = `
            <div class="lb-state">
                <span class="lb-icon"><i class="fas fa-trophy" aria-hidden="true"></i></span>
                Belum ada data leaderboard untuk periode ini.<br>
                <small>Jadilah yang pertama menyelesaikan topup.</small>
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

            const safeName = escapeHtml(String(entry.display_name || 'User***'));
            const safeLabel = escapeHtml(String(entry.rank_label || 'Bronze'));
            const labelCls = rankLabelClass(entry.rank_label || 'Bronze');
            const safeOrders = Number(entry.total_success_orders) || 0;
            const safeSpent = formatRupiah(entry.total_spent);

            return `
                <div class="lb-entry${entryClass}" role="listitem">
                    <div class="lb-rank-badge ${badge.cls}" aria-label="Peringkat ${rank}">
                        ${badge.icon ? `<span class="lb-medal-icon" aria-hidden="true"><i class="${badge.icon}"></i></span>` : ''}
                        <span>${escapeHtml(badge.label)}</span>
                    </div>
                    <div class="lb-info">
                        <div class="lb-name">${safeName}</div>
                        <div class="lb-meta">
                            <span class="lb-rank-label ${labelCls}">${safeLabel}</span>
                        </div>
                    </div>
                    <div class="lb-stats">
                        <div class="lb-spent">${escapeHtml(safeSpent)}</div>
                        <div class="lb-orders">${safeOrders} transaksi berhasil</div>
                    </div>
                </div>`;
        }).join('');

        container.innerHTML = `<div class="leaderboard-list" role="list">${items}</div>`;
    }

    async function loadLeaderboard(period) {
        renderLoading();
        try {
            const url = `${API_BASE}?period=${encodeURIComponent(period)}&limit=20`;
            const res = await fetch(url);
            if (!res.ok) {
                let errMsg = 'Gagal memuat leaderboard.';
                try {
                    const errData = await res.json();
                    if (errData && typeof errData.message === 'string') errMsg = errData.message;
                } catch (_) { /* abaikan */ }
                renderError(errMsg);
                return;
            }
            const data = await res.json();
            renderLeaderboard(data);
        } catch (_) {
            renderError('Koneksi bermasalah. Silakan periksa internet Anda.');
        }
    }

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

    loadLeaderboard(currentPeriod);
})();
