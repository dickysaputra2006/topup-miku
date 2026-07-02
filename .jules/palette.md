## 2025-07-02 - Missing ARIA Labels on Toggle Password Buttons
**Learning:** Found that `.toggle-password` elements used in forms are `<i>` tags without `aria-label` or `role="button"` properties. Without appropriate ARIA labels, screen readers will ignore the eye icon, leaving non-visual users unaware of the ability to show/hide their passwords. Furthermore, the toggle state (e.g. "Tampilkan password" vs "Sembunyikan password") needs to be correctly announced.
**Action:** Always verify that interactive icon elements have `role="button"`, `tabindex="0"` for keyboard accessibility, and a dynamic `aria-label` that reflects the current interaction state.

## 2026-07-02 - Dynamic Boolean State Toggling in ClassList
**Learning:** When using JS to toggle CSS classes dynamically based on boolean states (e.g., `classList.toggle('className', force)`), it's easy to inadvertently invert the logic if the boolean doesn't directly map to the visual state intended by the class.
**Action:** Always explicitly map the force condition to the intended visual state to prevent inverted or logically incorrect UI feedback.
