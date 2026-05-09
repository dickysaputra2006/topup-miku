## 2026-05-09 - [Add Debounce to Vanilla JS Inputs]
**Learning:** In vanilla JS setups without a framework or bundler, simple custom `debounce` wrappers injected into the DOMContentLoaded context provide a massive performance win for frequent events (like `input`) without requiring external dependencies like Lodash, preventing UI stuttering during array filtering.
**Action:** Always wrap frequent user-triggered UI logic (such as searching/filtering DOM elements or large arrays) in a simple debounce function if it's missing in a vanilla JS context.
