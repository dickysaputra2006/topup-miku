## 2026-07-04 - ARIA labels for icon-only buttons
**Learning:** Icon-only buttons (like hamburger menus or close modal buttons) in this application lack ARIA labels, making them inaccessible to screen readers.
**Action:** Always add descriptive `aria-label` attributes to any interactive element that relies entirely on visual icons (like font-awesome icons or text symbols like &times;) for its meaning.
