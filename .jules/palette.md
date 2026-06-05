## 2024-06-05 - Add a11y support to toggle-password icons
**Learning:** Found that non-native interactable toggle-password `<i>` elements lack `role="button"`, `tabindex="0"`, dynamic `aria-label`, and keyboard event handlers. They are not accessible to screen readers or keyboard navigation.
**Action:** When using `<i>` elements as buttons, explicitly add `role="button"`, `tabindex="0"`, dynamic `aria-label`, and `keydown` event listeners for 'Enter' and 'Space' keys.
