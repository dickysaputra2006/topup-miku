
## 2025-05-17 - Vanilla JS Frontend Input Debouncing
**Learning:** In vanilla JavaScript frontends without component state management, direct `addEventListener('input', ...)` calls that filter large local data arrays block the main thread synchronously on every keystroke, causing severe UI jank.
**Action:** Implement localized `debounce` utility functions within the `DOMContentLoaded` event listener closures to batch keystrokes and prevent main-thread blocking during local array filtering.
