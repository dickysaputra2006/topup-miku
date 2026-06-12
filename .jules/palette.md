## 2025-06-12 - Accessible Password Toggle
**Learning:** Icon-only toggles (like password visibility) need dynamic `aria-label` updates alongside their visual state changes to provide accurate screen reader announcements. Adding keyboard support on non-native interactive elements requires preventing default scroll behavior on Space key.
**Action:** Always add `role="button"`, `tabindex="0"`, keyboard event listeners, and dynamically update `aria-label` (e.g., "Tampilkan password" / "Sembunyikan password") for icon-based toggle actions.
