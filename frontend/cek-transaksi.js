'use strict';

(function () {
    const API_BASE = '/api/public';
    const { statusClass, formatRupiah, formatDateId } = window.MikuShared.format;
    const { escapeHtml, copyToClipboard } = window.MikuShared.dom;

    const checkForm = document.getElementById('check-form');
    const invoiceInput = document.getElementById('invoice-input');
    const checkBtn = document.getElementById('check-btn');
    const resultBox = document.getElementById('check-result');
    const resultContent = document.getElementById('check-result-content');
    const copyTimers = new WeakMap();

    function showResult(html, visible) {
        if (!resultContent || !resultBox) return;
        resultContent.innerHTML = html;
        resultBox.classList.toggle('hidden', !visible);
    }

    function wireInlineCopyButton(buttonId, value) {
        const btn = document.getElementById(buttonId);
        if (!btn || !value) return;
        const defaultHtml = btn.innerHTML;
        btn.addEventListener('click', async () => {
            clearTimeout(copyTimers.get(btn));
            try {
                await copyToClipboard(value, { requireSecureContext: false });
                btn.setAttribute('data-copied', 'true');
                btn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> Tersalin';
            } catch (_) {
                btn.innerHTML = 'Gagal salin';
            }
            copyTimers.set(btn, setTimeout(() => {
                btn.removeAttribute('data-copied');
                btn.innerHTML = defaultHtml;
            }, 1800));
        });
    }

    if (checkForm) {
        checkForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const invoiceId = (invoiceInput.value || '').trim();

            if (!invoiceId) {
                showResult('<div class="ui-state error">Nomor invoice tidak boleh kosong.</div>', true);
                return;
            }
            if (!/^[A-Za-z0-9_-]{3,64}$/.test(invoiceId)) {
                showResult('<div class="ui-state error">Format invoice tidak valid. Gunakan huruf, angka, tanda hubung, atau garis bawah.</div>', true);
                return;
            }

            checkBtn.disabled = true;
            checkBtn.textContent = 'Mengecek...';
            showResult('<div class="ui-state loading">Memuat status transaksi...</div>', true);

            try {
                const res = await fetch(`${API_BASE}/transaction/${encodeURIComponent(invoiceId)}`);
                const data = await res.json();

                if (res.status === 404) {
                    showResult(`<div class="ui-state error"><i class="fas fa-times-circle" aria-hidden="true"></i> Transaksi dengan invoice <strong>${escapeHtml(invoiceId)}</strong> tidak ditemukan.</div>`, true);
                    return;
                }
                if (!res.ok) {
                    showResult(`<div class="ui-state error">${escapeHtml(data.message || 'Terjadi kesalahan.')}</div>`, true);
                    return;
                }

                const isPartialRefund = String(data.status || '').toLowerCase() === 'partial refund';
                const partialNote = isPartialRefund ? `
                    <div class="partial-refund-notice" role="status">
                        <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                        <span>Transaksi ini memerlukan review admin. Silakan hubungi CS kami untuk bantuan lebih lanjut.</span>
                    </div>
                ` : '';

                showResult(`
                    <h2><i class="fas fa-receipt" aria-hidden="true"></i> Detail Transaksi</h2>
                    <div class="trx-detail-grid">
                        <div class="trx-detail-row">
                            <span class="trx-label">Invoice</span>
                            <span class="trx-value">
                                <span class="trx-code-copy-group">
                                    <code class="trx-code-chip" id="searched-invoice-code">${escapeHtml(data.invoice_id)}</code>
                                    <button type="button" id="copy-searched-invoice-btn" class="inline-copy-btn" aria-label="Salin nomor invoice ${escapeHtml(data.invoice_id)}">
                                        <i class="far fa-copy" aria-hidden="true"></i> Salin
                                    </button>
                                </span>
                            </span>
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
                            <span class="trx-value trx-price-value">${escapeHtml(formatRupiah(data.price))}</span>
                        </div>
                        <div class="trx-detail-row">
                            <span class="trx-label">Dibuat</span>
                            <span class="trx-value">${escapeHtml(formatDateId(data.created_at, { dateStyle: 'long', timeStyle: 'short' }))}</span>
                        </div>
                        <div class="trx-detail-row">
                            <span class="trx-label">Diperbarui</span>
                            <span class="trx-value">${escapeHtml(formatDateId(data.updated_at, { dateStyle: 'long', timeStyle: 'short' }))}</span>
                        </div>
                    </div>
                    ${partialNote}
                `, true);

                wireInlineCopyButton('copy-searched-invoice-btn', data.invoice_id);
            } catch (_) {
                showResult('<div class="ui-state error">Gagal terhubung ke server. Silakan coba lagi.</div>', true);
            } finally {
                checkBtn.disabled = false;
                checkBtn.innerHTML = '<i class="fas fa-search" aria-hidden="true"></i> Cek Sekarang';
            }
        });
    }

    async function loadRecentTransactions() {
        const container = document.getElementById('recent-transactions-container');
        if (!container) return;
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
                            <span class="recent-trx-status">
                                <span class="status-badge ${statusClass(tx.status)}">${escapeHtml(tx.status_label)}</span>
                            </span>
                            <span class="recent-trx-date">${escapeHtml(new Date(tx.created_at).toLocaleDateString('id-ID'))}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (_) {
            container.innerHTML = '<div class="ui-state error">Gagal memuat transaksi terbaru.</div>';
        }
    }

    loadRecentTransactions();

    const urlParams = new URLSearchParams(window.location.search);
    const prefilledInvoice = urlParams.get('invoice');
    if (prefilledInvoice && invoiceInput && checkForm) {
        invoiceInput.value = prefilledInvoice.trim().slice(0, 64);
        checkForm.dispatchEvent(new Event('submit'));
    }
})();
