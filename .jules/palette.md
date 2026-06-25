## 2025-06-25 - Improve Screen Reader Experience for Icon-only Buttons
**Learning:** Icon-only buttons (like password visibility toggles, hamburger menus, and modal close buttons) in this app frequently lack proper ARIA labels. Additionally, for toggle states like password visibility, the ARIA label isn't dynamically updated to reflect the action it will perform.
**Action:** Always verify icon-only interactive elements have semantic meaning (aria-label). For toggleable icons, ensure the JS updates the aria-label when the visual state changes.
