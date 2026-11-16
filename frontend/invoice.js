document.addEventListener('DOMContentLoaded', function () {
    const { formatRupiah, formatDateId, statusLabel, statusClass } = window.MikuShared.format;
    const { copyToClipboard, escapeHtml } = window.MikuShared.dom;
    const { requireAuthToken } = window.MikuShared.auth;
    const { apiFetch } = window.MikuShared.api;
    const API_URL = '/api/user/transaction/';
    const token = requireAuthToken('index.html');
    const invoiceDetailsContainer = document.getElementById('invoice-details-container');
    const params = new URLSearchParams(window.location.search);
    const rawInvoiceId = params.get('id');
    const invoiceId = rawInvoiceId ? rawInvoiceId.trim() : '';
    const copyTimers = new WeakMap();

    if (!token) return;

    if (!invoiceId || !/^[A-Za-z0-9_-]{3,64}$/.test(invoiceId)) {
        invoiceDetailsContainer.innerHTML = '<div class="card"><div class="ui-state error">Invoice ID tidak valid atau tidak ditemukan.</div></div>';
        return;
    }

    function wireCopyButton(button, getValue, copiedHtml) {
        if (!button) return;
        const defaultHtml = button.innerHTML;
        button.addEventListener('click', async () => {
            const val = getValue();
            if (!val) return;
            clearTimeout(copyTimers.get(button));
            try {
                await copyToClipboard(val, { requireSecureContext: false });
                button.setAttribute('data-copied', 'true');
                button.innerHTML = copiedHtml;
            } catch (_) {
                button.textContent = 'Gagal salin';
            }
            copyTimers.set(button, setTimeout(() => {
                button.removeAttribute('data-copied');
                button.innerHTML = defaultHtml;
            }, 1800));
        });
    }

    async function fetchInvoiceDetails() {
        invoiceDetailsContainer.innerHTML = '<div class="card"><div class="ui-state loading">Memuat detail invoice...</div></div>';
        try {
            const response = await apiFetch(API_URL + encodeURIComponent(invoiceId), { auth: true, token });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || 'Gagal mengambil data.');
            }
            const tx = await response.json();
            renderInvoiceDetails(tx);
        } catch (error) {
            invoiceDetailsContainer.innerHTML = `<div class="card"><div class="ui-state error">Error: ${escapeHtml(error.message)}</div></div>`;
        }
    }

    function renderInvoiceDetails(tx) {
        const formattedPrice = formatRupiah(tx.price, { withDecimals: true });
        const formattedDate = formatDateId(tx.created_at, { dateStyle: 'full', timeStyle: 'short' });
        const normalizedStatus = String(tx.status || 'Pending').toLowerCase();
        const badgeCls = statusClass(tx.status);
        const statusText = statusLabel(tx.status);
        const statusNote = normalizedStatus === 'success'
            ? 'Pesanan berhasil diproses.'
            : normalizedStatus === 'failed'
                ? 'Pesanan gagal diproses. Jika saldo terpotong, cek riwayat mutasi untuk refund.'
                : normalizedStatus === 'partial refund'
                    ? 'Pesanan ini memerlukan tinjauan admin. Silakan hubungi CS kami untuk informasi lebih lanjut.'
                    : 'Pesanan sedang diproses. Silakan cek kembali beberapa saat lagi.';

        const targetDisplay = (tx.target_game_id || '-').replace('|', ' ');

        let detailsHtml = `
            <div class="card invoice-receipt-card">
                <div class="invoice-card-header">
                    <h2>Detail Pesanan</h2>
                    <span id="invoice-status"><span class="status-badge ${badgeCls}">${escapeHtml(statusText)}</span></span>
                </div>
                <div class="trx-detail-grid">
                    <div class="trx-detail-row">
                        <span class="trx-label">No. Invoice</span>
                        <span class="trx-value">
                            <span class="trx-code-copy-group">
                                <code id="invoice-id" class="trx-code-chip">${escapeHtml(tx.invoice_id)}</code>
                                <button type="button" id="copy-invoice-id-btn" class="inline-copy-btn no-print" aria-label="Salin nomor invoice ${escapeHtml(tx.invoice_id)}">
                                    <i class="far fa-copy" aria-hidden="true"></i> Salin No.
                                </button>
                            </span>
                        </span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Tanggal</span>
                        <span class="trx-value"><strong id="invoice-date">${escapeHtml(formattedDate)}</strong></span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Produk</span>
                        <span class="trx-value"><strong id="invoice-product">${escapeHtml(tx.product_name || '-')} (${escapeHtml(tx.game_name || '-')})</strong></span>
                    </div>
                    <div class="trx-detail-row">
                        <span class="trx-label">Total Bayar</span>
                        <span class="trx-value trx-price-value" id="invoice-price">${escapeHtml(formattedPrice)}</span>
                    </div>
                </div>
                <p class="status-note">${escapeHtml(statusNote)}</p>
            </div>
        `;

        if (tx.status === 'Success' && tx.provider_sn && (tx.game_category === 'Voucher' || tx.game_category === 'Life Style')) {
            detailsHtml += `
                <div class="card invoice-receipt-card">
                    <h2>Kode Voucher Anda</h2>
                    <div class="invoice-voucher-row">
                        <code id="voucher-code" class="trx-code-chip">${escapeHtml(tx.provider_sn)}</code>
                        <button type="button" id="copy-voucher-btn" class="inline-copy-btn no-print" aria-label="Salin kode voucher">
                            <i class="far fa-copy" aria-hidden="true"></i> Salin
                        </button>
                    </div>
                </div>
            `;
        } else {
            detailsHtml += `
                <div class="card invoice-receipt-card">
                    <h2>Detail Top Up</h2>
                    <div class="trx-detail-grid">
                        <div class="trx-detail-row">
                            <span class="trx-label">Tujuan</span>
                            <span class="trx-value"><strong>${escapeHtml(targetDisplay)}</strong></span>
                        </div>
                        ${tx.provider_sn ? `
                        <div class="trx-detail-row">
                            <span class="trx-label">SN / Ref</span>
                            <span class="trx-value"><code class="trx-code-chip">${escapeHtml(tx.provider_sn)}</code></span>
                        </div>` : ''}
                    </div>
                </div>
            `;
        }

        detailsHtml += `
            <div class="invoice-actions no-print">
                <button type="button" id="print-invoice-btn" class="invoice-btn invoice-btn-primary">
                    <i class="fas fa-print" aria-hidden="true"></i> Cetak / Simpan PDF
                </button>
                <button type="button" id="copy-invoice-btn" class="invoice-btn invoice-btn-secondary">
                    <i class="far fa-copy" aria-hidden="true"></i> Salin Struk
                </button>
                <button type="button" id="share-wa-invoice-btn" class="invoice-btn invoice-btn-wa">
                    <i class="fab fa-whatsapp" aria-hidden="true"></i> Bagikan WA
                </button>
            </div>
        `;

        invoiceDetailsContainer.innerHTML = detailsHtml;

        const receiptLines = [
            '*STRUK TRANSAKSI MIKU STORE*',
            `No. Invoice: ${tx.invoice_id}`,
            `Tanggal: ${formattedDate}`,
            `Game: ${tx.game_name || '-'}`,
            `Produk: ${tx.product_name || '-'}`,
            `Tujuan: ${targetDisplay}`,
            `Status: ${statusText}`,
        ];
        if (tx.provider_sn) receiptLines.push(`SN / Kode: ${tx.provider_sn}`);
        receiptLines.push(`Total Harga: ${formattedPrice}`);
        receiptLines.push(`Link: ${window.location.href}`);
        const receiptText = receiptLines.join('\n');

        const printBtn = document.getElementById('print-invoice-btn');
        if (printBtn) printBtn.addEventListener('click', () => window.print());

        wireCopyButton(
            document.getElementById('copy-invoice-id-btn'),
            () => tx.invoice_id,
            '<i class="fas fa-check" aria-hidden="true"></i> Tersalin'
        );
        wireCopyButton(
            document.getElementById('copy-invoice-btn'),
            () => receiptText,
            '<i class="fas fa-check" aria-hidden="true"></i> Tersalin!'
        );
        wireCopyButton(
            document.getElementById('copy-voucher-btn'),
            () => document.getElementById('voucher-code')?.textContent || '',
            '<i class="fas fa-check" aria-hidden="true"></i> Tersalin!'
        );

        const shareWaBtn = document.getElementById('share-wa-invoice-btn');
        if (shareWaBtn) {
            shareWaBtn.addEventListener('click', () => {
                window.open(`https://wa.me/?text=${encodeURIComponent(receiptText)}`, '_blank', 'noopener');
            });
        }
    }

    fetchInvoiceDetails();
});
