## 2026-07-05 - Accessible Icon-Only Password Toggles
**Learning:** Icon-only toggle buttons (like password visibility) require programmatic updates to `aria-label` during state changes, not just visual icon swaps, to ensure screen reader announcements reflect the active state in the correct language.
**Action:** Always implement a JavaScript listener to dynamically update `aria-label` (e.g., 'Tampilkan password' to 'Sembunyikan password') alongside the visual classes, and map boolean logic explicitly to avoid inverted states.
