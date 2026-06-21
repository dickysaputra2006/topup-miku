## 2024-06-21 - Add missing ARIA labels to icon-only interactive elements
**Learning:** Several interactive elements functioning as buttons (like modal close buttons, notification bells) lacked screen reader context (missing `aria-label` and sometimes `role="button"` for non-native elements). This severely hindered accessibility for visually impaired users.
**Action:** Ensure all icon-only buttons (`<button>`, or `<div>`/`<i>` with click listeners) have clear, descriptive `aria-label` attributes and appropriate ARIA roles/tabindex if they are not native buttons.
