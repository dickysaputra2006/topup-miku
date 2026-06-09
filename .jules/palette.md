## 2026-06-09 - Accessible Icon Toggle Buttons
**Learning:** When making non-native icon-only toggle buttons accessible, it's critical to add `role="button"`, `tabindex="0"`, and handle `keydown` events (Enter and Space) with `e.preventDefault()` on Space. Furthermore, the `aria-label` must be dynamically updated in JavaScript to match the visual state (e.g., 'Tampilkan password' -> 'Sembunyikan password') so screen readers accurately reflect the current state.
**Action:** Always verify keyboard interaction and dynamic ARIA label updates for custom toggle buttons.
