document.addEventListener('DOMContentLoaded', function() {
    const API_URL = '/api/user/transaction/';
    const token = localStorage.getItem('authToken');
    const invoiceDetailsContainer = document.getElementById('invoice-details-container');
    const params = new URLSearchParams(window.location.search);
    const rawInvoiceId = params.get('id');
    const invoiceId = rawInvoiceId ? rawInvoiceId.trim() : '';

    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    if (!invoiceId || !/^[A-Za-z0-9_-]{3,64}$/.test(invoiceId)) {
        invoiceDetailsContainer.innerHTML = '<div class="ui-state error">Invoice ID tidak valid atau tidak ditemukan.</div>';
        return;
    }

    async function fetchInvoiceDetails() {
        invoiceDetailsContainer.innerHTML = '<div class="card"><div class="ui-state loading">Memuat detail invoice...</div></div>';
        try {
            const response = await fetch(API_URL + encodeURIComponent(invoiceId), {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Gagal mengambil data.');
            }

            const tx = await response.json();
            renderInvoiceDetails(tx);

        } catch (error) {
            invoiceDetailsContainer.innerHTML = `<div class="card"><div class="ui-state error">Error: ${error.message}</div></div>`;
        }
    }

    function renderInvoiceDetails(tx) {
        const formattedPrice = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(tx.price);
        const formattedDate = new Date(tx.created_at).toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short' });
        const normalizedStatus = String(tx.status || 'Pending').toLowerCase();
        const statusText = normalizedStatus === 'success' ? 'Berhasil'
            : normalizedStatus === 'failed' ? 'Gagal'
            : normalizedStatus === 'refunded' ? 'Refund'
            : normalizedStatus === 'partial refund' ? 'Perlu Review Admin'
            : 'Pending';
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
                <h3>Detail Pesanan</h3>
                <div class="profile-details">
                    <div>
                        <p>No. Invoice: <strong id="invoice-id">${tx.invoice_id}</strong></p>
                        <p>Tanggal: <strong id="invoice-date">${formattedDate}</strong></p>
                        <p>Produk: <strong id="invoice-product">${tx.product_name} (${tx.game_name})</strong></p>
                        <p>Total Bayar: <strong id="invoice-price">${formattedPrice}</strong></p>
                        <p>Status: <strong id="invoice-status"><span class="status-badge status-${normalizedStatus}">${statusText}</span></strong></p>
                        <p class="status-note">${statusNote}</p>
                    </div>
                </div>
            </div>
        `;

        // Logika untuk menampilkan kode voucher atau ID Game
        if (tx.status === 'Success' && tx.provider_sn && (tx.game_category === 'Voucher' || tx.game_category === 'Life Style')) {
             detailsHtml += `
                <div class="card invoice-receipt-card">
                    <h3>Kode Voucher Anda</h3>
                    <div class="api-key-container" style="display: flex; justify-content: space-between; align-items: center;">
                        <code id="voucher-code">${tx.provider_sn}</code>
                        <button id="copy-voucher-btn" class="edit-btn no-print" style="margin-top:0;">Salin</button>
                    </div>
                </div>
             `;
        } else {
             detailsHtml += `
                <div class="card invoice-receipt-card">
                    <h3>Detail Top Up</h3>
                    <p>Input Anda: <strong>${targetDisplay}</strong></p>
                    ${tx.provider_sn ? `<p style="margin-top: 0.5rem;">SN / Ref: <code>${tx.provider_sn}</code></p>` : ''}
                </div>
             `;
        }

        detailsHtml += `
            <div class="invoice-actions no-print">
                <button type="button" id="print-invoice-btn" class="invoice-btn invoice-btn-primary">
                    <i class="fas fa-print"></i> Cetak / Simpan PDF
                </button>
                <button type="button" id="copy-invoice-btn" class="invoice-btn invoice-btn-secondary">
                    <i class="far fa-copy"></i> Salin Struk
                </button>
                <button type="button" id="share-wa-invoice-btn" class="invoice-btn invoice-btn-wa">
                    <i class="fab fa-whatsapp"></i> Bagikan WA
                </button>
            </div>
        `;

        invoiceDetailsContainer.innerHTML = detailsHtml;

        async function copyText(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }

        const receiptLines = [
            '*STRUK TRANSAKSI MIKU STORE*',
            `No. Invoice: ${tx.invoice_id}`,
            `Tanggal: ${formattedDate}`,
            `Game: ${tx.game_name || '-'}`,
            `Produk: ${tx.product_name || '-'}`,
            `Tujuan: ${targetDisplay}`,
            `Status: ${statusText}`
        ];
        if (tx.provider_sn) {
            receiptLines.push(`SN / Kode: ${tx.provider_sn}`);
        }
        receiptLines.push(`Total Harga: ${formattedPrice}`);
        receiptLines.push(`Link: ${window.location.href}`);
        const receiptText = receiptLines.join('\n');

        const printBtn = document.getElementById('print-invoice-btn');
        if (printBtn) {
            printBtn.addEventListener('click', () => {
                window.print();
            });
        }

        const copyInvoiceBtn = document.getElementById('copy-invoice-btn');
        if (copyInvoiceBtn) {
            copyInvoiceBtn.addEventListener('click', async () => {
                try {
                    await copyText(receiptText);
                    const originalHtml = copyInvoiceBtn.innerHTML;
                    copyInvoiceBtn.innerHTML = '<i class="fas fa-check"></i> Tersalin!';
                    copyInvoiceBtn.disabled = true;
                    setTimeout(() => {
                        copyInvoiceBtn.innerHTML = originalHtml;
                        copyInvoiceBtn.disabled = false;
                    }, 2000);
                } catch (err) {
                    console.error('Gagal menyalin struk:', err);
                }
            });
        }

        const shareWaBtn = document.getElementById('share-wa-invoice-btn');
        if (shareWaBtn) {
            shareWaBtn.addEventListener('click', () => {
                const waUrl = `https://wa.me/?text=${encodeURIComponent(receiptText)}`;
                window.open(waUrl, '_blank', 'noopener');
            });
        }

        // Tambahkan event listener untuk tombol salin voucher jika ada
        const copyBtn = document.getElementById('copy-voucher-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const voucherCode = document.getElementById('voucher-code').textContent;
                try {
                    await copyText(voucherCode);
                    copyBtn.textContent = 'Tersalin!';
                    setTimeout(() => { copyBtn.textContent = 'Salin'; }, 2000);
                } catch (err) {
                    console.error('Gagal menyalin kode voucher:', err);
                }
            });
        }
    }

    fetchInvoiceDetails();
});
