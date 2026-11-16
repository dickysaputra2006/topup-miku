(function (global) {
    'use strict';

    const shared = (global.MikuShared = global.MikuShared || {});

    /**
     * Format nominal angka menjadi Rupiah Intl (`id-ID`).
     * Gunakan `{ withDecimals: true }` hanya jika pemanggil lama memakai format desimal default (,00).
     */
    function formatRupiah(amount, { withDecimals = false } = {}) {
        const options = {
            style: 'currency',
            currency: 'IDR',
        };
        if (!withDecimals) {
            options.minimumFractionDigits = 0;
        }
        return new Intl.NumberFormat('id-ID', options).format(amount);
    }

    /**
     * Format nominal angka menjadi string `"Rp 150.000"` dengan spasi biasa.
     */
    function formatRupiahPlain(amount) {
        const num = Number(amount) || 0;
        return 'Rp ' + num.toLocaleString('id-ID');
    }

    /**
     * Format tanggal ke lokal `id-ID` atau kembalikan `'-'` bila kosong.
     */
    function formatDateId(dateStr, options) {
        if (!dateStr) return '-';
        return options !== undefined
            ? new Date(dateStr).toLocaleString('id-ID', options)
            : new Date(dateStr).toLocaleString('id-ID');
    }

    /**
     * Kembalikan class badge CSS untuk status transaksi.
     */
    function statusClass(status, defaultStatus = 'pending') {
        return `status-${String(status || defaultStatus).toLowerCase().replace(/\s+/g, '-')}`;
    }

    /**
     * Kembalikan label status transaksi berbahasa Indonesia.
     */
    function statusLabel(status, reviewLabel = 'Perlu Review Admin') {
        const s = String(status || 'Pending').toLowerCase();
        if (s === 'success') return 'Berhasil';
        if (s === 'failed') return 'Gagal';
        if (s === 'refunded') return 'Refund';
        if (s === 'partial refund') return reviewLabel;
        return 'Pending';
    }

    shared.format = {
        formatRupiah,
        formatRupiahPlain,
        formatDateId,
        statusClass,
        statusLabel,
    };
})(window);
