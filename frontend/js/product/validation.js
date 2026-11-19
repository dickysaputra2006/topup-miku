(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    let validationReqSeq = 0;

    function getInitials(name) {
        const words = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
        return (words[0] || 'MG').slice(0, 2).toUpperCase();
    }

    function applyHeroImage(game) {
        const { isSafeImageUrl } = global.MikuShared.dom;
        const { gameImageEl, gameImageFallbackEl } = app.state.els;
        const initials = getInitials(game && game.name);
        if (gameImageFallbackEl) gameImageFallbackEl.textContent = initials;
        if (!gameImageEl) return;

        const safeUrl = game && isSafeImageUrl(game.image_url) ? game.image_url : '';
        if (!safeUrl) {
            gameImageEl.classList.add('hidden');
            if (gameImageFallbackEl) gameImageFallbackEl.classList.remove('hidden');
            return;
        }

        gameImageEl.alt = game.name ? `Logo ${game.name}` : 'Logo game';
        gameImageEl.classList.remove('hidden');
        if (gameImageFallbackEl) gameImageFallbackEl.classList.add('hidden');
        gameImageEl.onerror = () => {
            gameImageEl.classList.add('hidden');
            if (gameImageFallbackEl) gameImageFallbackEl.classList.remove('hidden');
        };
        gameImageEl.src = safeUrl;
    }

    function resetValidationState(hintMessage = '') {
        validationReqSeq += 1;
        const { uiState } = global.MikuShared.dom;
        const { validationResultEl } = app.state.els;
        app.state.isValidationSuccess = false;
        app.state.validatedNickname = '';
        app.state.lastValidationErrorMessage = '';
        if (validationResultEl) {
            validationResultEl.innerHTML = hintMessage ? uiState(hintMessage, 'loading') : '';
        }
        if (app.checkout && typeof app.checkout.syncActionState === 'function') {
            app.checkout.syncActionState();
        }
    }

    /**
     * Jalankan pre-validasi akun game berdasarkan produk terpilih & ID tujuan.
     */
    async function runValidation() {
        const { uiState, escapeHtml } = global.MikuShared.dom;
        const { validationResultEl, targetGameIdInput } = app.state.els;
        const targetIdEl = targetGameIdInput || document.getElementById('target-game-id');
        const serverIdEl = document.getElementById('target-server-id');

        app.state.isValidationSuccess = false;
        app.state.validatedNickname = '';
        app.state.lastValidationErrorMessage = '';

        const userId = targetIdEl ? String(targetIdEl.value || '').trim() : '';
        const zoneId = serverIdEl ? String(serverIdEl.value || '').trim() : null;

        if (!userId) {
            if (validationResultEl) validationResultEl.innerHTML = uiState('Masukkan User ID untuk memvalidasi akun tujuan.', 'loading');
            app.checkout.syncActionState();
            return;
        }

        if (app.state.needsServerId && !zoneId) {
            if (validationResultEl) validationResultEl.innerHTML = uiState('Lengkapi Server / Zone ID terlebih dahulu.', 'loading');
            app.checkout.syncActionState();
            return;
        }

        if (!app.state.selectedProductId) {
            if (validationResultEl) validationResultEl.innerHTML = uiState('Pilih nominal di Langkah 2 untuk memvalidasi ID tujuan.', 'loading');
            app.checkout.syncActionState();
            return;
        }

        validationReqSeq += 1;
        const reqSeq = validationReqSeq;
        if (validationResultEl) validationResultEl.innerHTML = uiState('Mengecek nickname akun...', 'loading');
        app.checkout.syncActionState();

        try {
            const response = await fetch(`${app.PUBLIC_API_URL}/products/${app.state.selectedProductId}/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, zoneId }),
            });
            const result = await response.json();
            if (reqSeq !== validationReqSeq) return;

            if (result.message && result.message.includes('tidak memerlukan validasi')) {
                app.state.isValidationSuccess = true;
                app.state.validatedNickname = 'Terverifikasi (otomatis)';
                if (validationResultEl) {
                    validationResultEl.innerHTML = `<div class="validation-result-inline success">
                        <i class="fas fa-check-circle" aria-hidden="true"></i> <span>${escapeHtml(result.message)}</span>
                    </div>`;
                }
                app.checkout.syncActionState();
                return;
            }

            if (!response.ok) {
                const errMsg = result.message || 'Validasi ID gagal.';
                app.state.lastValidationErrorMessage = errMsg;
                if (validationResultEl) {
                    validationResultEl.innerHTML = `<div class="validation-result-inline error">
                        <i class="fas fa-times-circle" aria-hidden="true"></i> <span>${escapeHtml(errMsg)}</span>
                    </div>`;
                }
                app.checkout.syncActionState();
                return;
            }

            if (result.success && result.data && result.data.mobapay === true) {
                app.state.isValidationSuccess = true;
                app.state.validatedNickname = 'ID Memenuhi Syarat';
                if (validationResultEl) {
                    validationResultEl.innerHTML = `<div class="validation-result-inline success">
                        <i class="fas fa-check-circle" aria-hidden="true"></i> <span>${escapeHtml(result.message)}</span>
                    </div>`;
                }
                app.checkout.syncActionState();
                return;
            }

            const nickname = (result.data && result.data.username) ? String(result.data.username) : 'Terverifikasi';
            const region = (result.data && result.data.region) ? String(result.data.region) : '';
            app.state.isValidationSuccess = true;
            app.state.validatedNickname = nickname;
            let html = `<div class="validation-result-inline success">
                <i class="fas fa-check-circle" aria-hidden="true"></i>
                <div><p>Nickname: <strong>${escapeHtml(nickname)}</strong></p>`;
            if (region) {
                html += `<p>Region: <strong>${escapeHtml(region)}</strong></p>`;
            }
            html += '</div></div>';
            if (validationResultEl) validationResultEl.innerHTML = html;
        } catch (error) {
            if (reqSeq !== validationReqSeq) return;
            const errMsg = (error && error.message) || 'Terjadi kesalahan koneksi.';
            app.state.lastValidationErrorMessage = errMsg;
            if (validationResultEl) {
                validationResultEl.innerHTML = `<div class="validation-result-inline error">
                    <i class="fas fa-times-circle" aria-hidden="true"></i> <span>${escapeHtml(errMsg)}</span>
                </div>`;
            }
        } finally {
            app.checkout.syncActionState();
        }
    }

    function handleProductSelection(selectedCard, productId, productPrice, productName) {
        const { promoCodeInput, targetGameIdInput } = app.state.els;

        document.querySelectorAll('.product-card-selectable').forEach((card) => {
            card.classList.remove('selected');
            card.setAttribute('aria-pressed', 'false');
        });
        selectedCard.classList.add('selected');
        selectedCard.setAttribute('aria-pressed', 'true');

        app.state.selectedProductId = productId;
        app.state.selectedProductPrice = Number(productPrice) || 0;
        app.state.selectedProductName = productName || (selectedCard.querySelector('.product-card-name') ? selectedCard.querySelector('.product-card-name').textContent : '');
        app.state.appliedPromo = null;
        if (promoCodeInput) promoCodeInput.value = '';

        app.checkout.updatePrice();

        const hasUserId = Boolean(targetGameIdInput && String(targetGameIdInput.value || '').trim());
        const serverIdEl = document.getElementById('target-server-id');
        const hasServerId = !app.state.needsServerId || Boolean(serverIdEl && String(serverIdEl.value || '').trim());

        if (hasUserId && hasServerId) {
            runValidation();
        } else {
            resetValidationState('Nominal dipilih. Isi ID tujuan di Langkah 1 untuk validasi otomatis.');
        }
    }

    function renderProducts(products) {
        const { formatRupiah } = global.MikuShared.format;
        const { uiState, escapeHtml } = global.MikuShared.dom;
        const { productListContainer } = app.state.els;
        if (!productListContainer) return;

        app.state.products = Array.isArray(products) ? products : [];
        productListContainer.innerHTML = '';

        if (app.state.products.length === 0) {
            productListContainer.innerHTML = uiState('Saat ini belum ada produk aktif untuk game ini.', 'empty');
            return;
        }

        const toolbar = document.createElement('div');
        toolbar.className = 'product-selection-toolbar';
        toolbar.innerHTML = `<span class="tabular-nums">${app.state.products.length} pilihan nominal tersedia</span><span>Pilih nominal untuk cek harga &amp; ID.</span>`;
        productListContainer.appendChild(toolbar);

        app.state.products.forEach((product) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'product-card-selectable';
            card.setAttribute('aria-pressed', 'false');
            if (product.isFlashSale) card.classList.add('is-flash-sale');
            card.dataset.productId = String(product.id);
            card.dataset.price = String(product.price);
            card.dataset.name = String(product.name);

            const origPrice = Number(product.original_price || product.originalPrice || 0);
            const hasStrike = origPrice > Number(product.price);

            card.innerHTML = `
                <span class="product-card-name">${escapeHtml(product.name)}</span>
                <span class="product-card-pricing">
                    <span class="product-card-price">${escapeHtml(formatRupiah(product.price))}</span>
                    ${hasStrike ? `<span class="product-card-strike">${escapeHtml(formatRupiah(origPrice))}</span>` : ''}
                    ${product.isFlashSale ? '<em class="product-tag">Flash Sale</em>' : ''}
                </span>
            `;
            card.addEventListener('click', () => {
                handleProductSelection(card, card.dataset.productId, card.dataset.price, card.dataset.name);
            });
            productListContainer.appendChild(card);
        });
    }

    function applyFlashSaleSelection() {
        const { fsProductId } = app.state;
        const { productListContainer } = app.state.els;
        if (!fsProductId || !productListContainer) return;

        const safeId = (global.CSS && typeof global.CSS.escape === 'function')
            ? global.CSS.escape(String(fsProductId))
            : null;
        const fsCard = safeId
            ? productListContainer.querySelector(`.product-card-selectable[data-product-id="${safeId}"]`)
            : Array.from(productListContainer.querySelectorAll('.product-card-selectable'))
                .find((el) => el.dataset.productId === String(fsProductId));
        if (!fsCard) return;

        handleProductSelection(fsCard, fsCard.dataset.productId, fsCard.dataset.price, fsCard.dataset.name);
    }

    async function fetchGameData() {
        const { uiState, escapeHtml } = global.MikuShared.dom;
        const { gameId, token } = app.state;
        const {
            productListContainer,
            validationResultEl,
            gameNameEl,
            targetGameIdInput,
            targetGameIdLabelEl,
            serverInputContainer,
            orderForm,
        } = app.state.els;

        if (productListContainer) productListContainer.innerHTML = uiState('Memuat daftar produk...', 'loading');
        if (validationResultEl) validationResultEl.innerHTML = '';

        try {
            const headers = {};
            if (token) headers.Authorization = `Bearer ${token}`;
            const response = await fetch(`${app.PUBLIC_API_URL}/games/${encodeURIComponent(gameId)}/products`, { headers });
            if (!response.ok) throw new Error('Gagal memuat data produk game.');
            const data = await response.json();

            applyHeroImage(data.game);
            if (gameNameEl) gameNameEl.textContent = data.game.name || 'Produk Game';

            if (data.game.target_id_label) {
                if (targetGameIdLabelEl) targetGameIdLabelEl.textContent = data.game.target_id_label;
                if (targetGameIdInput) targetGameIdInput.placeholder = data.game.target_id_label;
            }

            app.state.needsServerId = Boolean(data.game.needs_server_id);
            if (serverInputContainer) {
                serverInputContainer.innerHTML = '';
                if (app.state.needsServerId) {
                    serverInputContainer.classList.remove('hidden');
                    if (orderForm) orderForm.classList.remove('single-input');
                    const serverListResponse = await fetch(`${app.PUBLIC_API_URL}/games/${encodeURIComponent(gameId)}/servers`);
                    const serverList = await serverListResponse.json();
                    const labelHtml = '<label for="target-server-id">Server / Zone ID</label>';
                    if (Array.isArray(serverList) && serverList.length > 0) {
                        const optionsHtml = serverList.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
                        serverInputContainer.innerHTML = `${labelHtml}
                            <select id="target-server-id" name="targetServerId" required>
                                <option value="" disabled selected>-- Pilih Server --</option>
                                ${optionsHtml}
                            </select>`;
                    } else {
                        serverInputContainer.innerHTML = `${labelHtml}
                            <input type="text" id="target-server-id" name="targetServerId" placeholder="Masukkan Server / Zone ID" autocomplete="off" required>`;
                    }
                    const serverEl = document.getElementById('target-server-id');
                    if (serverEl) {
                        if (serverEl.tagName === 'SELECT') {
                            serverEl.addEventListener('change', () => {
                                resetValidationState();
                                runValidation();
                            });
                        } else {
                            serverEl.addEventListener('input', () => resetValidationState());
                            serverEl.addEventListener('blur', () => {
                                if (String(serverEl.value || '').trim().length > 0) runValidation();
                                else app.checkout.syncActionState();
                            });
                        }
                    }
                } else {
                    serverInputContainer.classList.add('hidden');
                    if (orderForm) orderForm.classList.add('single-input');
                }
            }

            renderProducts(data.products);
            applyFlashSaleSelection();
            app.checkout.syncActionState();
        } catch (error) {
            console.error('Error fetching game data:', error);
            if (productListContainer) productListContainer.innerHTML = uiState(`Gagal memuat produk. ${escapeHtml(error.message)}`, 'error');
        }
    }

    function setupLiveValidation() {
        const { targetGameIdInput, validateIdBtn, orderForm } = app.state.els;

        if (orderForm) {
            orderForm.addEventListener('submit', (e) => {
                e.preventDefault();
                runValidation();
            });
        }
        if (targetGameIdInput) {
            targetGameIdInput.addEventListener('input', () => {
                resetValidationState();
            });
            targetGameIdInput.addEventListener('blur', () => {
                if (String(targetGameIdInput.value || '').trim().length > 0) {
                    runValidation();
                } else {
                    app.checkout.syncActionState();
                }
            });
        }
        if (validateIdBtn) {
            validateIdBtn.addEventListener('click', () => runValidation());
        }
    }

    app.validation = {
        fetchGameData,
        renderProducts,
        handleProductSelection,
        setupLiveValidation,
        applyFlashSaleSelection,
        runValidation,
    };
})(window);
