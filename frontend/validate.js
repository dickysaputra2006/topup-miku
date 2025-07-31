document.addEventListener('DOMContentLoaded', function() {
    // Endpoint API baru kita
    const API_URL = '/api/v1'; 
    const gamesListContainer = document.getElementById('validate-games-list');
    const validatorTitle = document.getElementById('validator-title');
    const formContainer = document.getElementById('validator-form-container');
    const resultContainer = document.getElementById('validator-result-container');
    const gameSearchInput = document.getElementById('game-validate-search-input');
    let allValidatableGames = [];

    async function fetchValidatableGames() {
        try {
            // Kita tetap mengambil daftar game dari endpoint lama
            const response = await fetch('/api/games/validatable');
            if (!response.ok) throw new Error('Gagal memuat daftar game.');
            allValidatableGames = await response.json();
            renderGamesList(allValidatableGames);
        } catch (error) {
            gamesListContainer.innerHTML = `<p style="text-align: center; color: red;">${error.message}</p>`;
        }
    }

    function renderGamesList(games) {
        gamesListContainer.innerHTML = '';
        games.forEach(game => {
            if (!game.name) return;

            const gameLink = document.createElement('a');
            gameLink.href = "#";
            gameLink.classList.add('dashboard-nav-link');
            gameLink.dataset.gameCode = game.gameCode; // Simpan gameCode di dataset
            gameLink.textContent = game.name;
            
            gameLink.addEventListener('click', (e) => {
                e.preventDefault();
                document.querySelectorAll('#validate-games-list .dashboard-nav-link').forEach(link => link.classList.remove('active'));
                gameLink.classList.add('active');
                
                const selectedGame = allValidatableGames.find(g => g.gameCode === game.gameCode);
                if (selectedGame) {
                    renderValidationForm(selectedGame);
                }
            });
            gamesListContainer.appendChild(gameLink);
        });
    }

    function renderValidationForm(game) {
        validatorTitle.textContent = `Validasi ID untuk: ${game.name}`;
        resultContainer.innerHTML = '';
        
        let formHtml = `<form id="validate-form"><label for="user-id">User ID</label><input type="text" id="user-id" required>`;
        if (game.hasZoneIdForValidation) {
            formHtml += `<label for="zone-id">Server / Zone ID</label><input type="text" id="zone-id" required>`;
        }
        formHtml += `<button type="submit">Cek Akun</button></form>`;
        formContainer.innerHTML = formHtml;

        document.getElementById('validate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitButton = e.target.querySelector('button');
    const userId = document.getElementById('user-id').value;
    const zoneIdEl = document.getElementById('zone-id');
    const zoneId = zoneIdEl ? zoneIdEl.value : null;

    resultContainer.innerHTML = '<p>Mengecek...</p>';
    submitButton.disabled = true;
    submitButton.textContent = 'Mengecek...';
    
    try {
        const response = await fetch(`${API_URL}/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gameCode: game.gameCode,
                userId: userId,
                zoneId: zoneId
            })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.message);
        
        // --- PERUBAHAN TAMPILAN HASIL ---
        let successHtml = `<div class="card" style="border-left: 5px solid var(--success-color);">
                              <p style="color:var(--success-color); font-weight: bold;">✅ Akun Ditemukan!</p>
                              <p><strong>Nickname:</strong> ${result.data.username}</p>`;

        if (result.data.region) {
            successHtml += `<p><strong>Region:</strong> ${result.data.region}</p>`;
        }

        // Cek apakah ada data promo, dan di dalamnya ada data doubleDiamond
        if (result.data.promo && result.data.promo.doubleDiamond && result.data.promo.doubleDiamond.items.length > 0) {
            successHtml += `<br><h4>Status Double Diamond</h4>`;
            result.data.promo.doubleDiamond.items.forEach(item => {
                successHtml += `<p>${item.name}: ${item.available ? '✅ Tersedia' : '❌ Telah Digunakan'}</p>`;
            });
        }
        
        successHtml += `</div>`;
        resultContainer.innerHTML = successHtml;

    } catch (error) {
        resultContainer.innerHTML = `<div class="card" style="border-left: 5px solid var(--danger-color);"><p style="color:var(--danger-color);">❌ ${error.message}</p></div>`;
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Cek Akun';
    }
        });
    }

    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allValidatableGames.filter(game => game.name && game.name.toLowerCase().includes(searchTerm));
            renderGamesList(filteredGames);
        });
    }

    fetchValidatableGames();
});