
## 2026-06-01 - Accessible Password Toggle
**Learning:** Icon-only non-native elements (like `<i>` for password toggle) require dynamic ARIA label updates alongside their visual state changes to remain accurate for screen readers, as well as explicit keyboard event handling for space/enter keys.
**Action:** Always extract the toggle logic into a shared handler for both `click` and `keydown` events, update `aria-label` dynamically, and use `e.preventDefault()` for the Space key.
