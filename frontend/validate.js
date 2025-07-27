document.addEventListener('DOMContentLoaded', function() {
    const API_URL = 'https://topup-miku.onrender.com/api';
    const gamesListContainer = document.getElementById('validate-games-list');
    const validatorTitle = document.getElementById('validator-title');
    const formContainer = document.getElementById('validator-form-container');
    const resultContainer = document.getElementById('validator-result-container');
    let allValidatableGames = [];

    async function fetchValidatableGames() {
        try {
            const response = await fetch(`${API_URL}/games/validatable`);
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
            const gameLink = document.createElement('a');
            gameLink.href = "#";
            gameLink.classList.add('dashboard-nav-link');
            gameLink.dataset.gameId = game.id;
            gameLink.textContent = game.name;
            gameLink.addEventListener('click', (e) => {
                e.preventDefault();
                document.querySelectorAll('#validate-games-list .dashboard-nav-link').forEach(link => link.classList.remove('active'));
                gameLink.classList.add('active');
                const selectedGame = allValidatableGames.find(g => g.id == game.id);
                renderValidationForm(selectedGame);
            });
            gamesListContainer.appendChild(gameLink);
        });
    }

    function renderValidationForm(game) {
        validatorTitle.textContent = `Validasi ID untuk: ${game.name}`;
        resultContainer.innerHTML = '';
        
        let formHtml = `
            <form id="validate-form">
                <label for="user-id">User ID</label>
                <input type="text" id="user-id" required>`;
        
        if (game.hasZoneIdForValidation) {
            formHtml += `
                <label for="zone-id">Server / Zone ID</label>
                <input type="text" id="zone-id" required>`;
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
                const response = await fetch(`${API_URL}/validate-id`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        gameId: game.id,
                        userId: userId,
                        zoneId: zoneId
                    })
                });

                const result = await response.json();
                if (!response.ok) {
                   throw new Error(result.message);
                }

                let successHtml = `<div class="card" style="border-left: 5px solid var(--success-color);">
                                    <p style="color:var(--success-color); font-weight: bold;">✅ Akun Ditemukan!</p>
                                    <p><strong>Nickname:</strong> ${result.data.username || result.nickname}</p>`;
                if(result.data.region) {
                    successHtml += `<p><strong>Region:</strong> ${result.data.region}</p>`;
                }
                
                if(result.data.promo && result.data.promo.doubleDiamond) {
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

    fetchValidatableGames();
});