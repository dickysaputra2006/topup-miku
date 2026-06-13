## 2024-05-24 - Add accessible toggle password buttons
**Learning:** Icon-only toggle buttons for hiding/showing passwords need proper ARIA labels and keyboard accessibility. A JS keydown listener is required to make them operable with the Space/Enter keys, updating the `aria-label` dynamically based on the state.
**Action:** Always add `role="button"`, `tabindex="0"`, and an `aria-label` to these interactive icon-only elements. Update their `aria-label` dynamically using JS when the state changes.
