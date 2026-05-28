## 2025-03-08 - Accessible Password Toggles
**Learning:** Non-native icon-only toggles (like `<i>` tags for password visibility) need dynamic `aria-label` updates along with visual state changes to accurately convey their status to screen readers. They also require explicit `role="button"`, `tabindex="0"`, and `keydown` listeners for keyboard accessibility.
**Action:** Always include keyboard support and dynamic ARIA attributes when implementing non-native interactive toggles.
