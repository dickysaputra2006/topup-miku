## 2024-05-24 - Debouncing Synchronous DOM Filtering
**Learning:** Filtering large arrays and manipulating the DOM synchronously on every keystroke (e.g., in a search input) blocks the main thread, leading to a sluggish UI and degraded perceived performance.
**Action:** Always wrap search input event handlers with a `debounce` function (e.g., with a 300ms delay) to batch keystrokes and defer expensive filtering/DOM update operations until the user pauses typing.
