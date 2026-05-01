## 2024-05-24 - Debouncing in Bundler-less Vanilla JS
**Learning:** In a vanilla JS frontend without a build step or bundler, importing external libraries like `lodash` for simple utilities is impractical. Without debouncing, rapid user input on large datasets (e.g., filtering `allGamesData`) synchronously blocks the main thread, leading to noticeable UI lag.
**Action:** Implement and use a lightweight, locally-scoped `debounce` function wrapper for input event listeners to batch keystrokes and maintain responsiveness.
