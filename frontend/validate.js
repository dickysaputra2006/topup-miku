'use strict';

document.addEventListener('DOMContentLoaded', function () {
    const { escapeHtml } = window.MikuShared.dom;
    const PUBLIC_API_URL = '/api';
    const gameSearchInput = document.getElementById('game-validate-search-input');
    const validatorTitle = document.getElementById('validator-title');
    const formContainer = document.getElementById('validator-form-container');
    const resultContainer = document.getElementById('validator-result-container');
    const gameSelectorDropdown = document.getElementById('game-selector-dropdown');

    let allValidatableGames = [];

    async function fetchValidatableGames() {
        try {
            const response = await fetch(`${PUBLIC_API_URL}/games/validatable`);
            if (!response.ok) throw new Error('Gagal memuat daftar game.');
            allValidatableGames = await response.json();
            renderGamesDropdown(allValidatableGames);
        } catch (error) {
            if (gameSelectorDropdown) {
                gameSelectorDropdown.innerHTML = `<option value="">${escapeHtml(error.message)}</option>`;
            }
        }
    }

    function renderGamesDropdown(games) {
        if (!gameSelectorDropdown) return;
        gameSelectorDropdown.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = games.length === 0 ? 'Game tidak ditemukan' : '-- Pilih Game Disini --';
        gameSelectorDropdown.appendChild(defaultOption);

        games.forEach(game => {
            if (game.name) {
                const option = document.createElement('option');
                option.value = game.gameCode;
                option.textContent = game.name;
                gameSelectorDropdown.appendChild(option);
            }
        });
    }

    function renderValidationForm(game) {
        validatorTitle.textContent = `Validasi ID untuk: ${game.name}`;
        resultContainer.innerHTML = '';

        let formHtml = '<form id="validate-form"><label for="user-id">User ID</label><input type="text" id="user-id" placeholder="Masukkan User ID" required>';
        if (game.hasZoneIdForValidation) {
            formHtml += '<label for="zone-id">Server / Zone ID</label><input type="text" id="zone-id" placeholder="Masukkan Server / Zone ID" required>';
        }
        formHtml += '<button type="submit">Cek Akun</button></form>';
        formContainer.innerHTML = formHtml;

        const validateForm = document.getElementById('validate-form');
        if (!validateForm) return;
        validateForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitButton = validateForm.querySelector('button[type="submit"]');
            const userId = document.getElementById('user-id').value.trim();
            const zoneIdEl = document.getElementById('zone-id');
            const zoneId = zoneIdEl ? zoneIdEl.value.trim() : null;

            resultContainer.innerHTML = '<div class="ui-state loading">Mengecek data akun...</div>';
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = 'Mengecek...';
            }

            try {
                const response = await fetch(`${PUBLIC_API_URL}/full-validate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gameCode: game.gameCode, userId, zoneId }),
                });

                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.message || 'Gagal memvalidasi akun.');

                let successHtml = `
                    <div class="validation-result-card is-success">
                        <p class="validation-status-title"><i class="fas fa-check-circle" aria-hidden="true"></i> Akun Ditemukan</p>
                        <p><strong>Nickname:</strong> ${escapeHtml(result.data && result.data.username ? result.data.username : '-')}</p>`;
                if (result.data && result.data.region) {
                    successHtml += `<p><strong>Region:</strong> ${escapeHtml(result.data.region)}</p>`;
                }
                const ddItems = result.data && result.data.promo && result.data.promo.doubleDiamond && result.data.promo.doubleDiamond.items;
                if (Array.isArray(ddItems) && ddItems.length > 0) {
                    successHtml += '<h3 class="validation-promo-title">Status Double Diamond</h3>';
                    ddItems.forEach(item => {
                        successHtml += `<p>${escapeHtml(item.name)}: <strong>${item.available ? 'Tersedia' : 'Telah Digunakan'}</strong></p>`;
                    });
                }
                successHtml += '</div>';
                resultContainer.innerHTML = successHtml;
            } catch (error) {
                resultContainer.innerHTML = `
                    <div class="validation-result-card is-error">
                        <p class="validation-status-title"><i class="fas fa-times-circle" aria-hidden="true"></i> Validasi Gagal</p>
                        <p>${escapeHtml(error.message)}</p>
                    </div>`;
            } finally {
                if (submitButton) {
                    submitButton.disabled = false;
                    submitButton.textContent = 'Cek Akun';
                }
            }
        });
    }

    if (gameSelectorDropdown) {
        gameSelectorDropdown.addEventListener('change', () => {
            const selectedGameCode = gameSelectorDropdown.value;
            if (selectedGameCode) {
                const selectedGame = allValidatableGames.find(g => g.gameCode === selectedGameCode);
                if (selectedGame) renderValidationForm(selectedGame);
            } else {
                validatorTitle.textContent = 'Pilih Game dari Daftar';
                formContainer.innerHTML = '<div class="ui-state empty">Pilih game terlebih dahulu untuk menampilkan kolom User ID.</div>';
                resultContainer.innerHTML = '';
            }
        });
    }

    if (gameSearchInput) {
        gameSearchInput.addEventListener('input', () => {
            const searchTerm = gameSearchInput.value.toLowerCase();
            const filteredGames = allValidatableGames.filter(game => game.name && game.name.toLowerCase().includes(searchTerm));
            renderGamesDropdown(filteredGames);
        });
    }

    fetchValidatableGames();
});
