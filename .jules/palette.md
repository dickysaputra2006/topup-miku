## 2025-05-07 - Missing Global Focus Indicator
**Learning:** This app's styling heavily relies on modern aesthetic resets but lacks a global focus outline, meaning keyboard navigation provides zero visual feedback, leaving the site mostly inaccessible to keyboard users out of the box.
**Action:** Always ensure a global `:focus-visible` rule is implemented early in the CSS to preserve keyboard accessibility without compromising mouse user aesthetics.

## 2025-05-07 - Div as Icon-Only Buttons
**Learning:** Certain interactive components, such as the notification bell in the header, are styled as buttons (`header-icon-btn`) but implemented using semantically incorrect tags like `<div>` without roles, making them invisible to screen readers and unreachable via keyboard.
**Action:** When an app uses `<div>` or `<i>` for icon-only interactive elements, ensure to add `role="button"`, `tabindex="0"`, and `aria-label` to make them fully accessible.
## 2025-05-07 - Refactoring Div to Button
**Learning:** Initially changed an interactive `<div>` (acting as an icon-only button) to have `role="button"` and `tabindex="0"`. However, during review, it was noted that while this makes the element focusable and announced properly by screen readers, a `<div>` does not inherently fire a click event when activated via keyboard (Enter/Space). A proper `<button>` tag automatically handles keyboard interaction logic without requiring custom JavaScript keydown event handlers.
**Action:** Always prefer refactoring interactive elements natively functioning as buttons to the semantic `<button>` tag instead of slapping roles and tabindexes on a `<div>` or `<i>`.
