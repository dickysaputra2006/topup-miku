(function (global) {
    'use strict';

    const app = (global.MikuProduct = global.MikuProduct || {});

    /**
     * Inisialisasi navigasi langkah sticky dan auto-scroll khusus viewport mobile (<= 768px).
     */
    function init() {
        const stepNav = document.getElementById('mobile-step-nav');
        if (!stepNav) return;

        const stepSections = {
            1: document.getElementById('order-step-1'),
            2: document.getElementById('order-step-2'),
            3: document.getElementById('order-step-3'),
            4: document.getElementById('order-step-4'),
        };

        const stepBtns = stepNav.querySelectorAll('.step-nav-btn');
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isMobile = () => window.innerWidth <= 768;

        function scrollToStep(stepNum) {
            if (!isMobile()) return;
            const target = stepSections[stepNum];
            if (!target) return;
            target.scrollIntoView({
                behavior: prefersReducedMotion ? 'instant' : 'smooth',
                block: 'start',
            });
        }

        function setActiveStep(stepNum) {
            stepBtns.forEach(function (btn) {
                var n = parseInt(btn.dataset.step, 10);
                btn.classList.remove('active', 'completed');
                if (n === stepNum) btn.classList.add('active');
                else if (n < stepNum) btn.classList.add('completed');
            });
        }

        // Klik step nav button
        stepNav.addEventListener('click', function (e) {
            if (!isMobile()) return;
            var btn = e.target.closest('.step-nav-btn');
            if (!btn) return;
            var stepNum = parseInt(btn.dataset.step, 10);
            setActiveStep(stepNum);
            scrollToStep(stepNum);
        });

        // IntersectionObserver: update active step saat scroll manual
        if ('IntersectionObserver' in window) {
            var observer = new IntersectionObserver(function (entries) {
                if (!isMobile()) return;
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) return;
                    var match = entry.target.id.match(/order-step-(\d)/);
                    if (!match) return;
                    setActiveStep(parseInt(match[1], 10));
                });
            }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });

            Object.values(stepSections).forEach(function (el) {
                if (el) observer.observe(el);
            });
        }

        // AUTO-SCROLL Step 1 -> Step 2
        // Trigger: mutation pada #validation-result yang menampilkan sukses
        var validationResultEl = document.getElementById('validation-result');
        var step1Done = false;

        if (validationResultEl) {
            new MutationObserver(function () {
                if (!isMobile() || step1Done) return;
                var ok = validationResultEl.querySelector('.validation-result-inline.success, .success');
                if (ok) {
                    setTimeout(function () {
                        if (!isMobile()) return;
                        setActiveStep(2);
                        scrollToStep(2);
                        step1Done = true;
                    }, 600);
                }
            }).observe(validationResultEl, { childList: true, subtree: true, characterData: true });
        }

        var targetIdInput = document.getElementById('target-game-id');
        if (targetIdInput) {
            targetIdInput.addEventListener('input', function () { step1Done = false; });
        }

        // AUTO-SCROLL Step 2 -> Step 3
        // Trigger: click pada product card
        var productListEl = document.getElementById('product-list-container');
        if (productListEl) {
            productListEl.addEventListener('click', function (e) {
                if (!isMobile()) return;
                if (!e.target.closest('.product-card-selectable')) return;
                setTimeout(function () {
                    if (!isMobile()) return;
                    setActiveStep(3);
                    scrollToStep(3);
                }, 350);
            });
        }

        // AUTO-SCROLL Step 3 -> Step 4 (ringan, setelah promo apply)
        var promoResultEl = document.getElementById('promo-result');
        var step3Done = false;

        if (promoResultEl) {
            new MutationObserver(function () {
                if (!isMobile() || step3Done) return;
                if (promoResultEl.textContent.trim().length > 0) {
                    setTimeout(function () {
                        if (!isMobile()) return;
                        setActiveStep(4);
                        scrollToStep(4);
                        step3Done = true;
                    }, 700);
                }
            }).observe(promoResultEl, { childList: true, subtree: true, characterData: true });
        }

        // Reset step3Done saat produk diganti
        if (productListEl) {
            productListEl.addEventListener('click', function () { step3Done = false; });
        }

        // Inisialisasi: step 1 active
        setActiveStep(1);
    }

    app.mobileNav = {
        init,
    };
})(window);
