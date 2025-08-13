document.addEventListener('DOMContentLoaded', function() {
    const PUBLIC_API_URL = '/api';
    const gameSearchInput = document.getElementById('game-validate-search-input');
    const validatorTitle = document.getElementById('validator-title');
    const formContainer = document.getElementById('validator-form-container');
    const resultContainer = document.getElementById('validator-result-container');
    
    // DIUBAH: Menunjuk ke dropdown, bukan list container
    const gameSelectorDropdown = document.getElementById('game-selector-dropdown');

    let allValidatableGames = [];

    async function fetchValidatableGames() {
        try {
            const response = await fetch(`${PUBLIC_API_URL}/games/validatable`);
            if (!response.ok) throw new Error('Gagal memuat daftar game.');
            allValidatableGames = await response.json();
            
            // Panggil fungsi BARU untuk mengisi dropdown
            renderGamesDropdown(allValidatableGames);

        } catch (error) {
            if (gameSelectorDropdown) {
                gameSelectorDropdown.innerHTML = `<option value="">${error.message}</option>`;
            }
        }
    }

    // FUNGSI BARU: Untuk mengisi dropdown
    function renderGamesDropdown(games) {
        if (!gameSelectorDropdown) return;
        
        gameSelectorDropdown.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = "";
        defaultOption.textContent = "-- Pilih Game Disini --";
        gameSelectorDropdown.appendChild(defaultOption);

        if (games.length === 0) {
            defaultOption.textContent = "Game tidak ditemukan";
            return;
        }

        games.forEach(game => {
            if (game.name) {
                const option = document.createElement('option');
                option.value = game.gameCode; // Value tetap menggunakan gameCode
                option.textContent = game.name;
                gameSelectorDropdown.appendChild(option);
            }
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
                const response = await fetch(`${PUBLIC_API_URL}/full-validate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gameCode: game.gameCode, userId, zoneId })
                });

                const result = await response.json();
                if (!response.ok) throw new Error(result.message);
        
                let successHtml = `<div class="card" style="border-left: 5px solid var(--success-color);">
                                      <p style="color:var(--success-color); font-weight: bold;">✅ Akun Ditemukan!</p>
                                      <p><strong>Nickname:</strong> ${result.data.username}</p>`;
                if (result.data.region) {
                    successHtml += `<p><strong>Region:</strong> ${result.data.region}</p>`;
                }
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

    // EVENT LISTENER BARU untuk dropdown
    if (gameSelectorDropdown) {
        gameSelectorDropdown.addEventListener('change', () => {
            const selectedGameCode = gameSelectorDropdown.value;

            if (selectedGameCode) {
                const selectedGame = allValidatableGames.find(g => g.gameCode === selectedGameCode);
                if (selectedGame) {
                    renderValidationForm(selectedGame);
                }
            } else {
                // Reset jika kembali ke pilihan default
                validatorTitle.textContent = 'Pilih Game dari Daftar';
                formContainer.innerHTML = '';
                resultContainer.innerHTML = '';
            }
        });
    }

    // Pencarian sekarang memfilter dropdown
    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allValidatableGames.filter(game => game.name && game.name.toLowerCase().includes(searchTerm));
            renderGamesDropdown(filteredGames);
        });
    }

    fetchValidatableGames();
});