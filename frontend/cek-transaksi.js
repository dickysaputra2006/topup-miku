'use strict';

(function () {
    const API_BASE = '/api/public';

    // ── Status helpers ───────────────────────────────────────────────
    function statusLabel(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'success') return 'Berhasil';
        if (s === 'failed') return 'Gagal';
        if (s === 'refunded') return 'Refund';
        if (s === 'partial refund') return 'Perlu Review Admin';
        return 'Pending';
    }

    function statusClass(status) {
        return 'status-' + String(status || 'pending').toLowerCase().replace(/\s+/g, '-');
    }

    function formatCurrency(amount) {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency', currency: 'IDR', minimumFractionDigits: 0
        }).format(amount);
    }

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        return new Date(dateStr).toLocaleString('id-ID', {
            dateStyle: 'long', timeStyle: 'short'
        });
    }

    // ── Cek invoice tunggal ──────────────────────────────────────────
    const checkForm    = document.getElementById('check-form');
    const invoiceInput = document.getElementById('invoice-input');
    const checkBtn     = document.getElementById('check-btn');
    const resultBox    = document.getElementById('check-result');
    const resultContent = document.getElementById('check-result-content');

    checkForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        const invoiceId = (invoiceInput.value || '').trim();

        if (!invoiceId) {
            showResult('<p style="color:var(--warning-color);">Nomor invoice tidak boleh kosong.</p>', true);
            return;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(invoiceId)) {
            showResult('<p style="color:var(--warning-color);">Format invoice tidak valid. Gunakan huruf, angka, dash, atau underscore.</p>', true);
            return;
        }

        checkBtn.disabled = true;
        checkBtn.textContent = 'Mengecek...';
        showResult('<div class="ui-state loading">Memuat status transaksi...</div>', true);

        try {
            const res = await fetch(`${API_BASE}/transaction/${encodeURIComponent(invoiceId)}`);
            const data = await res.json();

            if (res.status === 404) {
                showResult(`<p style="color:var(--danger-color);"><i class="fas fa-times-circle"></i> Transaksi dengan invoice <strong>${escapeHtml(invoiceId)}</strong> tidak ditemukan.</p>`, true);
                return;
            }
            if (!res.ok) {
                showResult(`<p style="color:var(--danger-color);">${escapeHtml(data.message || 'Terjadi kesalahan.')}</p>`, true);
                return;
            }

            // Tampilkan detail transaksi
            const isPartialRefund = String(data.status || '').toLowerCase() === 'partial refund';
            const partialNote = isPartialRefund ? `
                <div class="partial-refund-notice">
                    <i class="fas fa-exclamation-triangle"></i>
                    Transaksi ini memerlukan review admin. Silakan hubungi CS kami untuk bantuan lebih lanjut.
                </div>
            ` : '';

            showResult(`
                <h4><i class="fas fa-receipt"></i> Detail Transaksi</h4>
                <div class="trx-detail-grid">
                    <div class="trx-detail-row">
                        <span class="trx-label">Invoice</span>
                        <span class="trx-value"><code>${escapeHtml(data.invoice_id)}</code></span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Status</span>
                        <span class="trx-value">
                            <span class="status-badge ${statusClass(data.status)}">${escapeHtml(data.status_label)}</span>
                        </span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Game</span>
                        <span class="trx-value">${escapeHtml(data.game_name || '-')}</span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Produk</span>
                        <span class="trx-value">${escapeHtml(data.product_name || '-')}</span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Harga</span>
                        <span class="trx-value">${formatCurrency(data.price)}</span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Dibuat</span>
                        <span class="trx-value">${formatDate(data.created_at)}</span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Diperbarui</span>
                        <span class="trx-value">${formatDate(data.updated_at)}</span>
                    </div>
                </div>
                ${partialNote}
            `, true);

        } catch (err) {
            showResult('<p style="color:var(--danger-color);">Gagal terhubung ke server. Silakan coba lagi.</p>', true);
        } finally {
            checkBtn.disabled = false;
            checkBtn.innerHTML = '<i class="fas fa-search"></i> Cek Sekarang';
        }
    });

    function showResult(html, visible) {
        resultContent.innerHTML = html;
        resultBox.classList.toggle('hidden', !visible);
    }

    // ── Recent transactions ──────────────────────────────────────────
    async function loadRecentTransactions() {
        const container = document.getElementById('recent-transactions-container');
        try {
            const res = await fetch(`${API_BASE}/recent-transactions`);
            if (!res.ok) throw new Error('Gagal memuat');
            const list = await res.json();

            if (!Array.isArray(list) || list.length === 0) {
                container.innerHTML = '<div class="ui-state empty">Belum ada transaksi terbaru.</div>';
                return;
            }

            container.innerHTML = `
                <div class="recent-transaction-list">
                    <div class="recent-trx-header">
                        <span>Invoice</span>
                        <span>Game / Produk</span>
                        <span>Status</span>
                        <span>Tanggal</span>
                    </div>
                    ${list.map(tx => `
                        <div class="recent-trx-row">
                            <span class="recent-trx-invoice"><code>${escapeHtml(tx.invoice_masked)}</code></span>
                            <span class="recent-trx-product">
                                <span class="recent-game-name">${escapeHtml(tx.game_name || '-')}</span>
                                <span class="recent-product-name">${escapeHtml(tx.product_name || '-')}</span>
                            </span>
                            <span>
                                <span class="status-badge ${statusClass(tx.status)}">${escapeHtml(tx.status_label)}</span>
                            </span>
                            <span class="recent-trx-date">${new Date(tx.created_at).toLocaleDateString('id-ID')}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (err) {
            container.innerHTML = '<div class="ui-state error">Gagal memuat transaksi terbaru.</div>';
        }
    }

    // ── Escape HTML util ─────────────────────────────────────────────
    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ── Init ─────────────────────────────────────────────────────────
    loadRecentTransactions();

    // Auto-fill dari query string: ?invoice=TRX-xxx
    const urlParams = new URLSearchParams(window.location.search);
    const prefilledInvoice = urlParams.get('invoice');
    if (prefilledInvoice) {
        invoiceInput.value = prefilledInvoice.trim().slice(0, 64);
        checkForm.dispatchEvent(new Event('submit'));
    }
})();
