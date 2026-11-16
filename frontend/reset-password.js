document.addEventListener('DOMContentLoaded', () => {
    const { setupPasswordToggles, escapeHtml } = window.MikuShared.dom;
    const { apiFetchJson } = window.MikuShared.api;
    const resetForm = document.getElementById('reset-password-form');
    const statusEl = document.getElementById('reset-status-msg');
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    function showResetStatus(message, type) {
        if (!statusEl) return;
        statusEl.innerHTML = `<div class="ui-state ${type}">${escapeHtml(message)}</div>`;
        statusEl.classList.remove('hidden');
    }

    if (!token) {
        showResetStatus('Token reset tidak ditemukan atau tidak valid. Silakan ulangi proses lupa password.', 'error');
        if (resetForm) {
            const btn = resetForm.querySelector('button[type="submit"]');
            if (btn) btn.disabled = true;
        }
        return;
    }

    if (resetForm) {
        resetForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPassword = resetForm.querySelector('input[name="newPassword"]').value;
            const confirmPassword = resetForm.querySelector('input[name="confirmPassword"]').value;

            if (newPassword !== confirmPassword) {
                showResetStatus('Password dan Konfirmasi Password tidak cocok.', 'error');
                return;
            }

            const submitButton = resetForm.querySelector('button[type="submit"]');
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = 'Menyimpan...';
            }

            try {
                const result = await apiFetchJson('/api/auth/reset-password', {
                    method: 'POST',
                    jsonBody: { token, newPassword },
                });
                showResetStatus(result.message || 'Password berhasil diperbarui. Mengarahkan ke beranda...', 'success');
                setTimeout(() => { window.location.href = 'index.html'; }, 1500);
            } catch (error) {
                showResetStatus(`Error: ${error.message}`, 'error');
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Simpan Password Baru';
                }
            }
        });
    }

    setupPasswordToggles();
});
