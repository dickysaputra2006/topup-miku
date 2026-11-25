(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    const PAYMENT_METHOD_LABELS = {
        balance: 'Saldo Akun',
    };

    function getOrderReadiness() {
        const { targetGameIdInput } = app.state.els;
        const targetEl = targetGameIdInput || document.getElementById('target-game-id');
        const serverEl = document.getElementById('target-server-id');

        const userId = targetEl ? String(targetEl.value || '').trim() : '';
        const serverId = serverEl ? String(serverEl.value || '').trim() : '';

        if (app.state.isOrderSubmitting) {
            return { ready: false, label: 'Memproses...', hint: 'Sedang memproses pesanan Anda, mohon tunggu.' };
        }
        if (!userId) {
            return { ready: false, label: 'Masukkan User ID dulu', hint: 'Langkah 1: Lengkapi User ID akun tujuan.' };
        }
        if (app.state.needsServerId && !serverId) {
            return { ready: false, label: 'Lengkapi Server ID dulu', hint: 'Langkah 1: Isi atau pilih Server / Zone ID.' };
        }
        if (!app.state.selectedProductId) {
            return { ready: false, label: 'Pilih nominal dulu', hint: 'Langkah 2: Pilih salah satu nominal top up.' };
        }
        if (app.state.selectedProductRequiresValidation && !app.state.isValidationSuccess) {
            const label = app.state.lastValidationErrorMessage ? 'Periksa ulang User ID' : 'Validasi User ID dulu';
            const hint = app.state.lastValidationErrorMessage || 'Langkah 1: Klik Cek Kelayakan ID sebelum membayar.';
            return { ready: false, label, hint };
        }
        if (!app.state.selectedPaymentMethod) {
            return { ready: false, label: 'Pilih metode pembayaran dulu', hint: 'Langkah 3: Pilih metode pembayaran terlebih dahulu.' };
        }
        return { ready: true, label: 'Bayar Sekarang', hint: 'Semua langkah lengkap. Klik Bayar Sekarang untuk konfirmasi.' };
    }

    function findSelectedProductCard(productId) {
        if (!productId) return null;
        const idStr = String(productId);
        if (global.CSS && typeof global.CSS.escape === 'function') {
            return document.querySelector(`.product-card-selectable[data-product-id="${global.CSS.escape(idStr)}"]`);
        }
        return Array.from(document.querySelectorAll('.product-card-selectable'))
            .find((el) => el.dataset.productId === idStr) || null;
    }

    function computeFinalPrice() {
        if (!app.state.selectedProductId) return null;
        const selectedCard = findSelectedProductCard(app.state.selectedProductId);
        const basePrice = selectedCard ? parseFloat(selectedCard.dataset.price) : Number(app.state.selectedProductPrice || 0);
        if (!Number.isFinite(basePrice)) return null;

        if (app.state.appliedPromo && app.state.appliedPromo.valid) {
            app.state.currentDiscountAmount = Number(app.state.appliedPromo.discount || 0);
            return Number(app.state.appliedPromo.final_price);
        }
        app.state.currentDiscountAmount = 0;
        return basePrice;
    }

    function syncActionState() {
        const { formatRupiah } = global.MikuShared.format;
        const {
            gameNameEl,
            totalPriceEl,
            mobileTotalPriceEl,
            submitOrderBtn,
            mobileSubmitOrderBtn,
            checkoutStatusHintEl,
            summaryGameEl,
            summaryTargetEl,
            summaryIgnEl,
            summaryIgnRowEl,
            summaryProductEl,
            summaryMethodEl,
            summaryBalanceRowEl,
            summaryUserBalanceEl,
            balanceMethodDescEl,
            summaryDiscountRowEl,
            summaryDiscountEl,
            targetGameIdInput,
        } = app.state.els;

        const targetEl = targetGameIdInput || document.getElementById('target-game-id');
        const serverEl = document.getElementById('target-server-id');
        const userId = targetEl ? String(targetEl.value || '').trim() : '';
        const serverId = serverEl ? String(serverEl.value || '').trim() : '';

        if (summaryGameEl && gameNameEl) summaryGameEl.textContent = gameNameEl.textContent || '-';
        if (summaryTargetEl) summaryTargetEl.textContent = userId ? (serverId ? `${userId} (${serverId})` : userId) : '-';
        if (summaryIgnRowEl) summaryIgnRowEl.classList.toggle('hidden', !app.state.selectedProductRequiresValidation);
        if (summaryIgnEl) summaryIgnEl.textContent = app.state.validatedNickname || '-';

        const selectedCard = findSelectedProductCard(app.state.selectedProductId);
        const selectedName = app.state.selectedProductName
            || (selectedCard && (selectedCard.dataset.name || (selectedCard.querySelector('.product-card-name') && selectedCard.querySelector('.product-card-name').textContent)))
            || '-';
        if (summaryProductEl) summaryProductEl.textContent = app.state.selectedProductId ? selectedName : '-';
        if (summaryMethodEl) {
            summaryMethodEl.textContent = PAYMENT_METHOD_LABELS[app.state.selectedPaymentMethod] || 'Belum dipilih';
        }
        const hasWalletBalance = Boolean(app.state.token) && Number.isFinite(app.state.userBalance);
        if (summaryBalanceRowEl && summaryUserBalanceEl) {
            summaryBalanceRowEl.classList.toggle('hidden', !hasWalletBalance);
            if (hasWalletBalance) summaryUserBalanceEl.textContent = formatRupiah(app.state.userBalance);
        }
        if (balanceMethodDescEl) {
            balanceMethodDescEl.textContent = hasWalletBalance
                ? `Saldo tersedia: ${formatRupiah(app.state.userBalance)}`
                : 'Proses instan dari saldo akun Anda';
        }

        const finalPrice = computeFinalPrice();
        const formattedTotal = finalPrice !== null ? formatRupiah(finalPrice) : '-';
        if (totalPriceEl) totalPriceEl.textContent = formattedTotal;
        if (mobileTotalPriceEl) mobileTotalPriceEl.textContent = formattedTotal;

        if (summaryDiscountRowEl && summaryDiscountEl) {
            if (app.state.appliedPromo && app.state.appliedPromo.valid && app.state.currentDiscountAmount > 0) {
                summaryDiscountRowEl.classList.remove('hidden');
                summaryDiscountEl.textContent = `- ${formatRupiah(app.state.currentDiscountAmount)}`;
            } else {
                summaryDiscountRowEl.classList.add('hidden');
            }
        }

        const state = getOrderReadiness();
        if (checkoutStatusHintEl) checkoutStatusHintEl.textContent = state.hint;

        [submitOrderBtn, mobileSubmitOrderBtn].forEach((btn) => {
            if (!btn) return;
            btn.disabled = !state.ready;
            if (app.state.isOrderSubmitting) {
                btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Memproses...';
            } else if (state.ready) {
                btn.textContent = '';
                const icon = document.createElement('i');
                icon.className = 'fas fa-shield-halved';
                icon.setAttribute('aria-hidden', 'true');
                btn.append(icon, document.createTextNode(` ${state.label}`));
            } else {
                btn.textContent = state.label;
            }
        });
    }

    /**
     * Hitung ulang tampilan harga akhir dan pesan promo aktif.
     */
    function updatePrice() {
        const { formatRupiah } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { promoResultEl } = app.state.els;
        if (promoResultEl) {
            if (app.state.appliedPromo && app.state.appliedPromo.valid) {
                const discountAmount = Number(app.state.appliedPromo.discount || 0);
                const discountLabel = Number.isFinite(discountAmount) && discountAmount > 0
                    ? ` (Potongan ${escapeHtml(formatRupiah(discountAmount))})`
                    : '';
                promoResultEl.innerHTML = `<span class="success"><i class="fas fa-check-circle" aria-hidden="true"></i> Kode promo berhasil diterapkan${discountLabel}.</span>`;
            } else {
                promoResultEl.innerHTML = '';
            }
        }
        syncActionState();
    }

    function openConfirmationModal() {
        const { formatRupiah } = global.MikuShared.format;
        const { escapeHtml } = global.MikuShared.dom;
        const { gameNameEl, totalPriceEl, confirmIgnRowEl } = app.state.els;
        const readiness = getOrderReadiness();

        if (!readiness.ready) {
            alert(readiness.hint);
            return;
        }
        if (!app.state.token) {
            alert('Anda harus masuk untuk melanjutkan transaksi.');
            app.showModal();
            return;
        }

        const targetGameId = document.getElementById('target-game-id').value;
        const targetServerIdEl = document.getElementById('target-server-id');
        const targetServerId = targetServerIdEl ? targetServerIdEl.value : null;
        const selectedCard = findSelectedProductCard(app.state.selectedProductId);
        const productName = app.state.selectedProductName || (selectedCard && selectedCard.dataset.name) || 'Produk';
        const productPriceText = selectedCard
            ? formatRupiah(parseFloat(selectedCard.dataset.price))
            : formatRupiah(Number(app.state.selectedProductPrice || 0));

        if (confirmIgnRowEl) confirmIgnRowEl.classList.toggle('hidden', !app.state.selectedProductRequiresValidation);
        const confirmIgnEl = document.getElementById('confirm-ign');
        if (confirmIgnEl) confirmIgnEl.textContent = app.state.selectedProductRequiresValidation ? (app.state.validatedNickname || 'Terverifikasi') : '-';
        document.getElementById('confirm-userid').textContent = targetGameId;
        document.getElementById('confirm-serverid').textContent = targetServerId || '-';
        document.getElementById('confirm-kategori').textContent = gameNameEl ? gameNameEl.textContent : '-';
        document.getElementById('confirm-produk').textContent = productName;
        document.getElementById('confirm-harga').textContent = productPriceText;
        const confirmMethodEl = document.getElementById('confirm-method');
        if (confirmMethodEl) confirmMethodEl.textContent = PAYMENT_METHOD_LABELS[app.state.selectedPaymentMethod] || 'Saldo Akun';
        document.getElementById('confirm-total').textContent = totalPriceEl ? totalPriceEl.textContent : productPriceText;

        const confirmationDetails = document.querySelector('.confirmation-details');
        if (confirmationDetails) {
            const oldPromo = confirmationDetails.querySelector('.promo-discount-row');
            if (oldPromo) oldPromo.remove();
            if (app.state.appliedPromo && app.state.appliedPromo.valid && app.state.appliedPromo.discount > 0) {
                const promoElement = document.createElement('p');
                promoElement.className = 'promo-discount-row';
                promoElement.innerHTML = `<span>Potongan Promo (${escapeHtml(app.state.appliedPromo.promo_code)})</span> <strong>- ${escapeHtml(formatRupiah(app.state.appliedPromo.discount, { withDecimals: true }))}</strong>`;
                const totalPaymentEl = confirmationDetails.querySelector('.total-payment');
                confirmationDetails.insertBefore(promoElement, totalPaymentEl);
            }
        }

        app.ensureOrderIdempotencyKey(app.buildCurrentOrderPayload());
        const confirmModal = document.getElementById('order-confirmation-modal');
        if (confirmModal) confirmModal.classList.remove('hidden');
    }

    function bindPaymentMethodEvents() {
        const { paymentMethodList } = app.state.els;
        if (!paymentMethodList) return;
        paymentMethodList.addEventListener('click', (e) => {
            const btn = e.target.closest('.payment-method-card');
            if (!btn) return;
            const method = btn.dataset.method || 'balance';
            const paymentCards = paymentMethodList.querySelectorAll('.payment-method-card');
            const isAlreadySelected = app.state.selectedPaymentMethod === method;
            if (isAlreadySelected && paymentCards.length === 1) {
                btn.classList.add('selected');
                btn.setAttribute('aria-pressed', 'true');
                syncActionState();
                return;
            }
            paymentCards.forEach((card) => {
                card.classList.remove('selected');
                card.setAttribute('aria-pressed', 'false');
            });
            if (isAlreadySelected) {
                app.state.selectedPaymentMethod = null;
            } else {
                app.state.selectedPaymentMethod = method;
                btn.classList.add('selected');
                btn.setAttribute('aria-pressed', 'true');
            }
            syncActionState();
        });
    }

    function bindEvents() {
        const { escapeHtml } = global.MikuShared.dom;
        const { generateIdempotencyKey, apiFetch } = global.MikuShared.api;
        const {
            submitOrderBtn,
            mobileSubmitOrderBtn,
            applyPromoBtn,
            promoCodeInput,
            targetGameIdInput,
            promoResultEl,
        } = app.state.els;

        bindPaymentMethodEvents();

        const confirmModal = document.getElementById('order-confirmation-modal');
        const closeConfirmBtn = document.getElementById('close-confirm-modal-btn');
        const cancelBtn = document.getElementById('cancel-order-btn');
        const confirmBtn = document.getElementById('confirm-order-btn');

        const hideConfirmModal = () => {
            if (confirmModal) confirmModal.classList.add('hidden');
        };

        if (submitOrderBtn) submitOrderBtn.addEventListener('click', openConfirmationModal);
        if (mobileSubmitOrderBtn) mobileSubmitOrderBtn.addEventListener('click', openConfirmationModal);
        if (closeConfirmBtn) closeConfirmBtn.addEventListener('click', hideConfirmModal);
        if (cancelBtn) cancelBtn.addEventListener('click', hideConfirmModal);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideConfirmModal();
                app.hideModal();
            }
        });

        if (confirmBtn) {
            confirmBtn.addEventListener('click', async () => {
                if (app.state.isOrderSubmitting) return;
                app.state.isOrderSubmitting = true;
                confirmBtn.disabled = true;
                confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Memproses...';
                syncActionState();

                const orderPayload = app.buildCurrentOrderPayload();
                app.state.lastOrderAttemptSignature = app.ensureOrderIdempotencyKey(orderPayload);

                try {
                    const response = await apiFetch(`${app.PUBLIC_API_URL}/order`, {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        headers: { 'Idempotency-Key': app.state.orderIdempotencyKey },
                        jsonBody: orderPayload,
                    });
                    let result = null;
                    let hasDefinitiveJson = false;
                    try {
                        result = await response.json();
                        hasDefinitiveJson = result !== null && typeof result === 'object';
                    } catch (_) {
                        hasDefinitiveJson = false;
                    }

                    // Rotasi key hanya pada respons definitif 2xx/4xx JSON agar retry 5xx tetap aman.
                    if (response.status >= 200 && response.status < 500 && hasDefinitiveJson) {
                        app.state.orderIdempotencyKey = generateIdempotencyKey();
                        app.state.lastOrderAttemptSignature = null;
                    }
                    if (!response.ok) {
                        throw new Error((result && result.message) ? result.message : `Gagal memproses pesanan (HTTP ${response.status}).`);
                    }
                    if (result && result.status === 'Failed') {
                        throw new Error(result.message || 'Pesanan gagal dan saldo telah dikembalikan. Silakan coba lagi.');
                    }

                    hideConfirmModal();
                    alert(`Transaksi Berhasil! Invoice ID Anda: ${result.invoiceId}\nAnda akan diarahkan ke halaman invoice.`);
                    window.location.href = `invoice.html?id=${encodeURIComponent(result.invoiceId)}`;
                } catch (error) {
                    alert(`Error: ${error.message}`);
                    app.state.isOrderSubmitting = false;
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Bayar Sekarang';
                    syncActionState();
                }
            });
        }

        if (promoCodeInput) {
            promoCodeInput.addEventListener('input', () => {
                if (app.state.appliedPromo) {
                    app.state.appliedPromo = null;
                    updatePrice();
                } else if (promoResultEl && promoResultEl.textContent) {
                    promoResultEl.innerHTML = '';
                }
            });
        }

        if (applyPromoBtn) {
            const promoForm = document.getElementById('promo-form');
            const handlePromoApply = async (e) => {
                if (e) e.preventDefault();
                const code = promoCodeInput ? promoCodeInput.value.trim() : '';
                if (!code) {
                    if (promoResultEl) promoResultEl.innerHTML = '<span class="error"><i class="fas fa-times-circle" aria-hidden="true"></i> Harap masukkan kode promo.</span>';
                    return;
                }
                const targetId = targetGameIdInput ? targetGameIdInput.value : '';
                if (!app.state.selectedProductId || !targetId) {
                    alert('Pilih produk dan isi User ID terlebih dahulu!');
                    return;
                }
                try {
                    applyPromoBtn.disabled = true;
                    applyPromoBtn.textContent = 'Mengecek...';
                    const response = await apiFetch('/api/promos/validate', {
                        method: 'POST',
                        auth: true,
                        token: app.state.token,
                        jsonBody: {
                            promo_code: code,
                            product_id: app.state.selectedProductId,
                            target_game_id: targetId,
                        },
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message);
                    app.state.appliedPromo = result;
                    updatePrice();
                } catch (error) {
                    app.state.appliedPromo = null;
                    if (promoResultEl) promoResultEl.innerHTML = `<span class="error"><i class="fas fa-times-circle" aria-hidden="true"></i> ${escapeHtml(error.message)}</span>`;
                    syncActionState();
                } finally {
                    applyPromoBtn.disabled = false;
                    applyPromoBtn.textContent = 'Terapkan';
                }
            };
            if (promoForm) promoForm.addEventListener('submit', handlePromoApply);
            else applyPromoBtn.addEventListener('click', handlePromoApply);
        }
    }

    app.checkout = {
        updatePrice,
        syncActionState,
        bindEvents,
    };
})(window);
