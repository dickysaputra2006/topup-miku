## 2025-04-29 - Missing ARIA Labels on Icon-only Buttons
**Learning:** Found a recurring accessibility pattern where icon-only buttons (like hamburger menus `fa-bars` and modal close buttons `&times;`) lacked `aria-label` attributes.
**Action:** Always ensure all icon-only interactable elements possess explicit `aria-label` describing their function (e.g., "Tutup" or "Buka menu navigasi" for Indonesian locale).
