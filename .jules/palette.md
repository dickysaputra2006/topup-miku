## 2025-02-28 - Missing ARIA Labels on Icon-only Action Buttons
**Learning:** Across the vanilla HTML application, many icon-only interactable elements (such as FontAwesome icons for hamburger menus and 'x' characters for closing modals) lacked explicit `aria-label` or `aria-labelledby` attributes. Without these attributes, screen reader users would find it difficult or impossible to understand the purpose of the buttons.
**Action:** Always ensure that icon-only interactive elements contain explicit `aria-label` attributes describing their primary function.
