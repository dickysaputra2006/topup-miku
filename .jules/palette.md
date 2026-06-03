## 2024-05-24 - Improve Password Toggle Accessibility
**Learning:** Icon-only toggles (like the "eye" icon for passwords) using `<i>` elements lack semantic meaning, keyboard support, and screen reader announcements. Using non-native elements as buttons requires explicit ARIA roles, tabindex, keydown event handling, and dynamic `aria-label` updates.
**Action:** Always add `role="button"`, `tabindex="0"`, dynamic `aria-label` attributes, and `keydown` listeners (handling Enter/Space) to icon-only toggles like `.toggle-password` to ensure full accessibility.
