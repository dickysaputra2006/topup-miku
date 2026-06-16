## 2026-06-16 - Accessible modals and icon buttons
**Learning:** Icon-only buttons like hamburger menus and "times" close modal buttons consistently lack `aria-label`s. Also modal close buttons lacked clear keyboard focus states making keyboard navigation difficult.
**Action:** Always add `aria-label` to buttons without text content, and ensure interactive elements have clear `:focus-visible` styling (like `outline: 2px solid var(--primary-color);`).
