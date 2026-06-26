## $(date +%Y-%m-%d) - Interactive Element Accessibility
**Learning:** Icon-only toggles (like password visibility) require ARIA labels that dynamically update to announce the correct state to screen readers. We should also give them role="button" and tabindex="0" with keyboard event listeners to make them navigable and interactive for keyboard users since they aren't native `<button>` elements.
**Action:** Always add keyboard event handlers (Enter/Space) and dynamic `aria-label` updates for icon-only toggles.
