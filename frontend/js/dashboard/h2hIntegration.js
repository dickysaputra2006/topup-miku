(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    function resetH2HCopyButton(button) {
        if (!button) return;
        if (button._copyResetTimer) {
            clearTimeout(button._copyResetTimer);
            button._copyResetTimer = null;
        }
        if (button.dataset.defaultHtml) {
            button.innerHTML = button.dataset.defaultHtml;
        }
        button.disabled = false;
    }

    function attachH2HCopyButton(button, getValue) {
        const { showToast, copyToClipboard } = global.MikuShared.dom;
        if (!button) return;
        if (!button.dataset.defaultHtml) {
            button.dataset.defaultHtml = button.innerHTML;
        }
        button.addEventListener('click', async () => {
            const value = getValue();
            if (!value) return;
            try {
                await copyToClipboard(value);
                if (button._copyResetTimer) {
                    clearTimeout(button._copyResetTimer);
                }
                button.innerHTML = '<i class="fas fa-check"></i> Tersalin';
                button.disabled = true;
                showToast('Kredensial berhasil disalin ke clipboard.');
                button._copyResetTimer = setTimeout(() => {
                    resetH2HCopyButton(button);
                }, 1500);
            } catch (err) {
                showToast('Gagal menyalin otomatis. Silakan salin teks secara manual.');
            }
        });
    }

    function applyCredentialStatusUI({ badgeEl, displayEl, active, prefix, activeLabel, inactiveLabel, inactiveDisplay }) {
        if (badgeEl) {
            badgeEl.textContent = active ? activeLabel : inactiveLabel;
            badgeEl.className = active ? 'status-badge status-success' : 'status-badge status-inactive';
        }
        if (displayEl) {
            displayEl.textContent = active
                ? (prefix ? `${prefix}••••••••` : 'Aktif (prefix tidak tersedia)')
                : inactiveDisplay;
        }
    }

    function renderApiKeyState({ hasApiKey, prefix }) {
        const { apiKeyStatusBadge, apiKeyDisplay, generateApiKeyBtn, revokeApiKeyBtn } = app.state.els;
        app.state.currentHasApiKey = Boolean(hasApiKey);
        applyCredentialStatusUI({
            badgeEl: apiKeyStatusBadge,
            displayEl: apiKeyDisplay,
            active: app.state.currentHasApiKey,
            prefix,
            activeLabel: 'Aktif',
            inactiveLabel: 'Belum Aktif',
            inactiveDisplay: 'Belum ada API Key aktif. Klik tombol untuk membuat.'
        });
        if (generateApiKeyBtn) {
            generateApiKeyBtn.innerHTML = app.state.currentHasApiKey
                ? '<i class="fas fa-sync-alt"></i> Regenerate API Key'
                : '<i class="fas fa-key"></i> Generate API Key';
        }
        if (revokeApiKeyBtn) {
            revokeApiKeyBtn.classList.toggle('hidden', !app.state.currentHasApiKey);
            revokeApiKeyBtn.disabled = !app.state.currentHasApiKey;
        }
    }

    function renderWebhookSecretState({ hasWebhookSecret, prefix }) {
        const { webhookStatusBadge, webhookSecretDisplay, rotateWebhookSecretBtn } = app.state.els;
        app.state.currentHasWebhookSecret = Boolean(hasWebhookSecret);
        applyCredentialStatusUI({
            badgeEl: webhookStatusBadge,
            displayEl: webhookSecretDisplay,
            active: app.state.currentHasWebhookSecret,
            prefix,
            activeLabel: 'Aktif',
            inactiveLabel: 'Belum Dibuat',
            inactiveDisplay: 'Belum dibuat. Akan dibuat otomatis atau klik Putar Webhook Secret.'
        });
        if (rotateWebhookSecretBtn) {
            rotateWebhookSecretBtn.innerHTML = app.state.currentHasWebhookSecret
                ? '<i class="fas fa-shield-alt"></i> Putar Webhook Secret'
                : '<i class="fas fa-plus"></i> Buat Webhook Secret';
        }
    }

    function openH2HSecretModal({ title, primaryLabel, primaryValue, secondaryValue = '' }) {
        const {
            h2hSecretModal,
            h2hSecretModalTitle,
            h2hRevealedPrimaryLabel,
            h2hRevealedPrimaryValue,
            h2hCopyPrimaryBtn,
            h2hCopySecondaryBtn,
            h2hRevealedSecondaryGroup,
            h2hRevealedSecondaryValue,
        } = app.state.els;
        if (!h2hSecretModal || !h2hRevealedPrimaryValue) return;
        if (h2hSecretModalTitle) {
            h2hSecretModalTitle.textContent = title;
        }
        if (h2hRevealedPrimaryLabel) {
            h2hRevealedPrimaryLabel.textContent = primaryLabel;
        }
        h2hRevealedPrimaryValue.textContent = primaryValue || '';
        resetH2HCopyButton(h2hCopyPrimaryBtn);
        resetH2HCopyButton(h2hCopySecondaryBtn);

        if (h2hRevealedSecondaryGroup && h2hRevealedSecondaryValue) {
            if (secondaryValue) {
                h2hRevealedSecondaryValue.textContent = secondaryValue;
                h2hRevealedSecondaryGroup.classList.remove('hidden');
            } else {
                h2hRevealedSecondaryValue.textContent = '';
                h2hRevealedSecondaryGroup.classList.add('hidden');
            }
        }
        h2hSecretModal.classList.remove('hidden');
    }

    function closeH2HSecretModal() {
        const {
            h2hSecretModal,
            h2hRevealedPrimaryValue,
            h2hRevealedSecondaryValue,
            h2hRevealedSecondaryGroup,
            h2hCopyPrimaryBtn,
            h2hCopySecondaryBtn,
        } = app.state.els;
        if (!h2hSecretModal) return;
        h2hSecretModal.classList.add('hidden');
        if (h2hRevealedPrimaryValue) h2hRevealedPrimaryValue.textContent = '';
        if (h2hRevealedSecondaryValue) h2hRevealedSecondaryValue.textContent = '';
        if (h2hRevealedSecondaryGroup) h2hRevealedSecondaryGroup.classList.add('hidden');
        resetH2HCopyButton(h2hCopyPrimaryBtn);
        resetH2HCopyButton(h2hCopySecondaryBtn);
    }

    function closeH2HConfirmModal(force = false) {
        const { h2hConfirmModal, h2hConfirmAcceptBtn, h2hConfirmCancelBtn } = app.state.els;
        if (!h2hConfirmModal || (app.state.h2hActionBusy && !force)) return;
        app.state.pendingConfirmHandler = null;
        h2hConfirmModal.classList.add('hidden');
        if (h2hConfirmAcceptBtn) h2hConfirmAcceptBtn.disabled = false;
        if (h2hConfirmCancelBtn) h2hConfirmCancelBtn.disabled = false;
    }

    function openH2HConfirmModal({ title, message, confirmLabel = 'Lanjutkan', danger = true, onConfirm }) {
        const { h2hConfirmModal, h2hConfirmTitle, h2hConfirmMessage, h2hConfirmAcceptBtn, h2hConfirmCancelBtn } = app.state.els;
        if (!h2hConfirmModal || !h2hConfirmAcceptBtn) return;
        if (h2hConfirmTitle) h2hConfirmTitle.textContent = title;
        if (h2hConfirmMessage) h2hConfirmMessage.textContent = message;
        h2hConfirmAcceptBtn.textContent = confirmLabel;
        h2hConfirmAcceptBtn.classList.toggle('h2h-btn-danger', danger);
        h2hConfirmAcceptBtn.classList.toggle('h2h-btn-primary', !danger);
        h2hConfirmAcceptBtn.disabled = false;
        if (h2hConfirmCancelBtn) h2hConfirmCancelBtn.disabled = false;
        app.state.pendingConfirmHandler = onConfirm;
        h2hConfirmModal.classList.remove('hidden');
    }

    async function fetchApiKey() {
        const { apiKeyDisplay, apiKeyStatusBadge } = app.state.els;
        if (!apiKeyDisplay) return;
        apiKeyDisplay.textContent = 'Memuat status API Key...';
        try {
            const data = await app.requestUserApi('/apikey');
            renderApiKeyState({
                hasApiKey: data.hasApiKey,
                prefix: data.prefix
            });
            app.state.apiKeyFetched = true;
        } catch (error) {
            console.error(error);
            apiKeyDisplay.textContent = 'Gagal memuat status API Key.';
            if (apiKeyStatusBadge) {
                apiKeyStatusBadge.textContent = 'Gagal Muat';
                apiKeyStatusBadge.className = 'status-badge status-failed';
            }
        }
    }

    async function fetchWebhookSecretStatus() {
        const { webhookSecretDisplay, webhookStatusBadge } = app.state.els;
        if (!webhookSecretDisplay) return;
        webhookSecretDisplay.textContent = 'Memuat status Webhook Secret...';
        try {
            const data = await app.requestUserApi('/webhook-secret');
            renderWebhookSecretState({
                hasWebhookSecret: data.hasWebhookSecret,
                prefix: data.prefix
            });
        } catch (error) {
            console.error(error);
            webhookSecretDisplay.textContent = 'Gagal memuat status Webhook Secret.';
            if (webhookStatusBadge) {
                webhookStatusBadge.textContent = 'Gagal Muat';
                webhookStatusBadge.className = 'status-badge status-failed';
            }
        }
    }

    async function fetchAndDisplayWhitelistedIPs() {
        const { escapeHtml } = global.MikuShared.dom;
        const ipListContainer = document.getElementById('current-ips-list');
        const ipInput = document.getElementById('whitelist-ip-input');
        if (!ipListContainer || !ipInput) return;

        try {
            const ips = await app.requestUserApi('/whitelisted-ips');

            ipListContainer.innerHTML = '';
            if (ips.length > 0) {
                ips.forEach(ip => {
                    const ipTag = document.createElement('div');
                    ipTag.className = 'ip-tag';
                    ipTag.innerHTML = `
                    <span>${escapeHtml(ip)}</span>
                    <button type="button" class="ip-tag-delete" data-ip="${escapeHtml(ip)}" title="Hapus IP">&times;</button>
                `;
                    ipListContainer.appendChild(ipTag);
                });
            } else {
                ipListContainer.innerHTML = '<p class="h2h-muted">Belum ada IP yang didaftarkan.</p>';
            }
        } catch (error) {
            console.error(error);
            ipListContainer.innerHTML = `<div class="ui-state error">${escapeHtml(error.message)}</div>`;
        }
    }

    async function saveWhitelistedIps(ips) {
        const { showToast } = global.MikuShared.dom;
        const result = await app.requestUserApi('/whitelisted-ips', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips })
        });
        showToast(result.message || 'Daftar IP whitelist diperbarui.');
        await fetchAndDisplayWhitelistedIPs();
        return result;
    }

    /**
     * Muat status API Key, Webhook Secret, dan IP whitelist untuk section Integrasi H2H.
     */
    function loadIntegrasiSectionData() {
        fetchApiKey();
        fetchWebhookSecretStatus();
        fetchAndDisplayWhitelistedIPs();
    }

    async function executeGenerateOrRegenerate(isRegenerate) {
        const { showToast } = global.MikuShared.dom;
        const { generateApiKeyBtn } = app.state.els;
        if (generateApiKeyBtn) generateApiKeyBtn.disabled = true;
        try {
            const endpoint = isRegenerate ? '/apikey/regenerate' : '/generate-apikey';
            const result = await app.requestUserApi(endpoint, { method: 'POST' });
            renderApiKeyState({
                hasApiKey: result.hasApiKey !== undefined ? result.hasApiKey : true,
                prefix: result.prefix
            });
            app.state.apiKeyFetched = true;
            if (result.webhookSecret) {
                await fetchWebhookSecretStatus();
            }
            closeH2HConfirmModal(true);
            openH2HSecretModal({
                title: result.webhookSecret
                    ? 'API Key & Webhook Secret Baru'
                    : (isRegenerate ? 'API Key Baru (Regenerate)' : 'API Key H2H Baru'),
                primaryLabel: 'API Key H2H (tampil sekali)',
                primaryValue: result.apiKey,
                secondaryValue: result.webhookSecret || ''
            });
            showToast(result.message || 'API Key berhasil dibuat.');
        } catch (error) {
            showToast(`Error: ${error.message}`);
        } finally {
            if (generateApiKeyBtn) generateApiKeyBtn.disabled = false;
        }
    }

    async function executeRotateWebhookSecret() {
        const { showToast } = global.MikuShared.dom;
        const { rotateWebhookSecretBtn } = app.state.els;
        if (rotateWebhookSecretBtn) rotateWebhookSecretBtn.disabled = true;
        try {
            const result = await app.requestUserApi('/webhook-secret/rotate', { method: 'POST' });
            renderWebhookSecretState({
                hasWebhookSecret: result.hasWebhookSecret !== undefined ? result.hasWebhookSecret : true,
                prefix: result.prefix
            });
            closeH2HConfirmModal(true);
            openH2HSecretModal({
                title: 'Webhook Secret Baru',
                primaryLabel: 'Webhook Secret HMAC-SHA256 (tampil sekali)',
                primaryValue: result.webhookSecret
            });
            showToast(result.message || 'Webhook Secret berhasil diperbarui.');
        } catch (error) {
            showToast(`Error: ${error.message}`);
        } finally {
            if (rotateWebhookSecretBtn) rotateWebhookSecretBtn.disabled = false;
        }
    }

    /**
     * Pasang seluruh event listener modal kredensial H2H, API Key, Webhook Secret, dan IP Whitelist.
     */
    function bindEvents() {
        const { showToast } = global.MikuShared.dom;
        const {
            h2hCopyPrimaryBtn,
            h2hCopySecondaryBtn,
            h2hRevealedPrimaryValue,
            h2hRevealedSecondaryValue,
            closeH2HSecretModalBtn,
            h2hAckSecretModalBtn,
            closeH2HConfirmModalBtn,
            h2hConfirmCancelBtn,
            h2hConfirmModal,
            h2hConfirmAcceptBtn,
            generateApiKeyBtn,
            revokeApiKeyBtn,
            rotateWebhookSecretBtn,
            whitelistIpForm,
            currentIpsList,
        } = app.state.els;

        attachH2HCopyButton(h2hCopyPrimaryBtn, () => (h2hRevealedPrimaryValue ? h2hRevealedPrimaryValue.textContent.trim() : ''));
        attachH2HCopyButton(h2hCopySecondaryBtn, () => (h2hRevealedSecondaryValue ? h2hRevealedSecondaryValue.textContent.trim() : ''));

        if (closeH2HSecretModalBtn) {
            closeH2HSecretModalBtn.addEventListener('click', closeH2HSecretModal);
        }
        if (h2hAckSecretModalBtn) {
            h2hAckSecretModalBtn.addEventListener('click', closeH2HSecretModal);
        }
        if (closeH2HConfirmModalBtn) {
            closeH2HConfirmModalBtn.addEventListener('click', () => closeH2HConfirmModal());
        }
        if (h2hConfirmCancelBtn) {
            h2hConfirmCancelBtn.addEventListener('click', () => closeH2HConfirmModal());
        }
        if (h2hConfirmModal) {
            h2hConfirmModal.addEventListener('click', (e) => {
                if (e.target === h2hConfirmModal) closeH2HConfirmModal();
            });
        }
        if (h2hConfirmAcceptBtn) {
            h2hConfirmAcceptBtn.addEventListener('click', async () => {
                if (!app.state.pendingConfirmHandler || app.state.h2hActionBusy) return;
                const action = app.state.pendingConfirmHandler;
                app.state.h2hActionBusy = true;
                h2hConfirmAcceptBtn.disabled = true;
                if (h2hConfirmCancelBtn) h2hConfirmCancelBtn.disabled = true;
                try {
                    await action();
                } finally {
                    app.state.h2hActionBusy = false;
                    closeH2HConfirmModal(true);
                }
            });
        }

        if (generateApiKeyBtn) {
            generateApiKeyBtn.addEventListener('click', () => {
                if (app.state.currentHasApiKey) {
                    openH2HConfirmModal({
                        title: 'Buat Ulang API Key H2H?',
                        message: 'API Key lama akan segera dinonaktifkan dan tidak dapat digunakan lagi. Pastikan Anda memperbarui konfigurasi integrasi H2H Anda setelah key baru dibuat.',
                        confirmLabel: 'Ya, Buat Ulang Key',
                        danger: true,
                        onConfirm: () => executeGenerateOrRegenerate(true)
                    });
                    return;
                }
                executeGenerateOrRegenerate(false);
            });
        }

        if (revokeApiKeyBtn) {
            revokeApiKeyBtn.addEventListener('click', () => {
                if (!app.state.currentHasApiKey) return;
                openH2HConfirmModal({
                    title: 'Cabut API Key H2H?',
                    message: 'API Key yang aktif akan langsung dicabut. Semua request ke /h2h/* menggunakan key ini akan ditolak sampai Anda membuat API Key baru.',
                    confirmLabel: 'Ya, Cabut API Key',
                    danger: true,
                    onConfirm: async () => {
                        if (revokeApiKeyBtn) revokeApiKeyBtn.disabled = true;
                        try {
                            const result = await app.requestUserApi('/apikey', { method: 'DELETE' });
                            renderApiKeyState({
                                hasApiKey: result.hasApiKey,
                                prefix: result.prefix
                            });
                            showToast(result.message || 'API Key berhasil dicabut.');
                        } catch (error) {
                            showToast(`Error: ${error.message}`);
                        } finally {
                            if (revokeApiKeyBtn) revokeApiKeyBtn.disabled = !app.state.currentHasApiKey;
                        }
                    }
                });
            });
        }

        if (rotateWebhookSecretBtn) {
            rotateWebhookSecretBtn.addEventListener('click', () => {
                if (app.state.currentHasWebhookSecret) {
                    openH2HConfirmModal({
                        title: 'Putar Webhook Secret?',
                        message: 'Webhook Secret lama akan langsung diganti dengan secret baru. Webhook berikutnya akan ditandatangani menggunakan secret baru ini.',
                        confirmLabel: 'Ya, Putar Secret',
                        danger: true,
                        onConfirm: executeRotateWebhookSecret
                    });
                    return;
                }
                executeRotateWebhookSecret();
            });
        }

        if (whitelistIpForm) {
            whitelistIpForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const input = document.getElementById('whitelist-ip-input');
                const submitButton = whitelistIpForm.querySelector('button[type="submit"]');

                const existingIpTags = document.querySelectorAll('#current-ips-list .ip-tag span');
                const existingIps = Array.from(existingIpTags).map(tag => tag.textContent);
                const newIpsFromInput = input.value.split(',').map(ip => ip.trim()).filter(Boolean);
                if (newIpsFromInput.length === 0) {
                    showToast('Masukkan alamat IP atau rentang CIDR terlebih dahulu.');
                    return;
                }
                const combinedIps = [...new Set([...existingIps, ...newIpsFromInput])];

                if (submitButton) submitButton.disabled = true;
                try {
                    await saveWhitelistedIps(combinedIps);
                    input.value = '';
                } catch (error) {
                    showToast(`Error: ${error.message}`);
                } finally {
                    if (submitButton) submitButton.disabled = false;
                }
            });
        }

        if (currentIpsList) {
            currentIpsList.addEventListener('click', (e) => {
                if (!e.target.matches('.ip-tag-delete, .ip-tag-delete *')) return;
                const button = e.target.closest('.ip-tag-delete');
                const ipToDelete = button.dataset.ip;

                openH2HConfirmModal({
                    title: 'Hapus IP Whitelist?',
                    message: `Anda yakin ingin menghapus "${ipToDelete}" dari daftar IP whitelist H2H?`,
                    confirmLabel: 'Ya, Hapus IP',
                    danger: true,
                    onConfirm: async () => {
                        const currentIpTags = document.querySelectorAll('#current-ips-list .ip-tag span');
                        const currentIps = Array.from(currentIpTags).map(tag => tag.textContent);
                        const newIps = currentIps.filter(ip => ip !== ipToDelete);

                        try {
                            await saveWhitelistedIps(newIps);
                        } catch (error) {
                            showToast(`Error: ${error.message}`);
                        }
                    }
                });
            });
        }
    }

    app.h2h = {
        loadIntegrasiSectionData,
        bindEvents,
    };
})(window);
