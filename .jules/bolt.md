## 2024-05-06 - Front-end Debounce Utility
**Learning:** The vanilla JavaScript frontend lacks a module bundler, meaning that shared utilities cannot be simply imported. Attempting to filter large datasets on every keystroke (`input` event) can block the main thread.
**Action:** When adding utility functions like `debounce`, define them locally within each file's `DOMContentLoaded` event listener to avoid global namespace pollution, and apply them to frequent event handlers to maintain UI responsiveness.
