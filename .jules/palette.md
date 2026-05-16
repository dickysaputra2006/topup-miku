## 2024-05-16 - Accessible Non-Native Toggle Buttons
**Learning:** When making non-native elements (like `<i>` font icons) accessible interactive buttons, adding `role="button"` and `tabindex="0"` is not enough. Screen readers need to know the state of the toggle.
**Action:** Always implement a JavaScript listener to dynamically update the `aria-label` attribute alongside the visual state (e.g., "Tampilkan password" to "Sembunyikan password") and ensure keyboard support (`Enter` and `Space` keys) is added via `keydown` events.
