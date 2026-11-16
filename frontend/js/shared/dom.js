(function (global) {
    'use strict';

    const shared = (global.MikuShared = global.MikuShared || {});

    /**
     * Escape karakter HTML khusus agar aman dimasukkan ke innerHTML/atribut.
     */
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Validasi URL gambar agar hanya skema http(s) atau path lokal relatif root.
     */
    function isSafeImageUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return false;
        const trimmed = rawUrl.trim();
        if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
        try {
            const parsed = new URL(trimmed);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    /**
     * Render blok state UI standar (loading/empty/error).
     */
    function uiState(message, type = 'loading') {
        return `<div class="ui-state ${type}">${message}</div>`;
    }

    /**
     * Render baris tabel untuk state loading/empty/error.
     */
    function tableState(colspan, message, type = 'loading') {
        const rowClass = type === 'error'
            ? 'table-error-row'
            : type === 'empty'
                ? 'table-empty-row'
                : 'table-loading-row';
        return `<tr class="${rowClass}"><td colspan="${colspan}"><div class="ui-state ${type}">${message}</div></td></tr>`;
    }

    /**
     * Tampilkan notifikasi toast pada elemen `#toast-notification`.
     */
    function showToast(message) {
        const toast = document.getElementById('toast-notification');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.classList.add('hidden'), 300);
        }, 5000);
    }

    /**
     * Salin teks ke clipboard menggunakan Clipboard API dengan fallback execCommand.
     */
    async function copyToClipboard(text, { requireSecureContext = true } = {}) {
        const canUseClipboard = navigator.clipboard
            && typeof navigator.clipboard.writeText === 'function'
            && (!requireSecureContext || window.isSecureContext);
        if (canUseClipboard) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) {
            throw new Error('Copy failed');
        }
    }

    /**
     * Pasang handler show/hide password untuk semua tombol ikon `.toggle-password`.
     */
    function setupPasswordToggles(root = document) {
        root.querySelectorAll('.toggle-password').forEach((icon) => {
            icon.addEventListener('click', function () {
                const input = this.parentElement.querySelector('input');
                const isPassword = input.type === 'password';
                input.type = isPassword ? 'text' : 'password';
                this.classList.toggle('fa-eye', !isPassword);
                this.classList.toggle('fa-eye-slash', isPassword);
            });
        });
    }

    shared.dom = {
        escapeHtml,
        isSafeImageUrl,
        uiState,
        tableState,
        showToast,
        copyToClipboard,
        setupPasswordToggles,
    };
})(window);
