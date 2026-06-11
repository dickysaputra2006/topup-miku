## $(date +%Y-%m-%d) - Dynamic ARIA Labels for Icon Buttons
**Learning:** When making icon-only toggle buttons accessible (like a password visibility toggle), assigning a static \`aria-label\` is insufficient. The label must dynamically update (e.g., from "Show password" to "Hide password") as the state changes to prevent misleading screen reader announcements.
**Action:** Always implement a JavaScript listener to dynamically update the \`aria-label\` attribute alongside the visual state toggle for any interactive element that changes meaning after interaction.
