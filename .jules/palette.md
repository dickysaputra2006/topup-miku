## 2026-06-08 - Accessible Icon-Only Password Toggles
**Learning:** When making non-native icon-only elements (like password visibility toggles) accessible, they need `role="button"`, `tabindex="0"`, dynamic `aria-label` updates ('Tampilkan password' / 'Sembunyikan password'), and keyboard support (Space and Enter) with `e.preventDefault()` on Space to prevent scrolling.
**Action:** Always apply this complete accessibility pattern to interactive non-native elements, ensuring visual and semantic state remain synchronized for screen readers.
