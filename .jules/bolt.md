## 2024-04-30 - Prevent Main-Thread Blocking on Vanilla JS Inputs
**Learning:** In a vanilla HTML/JS application, triggering expensive synchronous operations (like filtering large arrays and re-rendering DOM elements) on every keystroke (`input` event) causes significant UI lag because it blocks the main thread.
**Action:** Always implement and apply a `debounce` utility function to search inputs handling large datasets to batch rapid keystrokes and defer the expensive calculations.
