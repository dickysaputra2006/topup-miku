## 2025-03-01 - Missing ARIA Labels on `&times;` and Icon-only Buttons
**Learning:** Found a recurring pattern in the frontend where modal close buttons using HTML entity `&times;` and action buttons using only FontAwesome icons (`<i class="fas fa-*"></i>`) lack `aria-label`s. This makes them read poorly or not at all on screen readers.
**Action:** Always add explicit `aria-label` attributes to any `<button>` that lacks visible, readable text content, especially those using icons or HTML symbols like `&times;`.
