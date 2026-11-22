(function (global) {
    'use strict';

    function initHeroCarousel(root) {
        const track = root.querySelector('.hero-carousel-track');
        const slides = Array.from(root.querySelectorAll('.hero-slide'));
        const prevBtn = root.querySelector('[data-carousel-prev]');
        const nextBtn = root.querySelector('[data-carousel-next]');
        const markersNav = root.querySelector('.hero-carousel-markers');
        const statusEl = root.querySelector('#hero-carousel-status');
        if (!track || slides.length === 0) return;

        const reducedMotionQuery = global.matchMedia('(prefers-reduced-motion: reduce)');
        const supportsScrollEnd = 'onscrollend' in global;
        let pendingTargetIndex = null;
        let lastSettledIndex = 0;
        let activeMarkerIndex = 0;
        let rafPending = false;
        let fallbackTimer = null;

        function buildMarkers() {
            if (!markersNav) return [];
            markersNav.textContent = '';
            return slides.map((slide, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'hero-dot';
                btn.setAttribute('aria-label', slide.dataset.markerName || `Pilih slide ${idx + 1}`);
                btn.setAttribute('aria-current', idx === 0 ? 'true' : 'false');
                const pill = document.createElement('span');
                pill.className = 'hero-dot-pill';
                pill.setAttribute('aria-hidden', 'true');
                btn.appendChild(pill);
                btn.addEventListener('click', () => goToSlide(idx));
                markersNav.appendChild(btn);
                return btn;
            });
        }

        const markerButtons = buildMarkers();

        function setActiveMarker(index) {
            if (index === activeMarkerIndex && markerButtons[index]?.getAttribute('aria-current') === 'true') return;
            activeMarkerIndex = index;
            markerButtons.forEach((btn, idx) => {
                btn.setAttribute('aria-current', idx === index ? 'true' : 'false');
            });
        }

        function nearestSlideIndex() {
            const left = track.scrollLeft;
            let bestIdx = 0;
            let bestDist = Infinity;
            slides.forEach((slide, idx) => {
                const dist = Math.abs(slide.offsetLeft - left);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = idx;
                }
            });
            return bestIdx;
        }

        function settleScroll() {
            clearTimeout(fallbackTimer);
            const settled = nearestSlideIndex();
            pendingTargetIndex = null;
            setActiveMarker(settled);
            if (settled !== lastSettledIndex) {
                lastSettledIndex = settled;
                if (statusEl) {
                    statusEl.textContent = `Slide ${settled + 1} dari ${slides.length}`;
                }
            }
        }

        function goToSlide(targetIndex) {
            const count = slides.length;
            const normalized = ((targetIndex % count) + count) % count;
            const targetSlide = slides[normalized];
            if (!targetSlide) return;

            const behavior = reducedMotionQuery.matches ? 'auto' : 'smooth';
            const delta = Math.abs(targetSlide.offsetLeft - track.scrollLeft);
            pendingTargetIndex = normalized;
            setActiveMarker(normalized);

            if (delta < 2 || behavior === 'auto') {
                track.scrollTo({ left: targetSlide.offsetLeft, behavior: 'auto' });
                pendingTargetIndex = null;
                if (normalized !== lastSettledIndex) {
                    lastSettledIndex = normalized;
                    if (statusEl) statusEl.textContent = `Slide ${normalized + 1} dari ${count}`;
                }
                return;
            }

            track.scrollTo({ left: targetSlide.offsetLeft, behavior });
            clearTimeout(fallbackTimer);
            fallbackTimer = setTimeout(settleScroll, 650);
        }

        function stepSlide(delta) {
            const base = pendingTargetIndex !== null ? pendingTargetIndex : nearestSlideIndex();
            goToSlide(base + delta);
        }

        if (prevBtn) prevBtn.addEventListener('click', () => stepSlide(-1));
        if (nextBtn) nextBtn.addEventListener('click', () => stepSlide(1));

        track.addEventListener('scroll', () => {
            if (pendingTargetIndex === null && !rafPending) {
                rafPending = true;
                global.requestAnimationFrame(() => {
                    rafPending = false;
                    if (pendingTargetIndex === null) setActiveMarker(nearestSlideIndex());
                });
            }
            if (!supportsScrollEnd) {
                clearTimeout(fallbackTimer);
                fallbackTimer = setTimeout(settleScroll, 140);
            }
        }, { passive: true });

        if (supportsScrollEnd) {
            track.addEventListener('scrollend', settleScroll, { passive: true });
        }

        root.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const target = e.target;
            if (!target || (!target.closest('.hero-carousel-markers') && !target.closest('.hero-carousel-controls') && target !== track)) {
                return;
            }
            e.preventDefault();
            stepSlide(e.key === 'ArrowRight' ? 1 : -1);
        });

        root.querySelectorAll('[data-flash-sale-cta]').forEach((cta) => {
            cta.addEventListener('click', (e) => {
                const fsSection = document.getElementById('flash-sale-section');
                if (fsSection && fsSection.classList.contains('hidden')) {
                    e.preventDefault();
                    const catalogEl = document.getElementById('catalog-controls');
                    if (catalogEl) {
                        catalogEl.scrollIntoView({ behavior: reducedMotionQuery.matches ? 'auto' : 'smooth' });
                    }
                }
            });
        });

        setActiveMarker(0);
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-hero-carousel]').forEach(initHeroCarousel);
    });
})(window);
