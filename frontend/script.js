// Salin dan ganti seluruh isi file script.js Anda dengan ini.
document.addEventListener('DOMContentLoaded', function () {
const API_URL_AUTH = 'https://topup-miku.onrender.com/api/auth';
const API_URL = 'https://topup-miku.onrender.com/api';


    
    // === Elemen UI ===
    const modal = document.getElementById('auth-modal');
    const loginButtonNav = document.getElementById('login-button'); // Tombol utama di header
    const closeModalButton = document.getElementById('close-modal-btn');
    const loginContainer = document.getElementById('login-container');
    const registerContainer = document.getElementById('register-container');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    // === Logika Modal & Form Auth ===
    function showModal() { if(modal) modal.classList.remove('hidden'); }
    function hideModal() { if(modal) modal.classList.add('hidden'); }
    
    // ====================== PERUBAHAN DI SINI ======================
    if(loginButtonNav) {
        loginButtonNav.addEventListener('click', (e) => {
            // Cek apakah ada token di localStorage
            const token = localStorage.getItem('authToken');
            
            if (!token) {
                // JIKA TIDAK ADA TOKEN (belum login):
                // 1. Cegah link default (jika ada)
                e.preventDefault(); 
                // 2. Tampilkan modal login
                showModal();
            }
            // JIKA ADA TOKEN (sudah login), kita tidak melakukan apa-apa.
            // Browser akan otomatis mengikuti href="dashboard.html" yang sudah diatur.
        });
    }
    // ====================== AKHIR PERUBAHAN ======================
    
    if(closeModalButton) closeModalButton.addEventListener('click', hideModal);

    if(showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); loginContainer.classList.add('hidden'); registerContainer.classList.remove('hidden'); });
    if(showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); registerContainer.classList.add('hidden'); loginContainer.classList.remove('hidden'); });
    
    // (Kode untuk registerForm tidak perlu diubah, biarkan seperti semula)
    if(registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const passwordInput = registerForm.querySelector('input[name="password"]');
            const confirmPasswordInput = registerForm.querySelector('input[name="confirmPassword"]');
            if (passwordInput.value !== confirmPasswordInput.value) {
                alert('Password dan Konfirmasi Password tidak cocok!');
                confirmPasswordInput.value = '';
                confirmPasswordInput.focus();
                return;
            }
            const data = {
                fullName: registerForm.querySelector('input[name="fullName"]').value,
                username: registerForm.querySelector('input[name="username"]').value,
                email: registerForm.querySelector('input[name="email"]').value,
                nomorWa: registerForm.querySelector('input[name="nomorWa"]').value,
                password: passwordInput.value
            };
            try {
                const response = await fetch(`${AUTH_API_URL}/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                alert(result.message);
                registerForm.reset();
                showLoginLink.click();
            } catch (error) {
                alert(`Error Registrasi: ${error.message}`);
            }
        });
    }

    // (Kode untuk loginForm tidak perlu diubah, biarkan seperti semula)
    if(loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                username: loginForm.querySelector('input[name="username"]').value,
                password: loginForm.querySelector('input[name="password"]').value
            };
            try {
                const response = await fetch(`${AUTH_API_URL}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
                // Simpan token ke localStorage
                localStorage.setItem('authToken', result.token);
                alert(result.message);
                // Arahkan ke dashboard SETELAH berhasil login
                window.location.href = 'dashboard.html';
            } catch (error) {
                alert(`Error Login: ${error.message}`);
            }
        });
    }

    // === Fungsi Update UI Header (Tidak perlu diubah) ===
    function updateUIAfterLogin() {
        const token = localStorage.getItem('authToken');
        if (token && loginButtonNav) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                loginButtonNav.textContent = `Hi, ${payload.username}`;
                loginButtonNav.href = 'dashboard.html'; // Penting! Arahkan ke dashboard
            } catch (e) {
                console.error("Token tidak valid:", e);
                localStorage.removeItem('authToken'); // Hapus token rusak
            }
        } else if (loginButtonNav) {
            loginButtonNav.textContent = 'Masuk Akun';
            loginButtonNav.href = '#'; // Link dummy
        }
    }
    
    // === Fungsi untuk Menampilkan Game (Tidak perlu diubah) ===
    async function displayGames() {
        const mobileGameGrid = document.querySelector('#mobile-games-grid'); 
        if (!mobileGameGrid) return;
        
        try {
            const response = await fetch(`${PUBLIC_API_URL}/games`);
            if (!response.ok) throw new Error('Gagal mengambil data game');
            const games = await response.json();
            
            mobileGameGrid.innerHTML = ''; 
            
            games.forEach(game => {
                if (game.category === 'Mobile Game') {
                    const card = document.createElement('a');
                    card.href = `product.html?gameId=${game.id}`; 
                    card.className = 'product-card';
                    card.innerHTML = `
                        <img src="${game.image_url || './path/to/default/image.png'}" alt="${game.name}" style="width:100%; border-radius: 8px; aspect-ratio: 1/1; object-fit: cover;">
                        <span>${game.name}</span>
                    `;
                    mobileGameGrid.appendChild(card);
                }
            });
        } catch (error) {
            console.error('Gagal menampilkan game:', error);
            mobileGameGrid.innerHTML = '<p>Gagal memuat game. Coba lagi nanti.</p>';
        }
    }

    // === Panggilan Fungsi Awal (Tidak perlu diubah) ===
    updateUIAfterLogin();
    displayGames();

    // === Logika Hide/Show Password (Tidak perlu diubah) ===
    document.querySelectorAll('.toggle-password').forEach(icon => {
        icon.addEventListener('click', function() {
            const input = this.parentElement.querySelector('input');
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            this.classList.toggle('fa-eye', !isPassword);
            this.classList.toggle('fa-eye-slash', isPassword);
        });
    });
});