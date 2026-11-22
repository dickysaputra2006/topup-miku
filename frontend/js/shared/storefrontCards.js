(function (global) {
    'use strict';

    const shared = (global.MikuShared = global.MikuShared || {});

    const CATEGORY_META = {
        mobile: { key: 'mobile', label: 'Mobile', icon: 'fas fa-gamepad' },
        pc: { key: 'pc', label: 'PC Game', icon: 'fas fa-desktop' },
        voucher: { key: 'voucher', label: 'Voucher', icon: 'fas fa-ticket-alt' },
        other: { key: 'other', label: 'Top Up', icon: 'fas fa-star' },
    };

    function createEl(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function getInitials(name) {
        const words = String(name || '').trim().split(/\s+/).filter(Boolean);
        return words.length >= 2
            ? (words[0][0] + words[1][0]).toUpperCase()
            : (words[0] || 'MG').slice(0, 2).toUpperCase();
    }

    function normalizeCategoryKey(category) {
        const raw = String(category || '').trim().toLowerCase();
        if (raw.includes('mobile') || raw.includes('mlbb')) return 'mobile';
        if (raw.includes('pc')) return 'pc';
        if (raw.includes('voucher') || raw.includes('life')) return 'voucher';
        return 'other';
    }

    function getCategoryMeta(category) {
        return CATEGORY_META[normalizeCategoryKey(category)] || CATEGORY_META.other;
    }

    function computeDiscountPercent(originalPrice, discountPrice) {
        const orig = Number(originalPrice);
        const disc = Number(discountPrice);
        if (!Number.isFinite(orig) || !Number.isFinite(disc) || orig <= 0 || disc <= 0 || disc >= orig) return 0;
        return Math.round((1 - (disc / orig)) * 100);
    }

    function buildCategoryFallbackArt(options) {
        const { name, category, compact = false } = options || {};
        const meta = getCategoryMeta(category);
        const wrap = createEl('span', compact ? 'game-card-fallback game-card-fallback--compact' : 'game-card-fallback');
        wrap.dataset.category = meta.key;
        wrap.setAttribute('aria-hidden', 'true');

        const watermark = createEl('i', `${meta.icon} fallback-watermark`);
        watermark.setAttribute('aria-hidden', 'true');
        wrap.append(
            watermark,
            createEl('span', 'fallback-monogram', getInitials(name)),
            createEl('span', 'fallback-cat-pill', meta.label)
        );
        return wrap;
    }

    function attachGameMedia(container, options) {
        const { isSafeImageUrl } = shared.dom;
        const { imageUrl, altText, name, category, compact = false } = options || {};
        const safeUrl = isSafeImageUrl(imageUrl) ? imageUrl : '';
        const fallbackEl = buildCategoryFallbackArt({ name, category, compact });

        if (!safeUrl) {
            container.dataset.hasImage = 'false';
            container.appendChild(fallbackEl);
            return;
        }

        container.dataset.hasImage = 'true';
        const img = createEl('img');
        img.src = safeUrl;
        img.alt = altText || name || 'Game';
        img.loading = 'lazy';
        fallbackEl.classList.add('hidden');
        img.addEventListener('error', () => {
            img.classList.add('hidden');
            container.dataset.hasImage = 'false';
            fallbackEl.classList.remove('hidden');
        });
        container.append(img, fallbackEl);
    }

    function attachSimpleThumbFallback(container, imageUrl, altText, fallbackClass, initialsText) {
        const { isSafeImageUrl } = shared.dom;
        const safeUrl = isSafeImageUrl(imageUrl) ? imageUrl : '';
        const fb = createEl('span', safeUrl ? `${fallbackClass} hidden` : fallbackClass, initialsText);
        fb.setAttribute('aria-hidden', 'true');
        if (!safeUrl) {
            container.appendChild(fb);
            return;
        }
        const img = createEl('img');
        img.src = safeUrl;
        img.alt = altText;
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            img.classList.add('hidden');
            fb.classList.remove('hidden');
        });
        container.append(img, fb);
    }

    function buildGameCard(game) {
        const card = createEl('a', 'product-card');
        card.href = `product.html?gameId=${encodeURIComponent(game.id)}`;

        const media = createEl('div', 'game-card-media');
        attachGameMedia(media, {
            imageUrl: game.image_url,
            altText: game.name,
            name: game.name,
            category: game.category,
            compact: false,
        });

        const body = createEl('div', 'game-card-body');
        body.appendChild(createEl('span', 'game-card-title', game.name));
        card.append(media, body);
        return card;
    }

    function buildFlashSaleCard(product, formatRupiah) {
        const card = createEl('div', 'flash-sale-card');
        const link = createEl('a', 'flash-sale-link');
        link.href = `product.html?gameId=${encodeURIComponent(product.game_id)}&fsProductId=${encodeURIComponent(product.product_id)}`;

        const media = createEl('div', 'flash-sale-media');
        attachGameMedia(media, {
            imageUrl: product.game_image_url,
            altText: product.product_name,
            name: product.game_name || product.product_name,
            category: product.game_category || product.category || 'mobile',
            compact: true,
        });

        const discountPct = computeDiscountPercent(product.original_price, product.discount_price);
        if (discountPct > 0) {
            media.appendChild(createEl('span', 'fs-discount-badge', `-${discountPct}%`));
        }

        const info = createEl('div', 'flash-sale-info');
        const priceRow = createEl('div', 'fs-price-row');
        priceRow.appendChild(createEl('span', 'fs-price-discounted', formatRupiah(product.discount_price)));
        if (Number(product.original_price) > Number(product.discount_price)) {
            priceRow.appendChild(createEl('span', 'fs-price-original', formatRupiah(product.original_price)));
        }
        info.append(createEl('span', 'fs-product-name', product.product_name || ''), priceRow);

        const maxUses = Number(product.max_uses);
        const usesCount = Number(product.uses_count);
        if (Number.isFinite(maxUses) && maxUses > 0 && Number.isFinite(usesCount) && usesCount >= 0) {
            const remaining = Math.max(0, maxUses - usesCount);
            const quotaWrap = createEl('div', 'fs-quota');
            const progress = createEl('progress', 'fs-quota-progress');
            progress.max = maxUses;
            progress.value = remaining;
            progress.setAttribute('aria-label', `Sisa kuota ${remaining} dari ${maxUses}`);
            quotaWrap.append(progress, createEl('span', 'fs-quota-text tabular-nums', `Sisa ${remaining}/${maxUses}`));
            info.appendChild(quotaWrap);
        }

        link.append(media, info);
        card.appendChild(link);
        return card;
    }

    shared.storefrontCards = {
        getInitials,
        normalizeCategoryKey,
        getCategoryMeta,
        computeDiscountPercent,
        buildCategoryFallbackArt,
        attachGameMedia,
        attachSimpleThumbFallback,
        buildGameCard,
        buildFlashSaleCard,
    };
})(window);
