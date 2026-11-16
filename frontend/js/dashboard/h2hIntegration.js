(function (global) {
    'use strict';

    const app = (global.MikuDashboard = global.MikuDashboard || {});

    const SAMPLE_ORDER_PAYLOAD = JSON.stringify(
        { productId: 1, targetGameId: '12345678', targetServerId: '2001', ref_id: 'ORDER-UNIK-001' },
        null,
        2
    );

    function resetH2HCopyButton(button) {
        if (!button) return;
        if (button._copyResetTimer) {
            clearTimeout(button._copyResetTimer);
            button._copyResetTimer = null;
        }
        if (button.dataset.defaultHtml) button.innerHTML = button.dataset.defaultHtml;
        button.disabled = false;
    }

    function attachH2HCopyButton(button, getValue, fallbackMsg) {
        const { showToast, copyToClipboard } = global.MikuShared.dom;
        if (!button) return;
        if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML;
        button.addEventListener('click', async () => {
            const value = getValue();
            if (!value) {
                if (fallbackMsg) showToast(fallbackMsg);
                return;
            }
            try {
                await copyToClipboard(value);
                if (button._copyResetTimer) clearTimeout(button._copyResetTimer);
                button.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i> Tersalin';
                button.disabled = true;
                showToast('Teks berhasil disalin ke clipboard.');
                button._copyResetTimer = setTimeout(() => resetH2HCopyButton(button), 1500);
            } catch (_) {
                showToast('Gagal menyalin otomatis. Silakan salin teks secara manual.');
            }
        });
    }

    function isValidIpv4(ip) {
        const parts = ip.split('.');
        if (parts.length !== 4) return false;
        return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255 && String(Number(p)) === p);
    }

    function isValidIpOrCidrClient(raw) {
        const value = String(raw || '').trim();
        if (!value || value.length > 64) return false;
        const slashIdx = value.indexOf('/');
        const ipPart = slashIdx >= 0 ? value.slice(0, slashIdx) : value;
        const prefixStr = slashIdx >= 0 ? value.slice(slashIdx + 1) : null;
        if (isValidIpv4(ipPart)) {
            return prefixStr === null || (/^\d{1,2}$/.test(prefixStr) && Number(prefixStr) >= 0 && Number(prefixStr) <= 32);
        }
        if (ipPart.includes(':') && /^[0-9a-fA-F:]+$/.test(ipPart)) {
            return prefixStr === null || (/^\d{1,3}$/.test(prefixStr) && Number(prefixStr) >= 0 && Number(prefixStr) <= 128);
        }
        return false;
    }

    function validateCallbackUrlClient(rawUrl) {
        const trimmed = String(rawUrl || '').trim();
        if (!trimmed) return { valid: false, message: 'Masukkan Callback URL terlebih dahulu.' };
        try {
            const parsed = new URL(trimmed);
            if (parsed.protocol !== 'https:') {
                return { valid: false, message: 'Callback URL wajib memakai protokol https:// demi keamanan.' };
            }
            const host = parsed.hostname.toLowerCase();
            if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
                return { valid: false, message: 'Gunakan domain publik HTTPS yang dapat dijangkau server.' };
            }
            return { valid: true, url: parsed.toString() };
        } catch (_) {
            return { valid: false, message: 'Format URL tidak valid. Contoh: https://domainanda.com/webhook' };
        }
    }

    function applyCredentialStatusUI({ badgeEl, displayEl, active, prefix, activeLabel, inactiveLabel, inactiveDisplay }) {
        if (badgeEl) {
            badgeEl.textContent = active ? activeLabel : inactiveLabel;
            badgeEl.className = active ? 'status-badge status-success' : 'status-badge status-inactive';
        }
        if (displayEl) {
            displayEl.textContent = active ? (prefix ? `${prefix}••••••••••••••••` : 'Aktif (prefix tidak tersedia)') : inactiveDisplay;
        }
    }

    function renderApiKeyState({ hasApiKey, prefix }) {
        const { apiKeyStatusBadge, apiKeyDisplay, generateApiKeyBtn, revokeApiKeyBtn } = app.state.els;
        app.state.currentHasApiKey = Boolean(hasApiKey);
        app.state.currentApiKeyPrefix = prefix || '';
        applyCredentialStatusUI({
            badgeEl: apiKeyStatusBadge, displayEl: apiKeyDisplay, active: app.state.currentHasApiKey, prefix,
            activeLabel: 'Aktif', inactiveLabel: 'Belum Aktif',
            inactiveDisplay: 'Belum ada API Key aktif. Klik Buat API Key untuk memulai.',
        });
        if (generateApiKeyBtn) {
            generateApiKeyBtn.innerHTML = app.state.currentHasApiKey
                ? '<i class="fas fa-sync-alt" aria-hidden="true"></i> Rotate API Key'
                : '<i class="fas fa-key" aria-hidden="true"></i> Buat API Key';
        }
        if (revokeApiKeyBtn) {
            revokeApiKeyBtn.classList.toggle('hidden', !app.state.currentHasApiKey);
            revokeApiKeyBtn.disabled = !app.state.currentHasApiKey;
        }
    }

    function syncWebhookSecretDisplay() {
        const { webhookSecretDisplay, toggleWebhookSecretBtn, copyWebhookSecretBtn } = app.state.els;
        const hasSession = Boolean(app.state.sessionWebhookSecret);
        const prefix = app.state.currentWebhookPrefix || '';
        if (webhookSecretDisplay && app.state.currentHasWebhookSecret) {
            webhookSecretDisplay.textContent = (app.state.showSessionWebhookSecret && hasSession)
                ? app.state.sessionWebhookSecret
                : (prefix ? `${prefix}••••••••••••••••` : 'Aktif (ter-mask)');
        }
        if (toggleWebhookSecretBtn) {
            const shown = Boolean(app.state.showSessionWebhookSecret && hasSession);
            toggleWebhookSecretBtn.classList.toggle('hidden', !app.state.currentHasWebhookSecret);
            toggleWebhookSecretBtn.textContent = shown ? 'Sembunyikan' : 'Tampilkan';
            toggleWebhookSecretBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
        }
        if (copyWebhookSecretBtn) {
            copyWebhookSecretBtn.classList.toggle('hidden', !app.state.currentHasWebhookSecret);
        }
    }

    function renderWebhookSecretState({ hasWebhookSecret, prefix }) {
        const { webhookStatusBadge, webhookSecretDisplay, rotateWebhookSecretBtn } = app.state.els;
        app.state.currentHasWebhookSecret = Boolean(hasWebhookSecret);
        app.state.currentWebhookPrefix = prefix || '';
        applyCredentialStatusUI({
            badgeEl: webhookStatusBadge, displayEl: webhookSecretDisplay, active: app.state.currentHasWebhookSecret, prefix,
            activeLabel: 'Aktif', inactiveLabel: 'Belum Dibuat',
            inactiveDisplay: 'Belum dibuat. Akan dibuat otomatis bersama API Key atau klik Putar Secret.',
        });
        if (!app.state.currentHasWebhookSecret) {
            app.state.sessionWebhookSecret = '';
            app.state.showSessionWebhookSecret = false;
        }
        syncWebhookSecretDisplay();
        if (rotateWebhookSecretBtn) {
            rotateWebhookSecretBtn.innerHTML = app.state.currentHasWebhookSecret
                ? '<i class="fas fa-rotate" aria-hidden="true"></i> Rotate Webhook Secret'
                : '<i class="fas fa-plus" aria-hidden="true"></i> Buat Webhook Secret';
        }
    }

    function openH2HSecretModal({ title, primaryLabel, primaryValue, secondaryValue = '' }) {
        const els = app.state.els;
        if (!els.h2hSecretModal || !els.h2hRevealedPrimaryValue) return;
        if (els.h2hSecretModalTitle) els.h2hSecretModalTitle.textContent = title;
        if (els.h2hRevealedPrimaryLabel) els.h2hRevealedPrimaryLabel.textContent = primaryLabel;
        els.h2hRevealedPrimaryValue.textContent = primaryValue || '';
        resetH2HCopyButton(els.h2hCopyPrimaryBtn);
        resetH2HCopyButton(els.h2hCopySecondaryBtn);
        if (els.h2hRevealedSecondaryGroup && els.h2hRevealedSecondaryValue) {
            els.h2hRevealedSecondaryValue.textContent = secondaryValue || '';
            els.h2hRevealedSecondaryGroup.classList.toggle('hidden', !secondaryValue);
        }
        els.h2hSecretModal.classList.remove('hidden');
    }

    function closeH2HSecretModal() {
        const els = app.state.els;
        if (!els.h2hSecretModal) return;
        els.h2hSecretModal.classList.add('hidden');
        if (els.h2hRevealedPrimaryValue) els.h2hRevealedPrimaryValue.textContent = '';
        if (els.h2hRevealedSecondaryValue) els.h2hRevealedSecondaryValue.textContent = '';
        if (els.h2hRevealedSecondaryGroup) els.h2hRevealedSecondaryGroup.classList.add('hidden');
        resetH2HCopyButton(els.h2hCopyPrimaryBtn);
        resetH2HCopyButton(els.h2hCopySecondaryBtn);
    }

    function closeH2HConfirmModal(force = false) {
        const els = app.state.els;
        if (!els.h2hConfirmModal || (app.state.h2hActionBusy && !force)) return;
        app.state.pendingConfirmHandler = null;
        els.h2hConfirmModal.classList.add('hidden');
        if (els.h2hConfirmAcceptBtn) els.h2hConfirmAcceptBtn.disabled = false;
        if (els.h2hConfirmCancelBtn) els.h2hConfirmCancelBtn.disabled = false;
    }

    function openH2HConfirmModal({ title, message, confirmLabel = 'Lanjutkan', danger = true, onConfirm }) {
        const els = app.state.els;
        if (!els.h2hConfirmModal || !els.h2hConfirmAcceptBtn) return;
        if (els.h2hConfirmTitle) els.h2hConfirmTitle.textContent = title;
        if (els.h2hConfirmMessage) els.h2hConfirmMessage.textContent = message;
        els.h2hConfirmAcceptBtn.textContent = confirmLabel;
        els.h2hConfirmAcceptBtn.classList.toggle('h2h-btn-danger', danger);
        els.h2hConfirmAcceptBtn.classList.toggle('h2h-btn-primary', !danger);
        els.h2hConfirmAcceptBtn.disabled = false;
        if (els.h2hConfirmCancelBtn) els.h2hConfirmCancelBtn.disabled = false;
        app.state.pendingConfirmHandler = onConfirm;
        els.h2hConfirmModal.classList.remove('hidden');
    }

    async function fetchCredentialStatus({ endpoint, displayEl, badgeEl, loadingText, errorText, onSuccess }) {
        if (!displayEl) return;
        displayEl.textContent = loadingText;
        try {
            const data = await app.requestUserApi(endpoint);
            onSuccess(data);
        } catch (error) {
            console.error(error);
            displayEl.textContent = errorText;
            if (badgeEl) {
                badgeEl.textContent = 'Gagal Muat';
                badgeEl.className = 'status-badge status-failed';
            }
        }
    }

    function fetchApiKey() {
        return fetchCredentialStatus({
            endpoint: '/apikey',
            displayEl: app.state.els.apiKeyDisplay,
            badgeEl: app.state.els.apiKeyStatusBadge,
            loadingText: 'Memuat status API Key...',
            errorText: 'Gagal memuat status API Key.',
            onSuccess: (data) => {
                renderApiKeyState({ hasApiKey: data.hasApiKey, prefix: data.prefix });
                app.state.apiKeyFetched = true;
            },
        });
    }

    function fetchWebhookSecretStatus() {
        return fetchCredentialStatus({
            endpoint: '/webhook-secret',
            displayEl: app.state.els.webhookSecretDisplay,
            badgeEl: app.state.els.webhookStatusBadge,
            loadingText: 'Memuat status Webhook Secret...',
            errorText: 'Gagal memuat status Webhook Secret.',
            onSuccess: (data) => renderWebhookSecretState({ hasWebhookSecret: data.hasWebhookSecret, prefix: data.prefix }),
        });
    }

    async function fetchAndDisplayWhitelistedIPs() {
        const { escapeHtml } = global.MikuShared.dom;
        const ipListContainer = document.getElementById('current-ips-list');
        if (!ipListContainer) return;
        try {
            const ips = await app.requestUserApi('/whitelisted-ips');
            ipListContainer.innerHTML = '';
            if (Array.isArray(ips) && ips.length > 0) {
                ips.forEach(ip => {
                    const ipTag = document.createElement('div');
                    ipTag.className = 'ip-tag';
                    ipTag.innerHTML = `<span>${escapeHtml(ip)}</span><button type="button" class="ip-tag-delete" data-ip="${escapeHtml(ip)}" aria-label="Hapus IP ${escapeHtml(ip)}">&times;</button>`;
                    ipListContainer.appendChild(ipTag);
                });
            } else {
                ipListContainer.innerHTML = '<div class="h2h-empty-ips">Belum ada IP terdaftar. Tambahkan IP server atau rentang CIDR Anda di atas untuk membatasi akses API Key H2H.</div>';
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
            body: JSON.stringify({ ips }),
        });
        showToast(result.message || 'Daftar IP whitelist diperbarui.');
        await fetchAndDisplayWhitelistedIPs();
        return result;
    }

    function populateQuickReference() {
        const baseUrlEl = document.getElementById('h2h-base-url');
        const payloadSampleEl = document.getElementById('h2h-sample-payload');
        const origin = (global.location && global.location.origin && global.location.origin !== 'null')
            ? global.location.origin
            : 'https://domain-toko-anda.com';
        if (baseUrlEl) baseUrlEl.textContent = origin;
        if (payloadSampleEl) payloadSampleEl.textContent = SAMPLE_ORDER_PAYLOAD;
    }

    /**
     * Muat status API Key, Webhook Secret, IP whitelist, dan referensi cepat untuk tab Integrasi H2H.
     */
    function loadIntegrasiSectionData() {
        populateQuickReference();
        fetchApiKey();
        fetchWebhookSecretStatus();
        fetchAndDisplayWhitelistedIPs();
    }

    async function executeGenerateOrRegenerate(isRegenerate) {
        const { showToast } = global.MikuShared.dom;
        const { generateApiKeyBtn, h2hCallbackApiKeyInput } = app.state.els;
        if (generateApiKeyBtn) generateApiKeyBtn.disabled = true;
        try {
            const result = await app.requestUserApi(isRegenerate ? '/apikey/regenerate' : '/generate-apikey', { method: 'POST' });
            app.state.sessionApiKey = result.apiKey || '';
            if (h2hCallbackApiKeyInput && app.state.sessionApiKey) h2hCallbackApiKeyInput.value = app.state.sessionApiKey;
            renderApiKeyState({ hasApiKey: result.hasApiKey !== undefined ? result.hasApiKey : true, prefix: result.prefix });
            app.state.apiKeyFetched = true;
            if (result.webhookSecret) {
                app.state.sessionWebhookSecret = result.webhookSecret;
                app.state.showSessionWebhookSecret = false;
                renderWebhookSecretState({ hasWebhookSecret: true, prefix: result.webhookSecret.slice(0, 8) });
            }
            closeH2HConfirmModal(true);
            openH2HSecretModal({
                title: result.webhookSecret ? 'API Key & Webhook Secret Baru' : (isRegenerate ? 'API Key Baru (Rotate)' : 'API Key H2H Baru'),
                primaryLabel: 'API Key H2H (tampil sekali)',
                primaryValue: result.apiKey,
                secondaryValue: result.webhookSecret || '',
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
            app.state.sessionWebhookSecret = result.webhookSecret || '';
            app.state.showSessionWebhookSecret = false;
            renderWebhookSecretState({ hasWebhookSecret: result.hasWebhookSecret !== undefined ? result.hasWebhookSecret : true, prefix: result.prefix });
            closeH2HConfirmModal(true);
            openH2HSecretModal({
                title: 'Webhook Secret Baru',
                primaryLabel: 'Webhook Secret HMAC-SHA256 (tampil sekali)',
                primaryValue: result.webhookSecret,
            });
            showToast(result.message || 'Webhook Secret berhasil diperbarui.');
        } catch (error) {
            showToast(`Error: ${error.message}`);
        } finally {
            if (rotateWebhookSecretBtn) rotateWebhookSecretBtn.disabled = false;
        }
    }

    function bindModalAndCopyEvents() {
        const els = app.state.els;
        attachH2HCopyButton(els.h2hCopyPrimaryBtn, () => (els.h2hRevealedPrimaryValue ? els.h2hRevealedPrimaryValue.textContent.trim() : ''));
        attachH2HCopyButton(els.h2hCopySecondaryBtn, () => (els.h2hRevealedSecondaryValue ? els.h2hRevealedSecondaryValue.textContent.trim() : ''));
        attachH2HCopyButton(document.getElementById('h2h-copy-baseurl-btn'), () => {
            const el = document.getElementById('h2h-base-url');
            return el ? el.textContent.trim() : '';
        });
        attachH2HCopyButton(document.getElementById('h2h-copy-header-btn'), () => 'X-API-Key: <API_KEY_ANDA>');
        attachH2HCopyButton(document.getElementById('h2h-copy-payload-btn'), () => SAMPLE_ORDER_PAYLOAD);
        attachH2HCopyButton(
            els.copyWebhookSecretBtn,
            () => app.state.sessionWebhookSecret || '',
            'Demi keamanan, nilai secret penuh hanya tersedia sesaat setelah rotasi. Klik Rotate untuk membuat secret baru.'
        );
        if (els.closeH2HSecretModalBtn) els.closeH2HSecretModalBtn.addEventListener('click', closeH2HSecretModal);
        if (els.h2hAckSecretModalBtn) els.h2hAckSecretModalBtn.addEventListener('click', closeH2HSecretModal);
        if (els.closeH2HConfirmModalBtn) els.closeH2HConfirmModalBtn.addEventListener('click', () => closeH2HConfirmModal());
        if (els.h2hConfirmCancelBtn) els.h2hConfirmCancelBtn.addEventListener('click', () => closeH2HConfirmModal());
        if (els.h2hConfirmModal) {
            els.h2hConfirmModal.addEventListener('click', (e) => { if (e.target === els.h2hConfirmModal) closeH2HConfirmModal(); });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeH2HSecretModal(); closeH2HConfirmModal(); }
        });
        if (els.h2hConfirmAcceptBtn) {
            els.h2hConfirmAcceptBtn.addEventListener('click', async () => {
                if (!app.state.pendingConfirmHandler || app.state.h2hActionBusy) return;
                const action = app.state.pendingConfirmHandler;
                app.state.h2hActionBusy = true;
                els.h2hConfirmAcceptBtn.disabled = true;
                if (els.h2hConfirmCancelBtn) els.h2hConfirmCancelBtn.disabled = true;
                try { await action(); } finally { app.state.h2hActionBusy = false; closeH2HConfirmModal(true); }
            });
        }
    }

    function bindCredentialActionEvents() {
        const { showToast } = global.MikuShared.dom;
        const { generateApiKeyBtn, revokeApiKeyBtn, rotateWebhookSecretBtn, toggleWebhookSecretBtn } = app.state.els;

        if (toggleWebhookSecretBtn) {
            toggleWebhookSecretBtn.addEventListener('click', () => {
                if (!app.state.sessionWebhookSecret) {
                    showToast('Demi keamanan, hanya prefix yang tampil setelah muat ulang halaman. Putar Webhook Secret untuk membuat secret baru.');
                    return;
                }
                app.state.showSessionWebhookSecret = !app.state.showSessionWebhookSecret;
                syncWebhookSecretDisplay();
            });
        }
        if (generateApiKeyBtn) {
            generateApiKeyBtn.addEventListener('click', () => {
                if (!app.state.currentHasApiKey) return executeGenerateOrRegenerate(false);
                openH2HConfirmModal({
                    title: 'Rotate API Key H2H?',
                    message: 'API Key lama langsung dinonaktifkan. Pastikan Anda memperbarui header X-API-Key di sistem reseller setelah key baru dibuat.',
                    confirmLabel: 'Ya, Rotate Key', danger: true, onConfirm: () => executeGenerateOrRegenerate(true),
                });
            });
        }
        if (revokeApiKeyBtn) {
            revokeApiKeyBtn.addEventListener('click', () => {
                if (!app.state.currentHasApiKey) return;
                openH2HConfirmModal({
                    title: 'Revoke API Key H2H?',
                    message: 'API Key aktif akan langsung dicabut. Semua request ke /h2h/* akan ditolak hingga Anda membuat API Key baru.',
                    confirmLabel: 'Ya, Revoke API Key', danger: true,
                    onConfirm: async () => {
                        revokeApiKeyBtn.disabled = true;
                        try {
                            const result = await app.requestUserApi('/apikey', { method: 'DELETE' });
                            app.state.sessionApiKey = '';
                            renderApiKeyState({ hasApiKey: result.hasApiKey, prefix: result.prefix });
                            showToast(result.message || 'API Key berhasil dicabut.');
                        } catch (error) {
                            showToast(`Error: ${error.message}`);
                        } finally {
                            revokeApiKeyBtn.disabled = !app.state.currentHasApiKey;
                        }
                    },
                });
            });
        }
        if (rotateWebhookSecretBtn) {
            rotateWebhookSecretBtn.addEventListener('click', () => {
                if (!app.state.currentHasWebhookSecret) return executeRotateWebhookSecret();
                openH2HConfirmModal({
                    title: 'Rotate Webhook Secret?',
                    message: 'Secret lama akan langsung diganti dengan secret baru. Callback berikutnya ditandatangani dengan secret baru.',
                    confirmLabel: 'Ya, Rotate Secret', danger: true, onConfirm: executeRotateWebhookSecret,
                });
            });
        }
    }

    function bindCallbackAndIpEvents() {
        const { showToast, escapeHtml, uiState } = global.MikuShared.dom;
        const { apiFetch } = global.MikuShared.api;
        const { h2hCallbackForm, h2hCallbackUrlInput, h2hCallbackApiKeyInput, h2hCallbackResultEl, whitelistIpForm, currentIpsList } = app.state.els;

        if (h2hCallbackForm && h2hCallbackUrlInput && h2hCallbackResultEl) {
            h2hCallbackUrlInput.addEventListener('input', () => { h2hCallbackResultEl.innerHTML = ''; });
            h2hCallbackForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const check = validateCallbackUrlClient(h2hCallbackUrlInput.value);
                if (!check.valid) { h2hCallbackResultEl.innerHTML = uiState(escapeHtml(check.message), 'error'); return; }
                const apiKey = (h2hCallbackApiKeyInput && h2hCallbackApiKeyInput.value.trim()) || app.state.sessionApiKey;
                if (!apiKey) {
                    h2hCallbackResultEl.innerHTML = uiState('Tempel X-API-Key Anda pada kolom verifikasi atau panggil PUT /h2h/profile/callback langsung dari server reseller.', 'error');
                    return;
                }
                const submitBtn = h2hCallbackForm.querySelector('button[type="submit"]');
                if (submitBtn) submitBtn.disabled = true;
                h2hCallbackResultEl.innerHTML = uiState('Menyimpan Callback URL...', 'loading');
                try {
                    const response = await apiFetch('/h2h/profile/callback', { method: 'PUT', headers: { 'X-API-Key': apiKey }, jsonBody: { callback_url: check.url } });
                    const resJson = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(resJson.message || 'Gagal memperbarui Callback URL.');
                    h2hCallbackResultEl.innerHTML = uiState(escapeHtml(resJson.message || 'Callback URL berhasil diperbarui.'), 'success');
                    showToast('Callback URL berhasil disimpan.');
                } catch (error) {
                    h2hCallbackResultEl.innerHTML = uiState(escapeHtml(error.message), 'error');
                } finally {
                    if (submitBtn) submitBtn.disabled = false;
                }
            });
        }

        if (whitelistIpForm) {
            const ipInput = document.getElementById('whitelist-ip-input');
            const ipErrorEl = document.getElementById('whitelist-ip-error');
            const setIpErr = (msg) => { if (ipErrorEl) { ipErrorEl.textContent = msg; ipErrorEl.classList.remove('hidden'); } };
            if (ipInput && ipErrorEl) ipInput.addEventListener('input', () => ipErrorEl.classList.add('hidden'));
            whitelistIpForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const submitButton = whitelistIpForm.querySelector('button[type="submit"]');
                const existingIps = Array.from(document.querySelectorAll('#current-ips-list .ip-tag span')).map(tag => tag.textContent);
                const newIps = (ipInput ? ipInput.value : '').split(',').map(ip => ip.trim()).filter(Boolean);
                if (newIps.length === 0) return setIpErr('Masukkan minimal satu IP atau CIDR (contoh: 203.0.113.10).');
                const invalidEntry = newIps.find(entry => !isValidIpOrCidrClient(entry));
                if (invalidEntry) return setIpErr(`Format IP/CIDR tidak valid: "${invalidEntry}"`);
                const combinedIps = [...new Set([...existingIps, ...newIps])];
                if (combinedIps.length > 20) return setIpErr('Maksimal 20 alamat IP dalam allowlist.');
                if (submitButton) submitButton.disabled = true;
                try {
                    await saveWhitelistedIps(combinedIps);
                    if (ipInput) ipInput.value = '';
                    if (ipErrorEl) ipErrorEl.classList.add('hidden');
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
                const ipToDelete = e.target.closest('.ip-tag-delete').dataset.ip;
                openH2HConfirmModal({
                    title: 'Hapus IP Allowlist?',
                    message: `Anda yakin ingin menghapus "${ipToDelete}" dari daftar IP allowlist H2H?`,
                    confirmLabel: 'Ya, Hapus IP', danger: true,
                    onConfirm: async () => {
                        const currentIps = Array.from(document.querySelectorAll('#current-ips-list .ip-tag span')).map(tag => tag.textContent);
                        try {
                            await saveWhitelistedIps(currentIps.filter(ip => ip !== ipToDelete));
                        } catch (error) {
                            showToast(`Error: ${error.message}`);
                        }
                    },
                });
            });
        }
    }

    /**
     * Pasang listener modal kredensial, toggle/salin secret, callback URL, IP whitelist, dan quick reference.
     */
    function bindEvents() {
        populateQuickReference();
        bindModalAndCopyEvents();
        bindCredentialActionEvents();
        bindCallbackAndIpEvents();
    }

    app.h2h = { loadIntegrasiSectionData, bindEvents, isValidIpOrCidrClient, validateCallbackUrlClient };
})(window);
