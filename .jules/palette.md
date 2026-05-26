## 2025-02-09 - Accessible Password Toggles
 **Learning:** Icon-only password toggles using `<i>` elements are inherently inaccessible to screen readers and keyboard users, leading to a poor UX for users relying on assistive technologies to verify their passwords.
 **Action:** Always add `role="button"`, `tabindex="0"`, dynamic `aria-label` attributes corresponding to the visual state, and `keydown` event listeners for 'Enter' and 'Space' to non-native interactive toggles.
