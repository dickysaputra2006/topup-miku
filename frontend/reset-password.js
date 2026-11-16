document.addEventListener('DOMContentLoaded', () => {
    const { setupPasswordToggles } = window.MikuShared.dom;
    const { apiFetchJson } = window.MikuShared.api;
    const resetForm = document.getElementById('reset-password-form');
    
    // Ambil token dari URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
        alert('Token reset tidak ditemukan atau tidak valid. Silakan ulangi proses lupa password.');
        window.location.href = 'index.html';
        return;
    }

    if (resetForm) {
        resetForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newPassword = resetForm.querySelector('input[name="newPassword"]').value;
            const confirmPassword = resetForm.querySelector('input[name="confirmPassword"]').value;

            if (newPassword !== confirmPassword) {
                return alert('Password dan Konfirmasi Password tidak cocok!');
            }

            const submitButton = resetForm.querySelector('button');
            submitButton.disabled = true;
            submitButton.textContent = 'Menyimpan...';

            try {
                const result = await apiFetchJson('/api/auth/reset-password', {
                    method: 'POST',
                    jsonBody: { token: token, newPassword: newPassword }
                });

                alert(result.message);
                window.location.href = 'index.html'; // Arahkan ke halaman utama untuk login

            } catch (error) {
                alert(`Error: ${error.message}`);
                submitButton.disabled = false;
                submitButton.textContent = 'Simpan Password Baru';
            }
        });
    }

    // Logika untuk toggle lihat password
    setupPasswordToggles();
});