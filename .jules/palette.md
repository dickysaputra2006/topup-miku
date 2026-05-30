## 2024-05-30 - Accessible Password Toggles
**Learning:** Icon-only toggles (like FontAwesome eyes for password visibility) are inaccessible to screen readers and keyboard users if left as bare `<i>` tags. They need `role="button"`, `tabindex="0"`, dynamic `aria-label`s, and `keydown` event listeners that support Enter and Space.
**Action:** When implementing non-native buttons, always add these four ARIA/keyboard attributes. Crucially, remember to call `e.preventDefault()` on the Space key within the `keydown` handler to prevent unwanted page scrolling.
