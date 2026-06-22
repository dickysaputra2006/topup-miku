## 2026-06-22 - Make password visibility toggles accessible
**Learning:** Icon-only toggle buttons need dynamic ARIA labels and a keyboard listener for space/enter. `classList.toggle` logic can get confusing if boolean arguments don't align intuitively with the visual representation.
**Action:** Always add keyboard interaction and dynamically update `aria-label` for screen readers based on the toggled state.
