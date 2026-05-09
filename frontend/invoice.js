document.addEventListener('DOMContentLoaded', function() {
    const API_URL = '/api/user/transaction/';
    const token = localStorage.getItem('authToken');
    const invoiceDetailsContainer = document.getElementById('invoice-details-container');
    const params = new URLSearchParams(window.location.search);
    const invoiceId = params.get('id');

    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    if (!invoiceId) {
        invoiceDetailsContainer.innerHTML = '<div class="ui-state error">Invoice ID tidak ditemukan.</div>';
        return;
    }

    async function fetchInvoiceDetails() {
        invoiceDetailsContainer.innerHTML = '<div class="card"><div class="ui-state loading">Memuat detail invoice...</div></div>';
        try {
            const response = await fetch(API_URL + invoiceId, {
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

        let detailsHtml = `
            <div class="card">
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
                <div class="card">
                    <h3>Kode Voucher Anda</h3>
                    <div class="api-key-container" style="display: flex; justify-content: space-between; align-items: center;">
                        <code id="voucher-code">${tx.provider_sn}</code>
                        <button id="copy-voucher-btn" class="edit-btn" style="margin-top:0;">Salin</button>
                    </div>
                </div>
             `;
        } else {
             detailsHtml += `
                <div class="card">
                    <h3>Detail Top Up</h3>
                    <p>Input Anda: <strong>${tx.target_game_id.replace('|', ' ')}</strong></p>
                </div>
             `;
        }

        invoiceDetailsContainer.innerHTML = detailsHtml;

        // Tambahkan event listener untuk tombol salin jika ada
        const copyBtn = document.getElementById('copy-voucher-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const voucherCode = document.getElementById('voucher-code').textContent;
                navigator.clipboard.writeText(voucherCode).then(() => {
                    copyBtn.textContent = 'Tersalin!';
                    setTimeout(() => { copyBtn.textContent = 'Salin'; }, 2000);
                });
            });
        }
    }

    fetchInvoiceDetails();
});
