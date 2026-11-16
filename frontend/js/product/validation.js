(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    function handleProductSelection(selectedCard, productId, productPrice) {
        const { uiState } = global.MikuShared.dom;
        const { promoCodeInput, validationResultEl, submitOrderBtn } = app.state.els;

        document.querySelectorAll('.product-card-selectable').forEach(card => card.classList.remove('selected'));
        selectedCard.classList.add('selected');
        app.state.selectedProductId = productId;
        app.state.appliedPromo = null; // Reset promo saat produk baru dipilih
        promoCodeInput.value = '';
        app.state.isValidationSuccess = false;
        app.state.lastValidationErrorMessage = ''; // reset pesan error saat ganti produk
        validationResultEl.innerHTML = uiState('Isi User ID lalu keluar dari kolom untuk validasi otomatis.', 'loading');
        app.checkout.updatePrice(); // Panggil fungsi ini, bukan set textContent langsung
        submitOrderBtn.disabled = false;
        submitOrderBtn.textContent = 'Beli Sekarang';
    }

    function renderProducts(products) {
        const { formatRupiah } = global.MikuShared.format;
        const { uiState } = global.MikuShared.dom;
        const { productListContainer } = app.state.els;

        productListContainer.innerHTML = '';
        if (products.length === 0) {
            productListContainer.innerHTML = uiState('Saat ini belum ada produk aktif untuk game ini.', 'empty');
            return;
        }
        const toolbar = document.createElement('div');
        toolbar.className = 'product-selection-toolbar';
        toolbar.innerHTML = `<span>${products.length} pilihan tersedia</span><span>Pilih nominal, lalu isi ID tujuan.</span>`;
        productListContainer.appendChild(toolbar);
        products.forEach(product => {
            const card = document.createElement('div');
            card.className = 'product-card-selectable';
            if (product.isFlashSale) card.classList.add('is-flash-sale');
            card.dataset.productId = product.id;
            card.dataset.price = product.price;
            card.innerHTML = `
                <span>${product.name}</span>
                <small>${formatRupiah(product.price)}</small>
                ${product.isFlashSale ? '<em class="product-tag">Flash Sale</em>' : ''}
            `;
            card.addEventListener('click', () => handleProductSelection(card, product.id, product.price));
            productListContainer.appendChild(card);
        });
    }

    function applyFlashSaleSelection() {
        const { uiState } = global.MikuShared.dom;
        const { fsProductId, fsPrice } = app.state;
        const { productListContainer, submitOrderBtn, validationResultEl } = app.state.els;

        if (fsProductId && fsPrice) {
            const fsCard = productListContainer.querySelector(`[data-product-id="${fsProductId}"]`);
            if (fsCard) {
                // Hapus seleksi dari kartu lain dan pilih kartu flash sale
                document.querySelectorAll('.product-card-selectable').forEach(card => card.classList.remove('selected'));
                fsCard.classList.add('selected');
                fsCard.classList.add('is-flash-sale');

                // Atur ID produk yang terpilih secara global
                app.state.selectedProductId = fsProductId;

                // PENTING: Timpa harga asli kartu dengan harga flash sale
                fsCard.dataset.price = fsPrice;

                // Perbarui tampilan harga dan aktifkan tombol beli
                app.checkout.updatePrice();
                submitOrderBtn.disabled = false;
                submitOrderBtn.textContent = 'Beli Sekarang';
                validationResultEl.innerHTML = uiState('Flash sale dipilih. Isi User ID lalu validasi tujuan top up.', 'loading');
                fsCard.dispatchEvent(new Event('click', { bubbles: true }));
            }
        }
    }

    /**
     * Ambil informasi game, daftar server (jika ada), dan produk aktif untuk halaman pemesanan.
     */
    async function fetchGameData() {
        const { uiState } = global.MikuShared.dom;
        const { gameId, token } = app.state;
        const {
            productListContainer,
            validationResultEl,
            gameImageEl,
            gameNameEl,
            targetGameIdInput,
            serverInputContainer,
            orderForm,
        } = app.state.els;

        productListContainer.innerHTML = uiState('Memuat daftar produk...', 'loading');
        validationResultEl.innerHTML = '';
        try {
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const response = await fetch(`${app.PUBLIC_API_URL}/games/${gameId}/products`, { headers });
            if (!response.ok) throw new Error('Gagal memuat data produk game.');
            const data = await response.json();

            gameImageEl.src = data.game.image_url;
            gameNameEl.textContent = data.game.name;

            if (data.game.target_id_label) {
                targetGameIdInput.placeholder = data.game.target_id_label;
            }

            serverInputContainer.innerHTML = '';

            if (data.game.needs_server_id) {
                orderForm.classList.remove('single-input');
                // Panggil API untuk cek apakah ada daftar server tetap
                const serverListResponse = await fetch(`${app.PUBLIC_API_URL}/games/${gameId}/servers`);
                const serverList = await serverListResponse.json();

                if (serverList.length > 0) {
                    // Jika ada daftar server, buat dropdown
                    let optionsHtml = serverList.map(server => `<option value="${server}">${server}</option>`).join('');
                    serverInputContainer.innerHTML = `
                        <select id="target-server-id" required>
                            <option value="" disabled selected>-- Pilih Server --</option>
                            ${optionsHtml}
                        </select>
                    `;
                } else {
                    // Jika tidak ada, buat input teks biasa
                    serverInputContainer.innerHTML = `<input type="text" id="target-server-id" placeholder="Masukkan Server ID" required>`;
                }
            } else {
                // TAMBAHAN: Tambahkan kelas .single-input jika game TIDAK butuh server
                orderForm.classList.add('single-input');
            }

            renderProducts(data.products);
            applyFlashSaleSelection();
        } catch (error) {
            console.error('Error fetching game data:', error);
            productListContainer.innerHTML = uiState(`Gagal memuat produk. ${error.message}`, 'error');
        }
    }

    /**
     * Pasang live validation ID tujuan ketika produk diklik atau input ID/Zone ID kehilangan fokus.
     */
    async function setupLiveValidation() {
        const { uiState } = global.MikuShared.dom;
        const targetIdInput = document.getElementById('target-game-id');
        const serverIdInputContainer = document.getElementById('server-input-container');
        const resultContainer = document.getElementById('validation-result');
        const productListContainer = document.getElementById('product-list-container');

        // Pindahkan selectedProductId ke dalam scope fungsi ini agar tidak bentrok
        let currentSelectedProductId = null;

        // Fungsi inti yang akan menjalankan validasi
        const handleValidation = async () => {
            app.state.isValidationSuccess = false; // Reset status setiap kali validasi baru dimulai
            app.state.lastValidationErrorMessage = ''; // reset pesan error lama
            if (!currentSelectedProductId) {
                resultContainer.innerHTML = '';
                return;
            }

            if (!targetIdInput.value) {
                resultContainer.innerHTML = uiState('Masukkan User ID untuk memvalidasi tujuan top up.', 'loading');
                return;
            }

            const userId = targetIdInput.value;
            const serverIdInput = document.getElementById('target-server-id');
            const zoneId = serverIdInput ? serverIdInput.value : null;

            resultContainer.innerHTML = uiState('Mengecek nickname...', 'loading');

            try {
                const response = await fetch(`${app.PUBLIC_API_URL}/products/${currentSelectedProductId}/validate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, zoneId }),
                });

                const result = await response.json();

                // Tampilan jika produk tidak memerlukan validasi
                if (result.message && result.message.includes('tidak memerlukan validasi')) {
                    resultContainer.innerHTML = `<div class="validation-result-inline success">
                        <i class="fas fa-check-circle"></i> ${result.message}
                    </div>`;
                    app.state.isValidationSuccess = true;
                    return;
                }

                // Tampilan jika validasi gagal
                if (!response.ok) {
                    const errMsg = result.message || 'Validasi gagal.';
                    app.state.lastValidationErrorMessage = errMsg; // simpan untuk alert Beli Sekarang
                    resultContainer.innerHTML = `<div class="validation-result-inline error">
                        <i class="fas fa-times-circle"></i><span>${errMsg}</span>
                    </div>`;
                    return;
                }

                // Tampilan sukses Mobapay (tidak ada username, hanya message konfirmasi)
                if (result.success && result.data && result.data.mobapay === true) {
                    resultContainer.innerHTML = `<div class="validation-result-inline success">
                        <i class="fas fa-check-circle"></i> ${result.message}
                    </div>`;
                    app.state.isValidationSuccess = true;
                    return;
                }
                // Tampilan jika validasi sukses
                let message = `<div class="validation-result-inline success">
                            <p><i class="fas fa-check-circle"></i> Nickname: <strong>${result.data.username}</strong></p>`;
                if (result.data.region) {
                    message += `<p style="margin-top: 0.25rem;">Region: <strong>${result.data.region}</strong></p>`;
                }

                if (!response.ok) {
                    app.state.isValidationSuccess = false;
                    resultContainer.innerHTML = `<div class="validation-result error">...</div>`;
                    return;
                }

                message += `</div>`;
                resultContainer.innerHTML = message;
                app.state.isValidationSuccess = true;
            } catch (error) {
                const errMsg = error.message || 'Terjadi kesalahan koneksi.';
                app.state.lastValidationErrorMessage = errMsg;
                resultContainer.innerHTML = `<div class="validation-result-inline error">
                    <i class="fas fa-times-circle"></i><span>${errMsg}</span>
                </div>`;
                app.state.isValidationSuccess = false;
            }
        };

        // Saat pengguna memilih kartu produk
        if (productListContainer) {
            productListContainer.addEventListener('click', (e) => {
                const card = e.target.closest('.product-card-selectable');
                if (card && card.dataset.productId) {
                    currentSelectedProductId = card.dataset.productId;
                    handleValidation();
                }
            });
        }

        // Saat pengguna selesai mengetik di kolom ID atau Zone ID
        if (targetIdInput) {
            targetIdInput.addEventListener('blur', handleValidation);
        }

        if (serverIdInputContainer) {
            const observer = new MutationObserver(() => {
                const serverIdInput = document.getElementById('target-server-id');
                if (serverIdInput) {
                    serverIdInput.addEventListener('blur', handleValidation);
                    observer.disconnect();
                }
            });
            observer.observe(serverIdInputContainer, { childList: true, subtree: true });
        }
    }

    app.validation = {
        fetchGameData,
        renderProducts,
        handleProductSelection,
        setupLiveValidation,
        applyFlashSaleSelection,
    };
})(window);
