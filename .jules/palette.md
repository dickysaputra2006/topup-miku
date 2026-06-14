## 2026-06-14 - Accessible Non-Native Toggle Buttons
**Learning:** Icon-only interactive elements like password visibility toggles (`<i>` tags) are completely invisible to screen readers without ARIA labels, and inaccessible to keyboard users without `tabindex`, `role="button"`, `:focus-visible` styles, and keyboard event listeners for Enter/Space.
**Action:** Always add `role="button"`, `tabindex="0"`, `:focus-visible` styles, and implement keyboard listeners that prevent default scrolling and update `aria-label` dynamically based on the current state.
