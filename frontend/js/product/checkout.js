(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    /**
     * Hitung ulang tampilan harga akhir setelah memperhitungkan potongan kode promo aktif.
     */
    function updatePrice() {
        const { formatRupiah } = global.MikuShared.format;
        const { promoResultEl, totalPriceEl } = app.state.els;

        if (!app.state.selectedProductId) return;
        const card = document.querySelector(`.product-card-selectable[data-product-id='${app.state.selectedProductId}']`);
        let originalPrice = parseFloat(card.dataset.price);
        let finalPrice = originalPrice;
        app.state.currentDiscountAmount = 0; // Reset discount

        if (app.state.appliedPromo && app.state.appliedPromo.valid) {
            finalPrice = app.state.appliedPromo.final_price;
            app.state.currentDiscountAmount = app.state.appliedPromo.discount;
            promoResultEl.innerHTML = `<span class="success"><i class="fas fa-check-circle"></i> Kode promo berhasil digunakan!</span>`;
        } else {
            promoResultEl.innerHTML = '';
        }

        totalPriceEl.textContent = formatRupiah(finalPrice);
    }

    /**
     * Pasang listener validasi promo, pembukaan modal konfirmasi, dan eksekusi order idempotent.
     */
    function bindEvents() {
        const { formatRupiah } = global.MikuShared.format;
        const { generateIdempotencyKey, apiFetch } = global.MikuShared.api;
        const {
            submitOrderBtn,
            gameNameEl,
            totalPriceEl,
            applyPromoBtn,
            promoCodeInput,
            targetGameIdInput,
            promoResultEl,
        } = app.state.els;

        if (submitOrderBtn) {
            // Deklarasikan elemen modal di luar event listener
            const confirmModal = document.getElementById('order-confirmation-modal');
            const closeConfirmBtn = document.getElementById('close-confirm-modal-btn');
            const cancelBtn = document.getElementById('cancel-order-btn');
            const confirmBtn = document.getElementById('confirm-order-btn');

            // Event listener untuk tombol "Beli Sekarang" utama
            submitOrderBtn.addEventListener('click', () => {
                if (!app.state.isValidationSuccess) {
                    const errMsg = app.state.lastValidationErrorMessage
                        ? `Validasi ID gagal: ${app.state.lastValidationErrorMessage}\n\nHarap periksa kembali User ID Anda atau pilih produk lain.`
                        : 'Validasi ID belum selesai atau gagal. Pastikan User ID sudah diisi dan valid, lalu coba lagi.';
                    alert(errMsg);
                    return;
                }
                if (!app.state.token) {
                    alert('Anda harus login untuk melakukan transaksi.');
                    app.showModal();
                    return;
                }
                if (!app.state.selectedProductId) {
                    alert('Silakan pilih nominal top up terlebih dahulu.');
                    return;
                }

                const targetGameId = document.getElementById('target-game-id').value;
                const targetServerIdEl = document.getElementById('target-server-id');
                const targetServerId = targetServerIdEl ? targetServerIdEl.value : null;

                if (!targetGameId || (targetServerIdEl && targetServerIdEl.required && !targetServerId)) {
                    alert('Silakan lengkapi User ID dan Server ID Anda.');
                    return;
                }

                // Ambil data dari halaman untuk ditampilkan di modal
                const nickname = document.querySelector('#validation-result strong')?.textContent || 'Belum divalidasi';
                const gameCategory = gameNameEl.textContent;
                const selectedProductCard = document.querySelector('.product-card-selectable.selected');
                const productName = selectedProductCard ? selectedProductCard.querySelector('span').textContent : 'Tidak dipilih';
                const productPrice = selectedProductCard ? selectedProductCard.querySelector('small').textContent : '-';

                // Isi modal dengan data yang relevan
                document.getElementById('confirm-ign').textContent = nickname;
                document.getElementById('confirm-userid').textContent = targetGameId;
                document.getElementById('confirm-serverid').textContent = targetServerId || '-';
                document.getElementById('confirm-kategori').textContent = gameCategory;
                document.getElementById('confirm-produk').textContent = productName;
                document.getElementById('confirm-harga').textContent = productPrice;
                document.getElementById('confirm-total').textContent = totalPriceEl.textContent;

                // --- LOGIKA BARU UNTUK MENAMPILKAN POTONGAN PROMO ---
                const confirmationDetails = document.querySelector('.confirmation-details');
                let promoElement = confirmationDetails.querySelector('.promo-discount-row');
                // Hapus elemen promo lama jika ada, untuk pembaruan
                if (promoElement) {
                    promoElement.remove();
                }

                // Tampilkan baris potongan harga HANYA JIKA ada promo yang valid
                if (app.state.appliedPromo && app.state.appliedPromo.valid && app.state.appliedPromo.discount > 0) {
                    promoElement = document.createElement('p');
                    promoElement.className = 'promo-discount-row'; // Class untuk styling
                    promoElement.innerHTML = `<span>Potongan Promo (${app.state.appliedPromo.promo_code})</span> <strong>- ${formatRupiah(app.state.appliedPromo.discount, { withDecimals: true })}</strong>`;

                    // Sisipkan elemen promo sebelum elemen Total Pembayaran
                    const totalPaymentElement = confirmationDetails.querySelector('.total-payment');
                    confirmationDetails.insertBefore(promoElement, totalPaymentElement);
                }
                // --- AKHIR LOGIKA BARU ---

                // Tampilkan modal konfirmasi (pertahankan key untuk payload sama, rotasi jika payload berubah setelah submit sebelumnya)
                app.ensureOrderIdempotencyKey(app.buildCurrentOrderPayload());
                if (confirmModal) confirmModal.classList.remove('hidden');
            });

            // Fungsi untuk menyembunyikan modal
            const hideConfirmModal = () => {
                if (confirmModal) confirmModal.classList.add('hidden');
            };

            // Tambahkan event listener untuk tombol-tombol di dalam modal
            if (closeConfirmBtn) closeConfirmBtn.addEventListener('click', hideConfirmModal);
            if (cancelBtn) cancelBtn.addEventListener('click', hideConfirmModal);

            // Event listener untuk tombol "Bayar Sekarang" di DALAM MODAL
            if (confirmBtn) {
                confirmBtn.addEventListener('click', async () => {
                    if (app.state.isOrderSubmitting) return;
                    app.state.isOrderSubmitting = true;
                    confirmBtn.disabled = true;
                    submitOrderBtn.disabled = true;
                    confirmBtn.innerHTML = 'Memproses...';
                    const orderPayload = app.buildCurrentOrderPayload();
                    const currentSignature = app.ensureOrderIdempotencyKey(orderPayload);
                    app.state.lastOrderAttemptSignature = currentSignature;

                    try {
                        const response = await apiFetch(`${app.PUBLIC_API_URL}/order`, {
                            method: 'POST',
                            auth: true,
                            token: app.state.token,
                            headers: {
                                'Idempotency-Key': app.state.orderIdempotencyKey,
                            },
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

                        // Rotasi key hanya pada respons definitif 2xx/4xx JSON agar user bisa mencoba order baru.
                        // Pertahankan key pada 5xx (meski JSON) dan error jaringan/timeout karena status di server
                        // bisa ambigu/belum pasti selesai, sehingga retry tetap aman tanpa double debit.
                        if (response.status >= 200 && response.status < 500 && hasDefinitiveJson) {
                            app.state.orderIdempotencyKey = generateIdempotencyKey();
                            app.state.lastOrderAttemptSignature = null;
                        }

                        if (!response.ok) {
                            throw new Error((result && result.message) ? result.message : `Gagal memproses pesanan (HTTP ${response.status}).`);
                        }
                        if (result && result.status === 'Failed') {
                            throw new Error(result.message || 'Pesanan sebelumnya gagal dan saldo telah dikembalikan. Silakan buat pesanan baru.');
                        }

                        hideConfirmModal();
                        alert(`Transaksi Berhasil! Invoice ID Anda: ${result.invoiceId}\nAnda akan diarahkan ke halaman invoice.`);
                        window.location.href = `invoice.html?id=${encodeURIComponent(result.invoiceId)}`;
                    } catch (error) {
                        alert(`Error: ${error.message}`);
                        app.state.isOrderSubmitting = false;
                        confirmBtn.disabled = false;
                        submitOrderBtn.disabled = false;
                        confirmBtn.innerHTML = 'Bayar Sekarang <i class="fas fa-arrow-right"></i>';
                    }
                });
            }
        }

        if (applyPromoBtn) {
            const promoForm = document.getElementById('promo-form');
            const handlePromoApply = async (e) => {
                if (e) e.preventDefault();
                // Mengambil kode promo dan membersihkan spasi di awal/akhir
                const code = promoCodeInput.value.trim();

                // PENCEGAHAN: Hentikan fungsi jika input kode promo kosong untuk menghindari error
                if (!code) {
                    promoResultEl.innerHTML = `<span class="error"><i class="fas fa-times-circle"></i> Harap masukkan kode promo.</span>`;
                    return;
                }

                const targetId = targetGameIdInput.value;
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
                    app.state.appliedPromo = null; // Reset promo jika gagal
                    promoResultEl.innerHTML = `<span class="error"><i class="fas fa-times-circle"></i> ${error.message}</span>`;
                    updatePrice(); // Perbarui harga kembali ke normal (tanpa diskon)
                } finally {
                    applyPromoBtn.disabled = false;
                    applyPromoBtn.textContent = 'Terapkan';
                }
            };

            if (promoForm) {
                promoForm.addEventListener('submit', handlePromoApply);
            } else {
                applyPromoBtn.addEventListener('click', handlePromoApply);
            }
        }
    }

    app.checkout = {
        updatePrice,
        bindEvents,
    };
})(window);
