## 2024-05-16 - Make non-native toggle buttons accessible
**Learning:** Interactive icons used as toggles (like password visibility) without explicit aria-label, role="button", tabindex="0" and keyboard listeners are completely inaccessible to screen reader and keyboard users.
**Action:** Add role="button", tabindex="0", dynamic aria-label, and custom keydown event listeners to icon toggles. Ensure aria-label updates alongside state changes.
