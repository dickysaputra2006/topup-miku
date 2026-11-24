(function (global) {
    'use strict';

    const copyTimers = new WeakMap();
    let lastCopyMessage = '';

    function syncDocsOrigin() {
        const hasHttpOrigin = global.location && /^https?:$/i.test(global.location.protocol);
        const origin = hasHttpOrigin ? global.location.origin : 'https://domain-toko-anda.com';
        document.querySelectorAll('[data-docs-origin]').forEach((el) => {
            el.textContent = origin;
        });
    }

    function reportCopyFeedback(button, succeeded) {
        const wrap = button.closest('.copy-wrap');
        const tip = wrap ? wrap.querySelector('.copy-tip') : null;
        const icon = button.querySelector('i');
        clearTimeout(copyTimers.get(button));
        button.removeAttribute('data-copied');
        button.removeAttribute('data-failed');
        button.setAttribute(succeeded ? 'data-copied' : 'data-failed', '');
        if (icon) icon.className = succeeded ? 'fas fa-check' : 'fas fa-exclamation-triangle';

        let message = succeeded ? 'Tersalin' : 'Gagal salin';
        if (message === lastCopyMessage) message += '\u00A0';
        lastCopyMessage = message;
        if (tip) {
            tip.textContent = '';
            tip.classList.add('is-visible');
            global.requestAnimationFrame(() => { tip.textContent = message; });
        }

        copyTimers.set(button, global.setTimeout(() => {
            button.removeAttribute('data-copied');
            button.removeAttribute('data-failed');
            if (icon) icon.className = 'fas fa-copy';
            if (tip) {
                tip.classList.remove('is-visible');
                tip.textContent = '';
            }
        }, 2000));
    }

    async function handleCopyCommand(button, target) {
        if (!button || !target) return;
        const raw = target.matches('input, textarea') ? target.value : target.innerText;
        const text = String(raw || '').trim();
        if (!text) return;
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && global.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else if (typeof global.MikuShared?.dom?.copyToClipboard === 'function') {
                await global.MikuShared.dom.copyToClipboard(text, { requireSecureContext: false });
            } else {
                throw new Error('Clipboard unavailable');
            }
            reportCopyFeedback(button, true);
        } catch (_) {
            reportCopyFeedback(button, false);
        }
    }

    function bindCopyCommands() {
        if ('CommandEvent' in global) {
            document.addEventListener('command', (event) => {
                if (event.command === '--copy') handleCopyCommand(event.source, event.target);
            }, true);
            return;
        }
        document.addEventListener('click', (event) => {
            if (event.defaultPrevented) return;
            const button = event.target.closest('button[command="--copy"]');
            if (!button) return;
            handleCopyCommand(button, document.getElementById(button.getAttribute('commandfor') || ''));
        });
    }

    function setActiveTocLink(sectionId) {
        document.querySelectorAll('.docs-toc-link').forEach((link) => {
            const match = link.getAttribute('href') === `#${sectionId}`;
            link.classList.toggle('active', match);
            if (match) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        });
    }

    function initTocNavigation() {
        const mobileToc = document.querySelector('.docs-toc-mobile');
        document.querySelectorAll('.docs-toc-link').forEach((link) => {
            link.addEventListener('click', (event) => {
                const href = link.getAttribute('href') || '';
                const target = href.startsWith('#') ? document.getElementById(href.slice(1)) : null;
                if (!target) return;
                event.preventDefault();
                if (mobileToc) mobileToc.open = false;
                global.MikuShared?.storefrontNav?.scrollToSection(target);
                global.history?.replaceState(null, '', href);
                setActiveTocLink(target.id);
            });
        });

        if (!('IntersectionObserver' in global)) return;
        const sections = document.querySelectorAll('section[data-docs-section]');
        if (sections.length === 0) return;
        const observer = new IntersectionObserver((entries) => {
            const visible = entries.filter((entry) => entry.isIntersecting);
            if (visible.length === 0) return;
            visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            setActiveTocLink(visible[0].target.id);
        }, { rootMargin: '-88px 0px -60% 0px', threshold: 0 });
        sections.forEach((section) => observer.observe(section));
    }

    function initCodeTabs() {
        document.querySelectorAll('[data-docs-tabs]').forEach((tablist) => {
            const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
            const activate = (tab) => tabs.forEach((btn) => {
                const selected = btn === tab;
                btn.setAttribute('aria-selected', selected ? 'true' : 'false');
                btn.tabIndex = selected ? 0 : -1;
                const panel = document.getElementById(btn.getAttribute('aria-controls') || '');
                if (panel) panel.classList.toggle('hidden', !selected);
            });
            tabs.forEach((tab, idx) => {
                tab.addEventListener('click', () => activate(tab));
                tab.addEventListener('keydown', (event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                    event.preventDefault();
                    const nextIdx = event.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
                    tabs[nextIdx].focus();
                    activate(tabs[nextIdx]);
                });
            });
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        syncDocsOrigin();
        bindCopyCommands();
        initTocNavigation();
        initCodeTabs();
    });
})(window);
