(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    let validationReqSeq = 0;

    function getInitials(name) {
        const words = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
        return (words[0] || 'MG').slice(0, 2).toUpperCase();
    }

    function normalizeHeroCategory(category) {
        const raw = String(category || '').trim().toLowerCase();
        if (raw.includes('mobile') || raw.includes('mlbb')) return 'mobile';
        if (raw.includes('pc')) return 'pc';
        if (raw.includes('voucher') || raw.includes('life')) return 'voucher';
        return 'other';
    }

    function splitProductBonus(rawName) {
        const text = String(rawName || '').trim();
        const match = text.match(/^(.*?)\s*(\([^()]+\))$/);
        if (match && match[1].trim()) {
            return { main: match[1].trim(), bonus: match[2].trim() };
        }
        return { main: text, bonus: '' };
    }

    function computeDiscountPct(origPrice, currentPrice) {
        const orig = Number(origPrice);
        const curr = Number(currentPrice);
        if (!Number.isFinite(orig) || !Number.isFinite(curr) || orig <= 0 || curr <= 0 || curr >= orig) return 0;
        return Math.round((1 - (curr / orig)) * 100);
    }

    function applyHeroImage(game) {
        const { isSafeImageUrl } = global.MikuShared.dom;
        const { gameImageEl, gameImageFallbackEl } = app.state.els;
        const initials = getInitials(game && game.name);
        if (gameImageFallbackEl) {
            gameImageFallbackEl.textContent = initials;
            gameImageFallbackEl.dataset.category = normalizeHeroCategory(game && game.category);
        }
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

    function syncValidationUiVisibility(requiresValidation) {
        const showValidation = Boolean(requiresValidation);
        const {
            directIdHintEl,
            validationActionsEl,
            validationResultEl,
            summaryIgnRowEl,
            confirmIgnRowEl,
        } = app.state.els;
        if (directIdHintEl) directIdHintEl.classList.toggle('hidden', showValidation);
        if (validationActionsEl) validationActionsEl.classList.toggle('hidden', !showValidation);
        if (validationResultEl) validationResultEl.classList.toggle('hidden', !showValidation);
        if (summaryIgnRowEl) summaryIgnRowEl.classList.toggle('hidden', !showValidation);
        if (confirmIgnRowEl) confirmIgnRowEl.classList.toggle('hidden', !showValidation);
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
        if (!app.state.selectedProductRequiresValidation) {
            app.state.isValidationSuccess = true;
            if (app.checkout && typeof app.checkout.syncActionState === 'function') {
                app.checkout.syncActionState();
            }
            return;
        }
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
        const { promoCodeInput, targetGameIdInput, validationResultEl } = app.state.els;

        document.querySelectorAll('.product-card-selectable').forEach((card) => {
            card.classList.remove('selected');
            card.setAttribute('aria-pressed', 'false');
        });
        selectedCard.classList.add('selected');
        selectedCard.setAttribute('aria-pressed', 'true');

        const requiresValidation = selectedCard.dataset.requiresValidation === 'true';
        app.state.selectedProductId = productId;
        app.state.selectedProductPrice = Number(productPrice) || 0;
        app.state.selectedProductName = productName || (selectedCard.querySelector('.product-card-name') ? selectedCard.querySelector('.product-card-name').textContent : '');
        app.state.selectedProductRequiresValidation = requiresValidation;
        app.state.appliedPromo = null;
        if (promoCodeInput) promoCodeInput.value = '';

        syncValidationUiVisibility(requiresValidation);
        app.checkout.updatePrice();

        if (!requiresValidation) {
            validationReqSeq += 1;
            app.state.isValidationSuccess = true;
            app.state.validatedNickname = '';
            app.state.lastValidationErrorMessage = '';
            if (validationResultEl) validationResultEl.innerHTML = '';
            app.checkout.syncActionState();
            return;
        }

        const hasUserId = Boolean(targetGameIdInput && String(targetGameIdInput.value || '').trim());
        const serverIdEl = document.getElementById('target-server-id');
        const hasServerId = !app.state.needsServerId || Boolean(serverIdEl && String(serverIdEl.value || '').trim());

        if (hasUserId && hasServerId) {
            runValidation();
        } else {
            resetValidationState('Nominal dipilih. Isi ID tujuan di Langkah 1 lalu klik Cek Kelayakan ID.');
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
        toolbar.innerHTML = `<span class="tabular-nums">${app.state.products.length} pilihan nominal tersedia</span><span>Pilih nominal untuk melihat harga.</span>`;
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
            card.dataset.requiresValidation = product.requiresValidation ? 'true' : 'false';

            const checkBadge = document.createElement('span');
            checkBadge.className = 'product-card-check';
            checkBadge.setAttribute('aria-hidden', 'true');
            const checkIcon = document.createElement('i');
            checkIcon.className = 'fas fa-check';
            checkBadge.appendChild(checkIcon);

            const head = document.createElement('span');
            head.className = 'product-card-head';
            const itemIcon = document.createElement('i');
            itemIcon.className = product.isFlashSale ? 'fas fa-bolt product-card-icon is-flash' : 'fas fa-gem product-card-icon';
            itemIcon.setAttribute('aria-hidden', 'true');

            const titleWrap = document.createElement('span');
            titleWrap.className = 'product-card-title-wrap';
            const { main, bonus } = splitProductBonus(product.name);
            const nameEl = document.createElement('span');
            nameEl.className = 'product-card-name';
            nameEl.textContent = main;
            titleWrap.appendChild(nameEl);
            if (bonus) {
                const bonusEl = document.createElement('span');
                bonusEl.className = 'product-card-bonus';
                bonusEl.textContent = bonus;
                titleWrap.appendChild(bonusEl);
            }
            head.append(itemIcon, titleWrap);

            const origPrice = Number(product.original_price || product.originalPrice || 0);
            const hasStrike = origPrice > Number(product.price);
            const discountPct = computeDiscountPct(origPrice, product.price);

            const pricing = document.createElement('span');
            pricing.className = 'product-card-pricing';
            const priceRow = document.createElement('span');
            priceRow.className = 'product-card-price-row';
            const priceEl = document.createElement('span');
            priceEl.className = 'product-card-price';
            priceEl.textContent = formatRupiah(product.price);
            priceRow.appendChild(priceEl);

            if (discountPct > 0) {
                const pill = document.createElement('span');
                pill.className = 'product-discount-pill';
                pill.textContent = `-${discountPct}%`;
                priceRow.appendChild(pill);
            } else if (product.isFlashSale) {
                const pill = document.createElement('span');
                pill.className = 'product-discount-pill is-flash-label';
                pill.textContent = 'Flash';
                priceRow.appendChild(pill);
            }
            pricing.appendChild(priceRow);

            if (hasStrike) {
                const strikeEl = document.createElement('span');
                strikeEl.className = 'product-card-strike';
                strikeEl.textContent = formatRupiah(origPrice);
                pricing.appendChild(strikeEl);
            }

            card.append(checkBadge, head, pricing);
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
                                if (!app.state.selectedProductRequiresValidation) {
                                    app.checkout.syncActionState();
                                    return;
                                }
                                resetValidationState();
                                runValidation();
                            });
                        } else {
                            serverEl.addEventListener('input', () => {
                                if (!app.state.selectedProductRequiresValidation) {
                                    app.checkout.syncActionState();
                                    return;
                                }
                                resetValidationState();
                            });
                            serverEl.addEventListener('blur', () => {
                                if (!app.state.selectedProductRequiresValidation) {
                                    app.checkout.syncActionState();
                                    return;
                                }
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

            syncValidationUiVisibility(false);
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
                if (app.state.selectedProductRequiresValidation) {
                    runValidation();
                }
            });
        }
        if (targetGameIdInput) {
            targetGameIdInput.addEventListener('input', () => {
                if (!app.state.selectedProductRequiresValidation) {
                    app.checkout.syncActionState();
                    return;
                }
                resetValidationState();
            });
            targetGameIdInput.addEventListener('blur', () => {
                if (!app.state.selectedProductRequiresValidation) {
                    app.checkout.syncActionState();
                    return;
                }
                if (String(targetGameIdInput.value || '').trim().length > 0) {
                    runValidation();
                } else {
                    app.checkout.syncActionState();
                }
            });
        }
        if (validateIdBtn) {
            validateIdBtn.addEventListener('click', () => {
                if (app.state.selectedProductRequiresValidation) runValidation();
            });
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
