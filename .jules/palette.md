## 2024-06-02 - Initialize Palette Journal
**Learning:** Establishing the journal for tracking critical UX and accessibility learnings for this repository.
**Action:** Use this file to log significant findings related to accessibility and UX patterns in this codebase.

## 2024-06-02 - Toggle Password Accessibility
**Learning:** Non-native interactable elements (like icon-only toggle buttons for passwords) require ARIA labels, roles, tabindex, and keyboard event handlers (Space/Enter) to be accessible to screen readers and keyboard users.
**Action:** Add full keyboard accessibility support for any interactive elements, including `role="button"`, `tabindex="0"`, and `keydown` handlers alongside standard `click` listeners.
