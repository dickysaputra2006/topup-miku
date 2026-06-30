## 2026-06-30 - Accessible Icon-Only Toggle Buttons
**Learning:** Non-native icon-only toggle buttons (like password visibility icons) lack keyboard accessibility and screen reader support by default.
**Action:** Always add role="button", tabindex="0", and dynamically update the aria-label with JS when the visual state changes. Also, ensure :focus-visible styles are provided for keyboard navigation.
