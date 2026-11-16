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
        const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isMobile = () => window.innerWidth <= 768;

        function scrollToStep(stepNum) {
            if (!isMobile()) return;
            const target = stepSections[stepNum];
            if (!target || typeof target.scrollIntoView !== 'function') return;
            target.scrollIntoView({
                behavior: prefersReducedMotion ? 'instant' : 'smooth',
                block: 'start',
            });
        }

        function setActiveStep(stepNum) {
            stepBtns.forEach((btn) => {
                const n = parseInt(btn.dataset.step, 10);
                btn.classList.remove('active', 'completed');
                if (n === stepNum) btn.classList.add('active');
                else if (n < stepNum) btn.classList.add('completed');
            });
        }

        stepNav.addEventListener('click', (e) => {
            if (!isMobile()) return;
            const btn = e.target.closest('.step-nav-btn');
            if (!btn) return;
            const stepNum = parseInt(btn.dataset.step, 10);
            setActiveStep(stepNum);
            scrollToStep(stepNum);
        });

        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver((entries) => {
                if (!isMobile()) return;
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    const match = entry.target.id.match(/order-step-(\d)/);
                    if (match) setActiveStep(parseInt(match[1], 10));
                });
            }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });

            Object.values(stepSections).forEach((el) => {
                if (el) observer.observe(el);
            });
        }

        const productListEl = document.getElementById('product-list-container');
        if (productListEl) {
            productListEl.addEventListener('click', (e) => {
                if (!isMobile()) return;
                if (!e.target.closest('.product-card-selectable')) return;
                setTimeout(() => {
                    if (!isMobile()) return;
                    setActiveStep(3);
                    scrollToStep(3);
                }, 350);
            });
        }

        const promoResultEl = document.getElementById('promo-result');
        let step3Done = false;
        if (promoResultEl && 'MutationObserver' in window) {
            new MutationObserver(() => {
                if (!isMobile() || step3Done) return;
                if (promoResultEl.textContent.trim().length > 0) {
                    setTimeout(() => {
                        if (!isMobile()) return;
                        setActiveStep(4);
                        scrollToStep(4);
                        step3Done = true;
                    }, 600);
                }
            }).observe(promoResultEl, { childList: true, subtree: true, characterData: true });
        }

        if (productListEl) {
            productListEl.addEventListener('click', () => { step3Done = false; });
        }

        setActiveStep(1);
    }

    app.mobileNav = {
        init,
    };
})(window);
