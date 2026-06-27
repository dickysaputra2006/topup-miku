## 2026-06-27 - Add aria-label and keyboard accessibility to toggle password visibility
**Learning:** Icon-only toggles (like password visibility) lack context for screen readers and need dynamic `aria-label` attributes and keyboard accessibility support (e.g., adding `tabindex="0"` and a keyboard event listener).
**Action:** When adding non-native icon-only toggle buttons, always include `role="button"`, `tabindex="0"`, dynamic `aria-label` updates, and keyboard interaction.
