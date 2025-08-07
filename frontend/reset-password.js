document.addEventListener('DOMContentLoaded', () => {
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
                const response = await fetch('/api/auth/reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: token, newPassword: newPassword })
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.message);
                }

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
    document.querySelectorAll('.toggle-password').forEach(icon => {
        icon.addEventListener('click', function () {
            const input = this.parentElement.querySelector('input');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            this.classList.toggle('fa-eye', !isPassword);
            this.classList.toggle('fa-eye-slash', isPassword);
        });
    });
});