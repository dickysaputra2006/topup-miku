## 2024-05-18 - [Frontend Search Debouncing]
**Learning:** In a vanilla JS environment without external bundlers or frameworks, simple synchronous filtering functions on `input` events for search bars can severely block the main thread and degrade performance when filtering large static arrays.
**Action:** Always implement a local `debounce` utility pattern (using standard `setTimeout`/`clearTimeout`) wrapped around frequent user-triggered event listeners like `input` to batch execution and maintain UI responsiveness, ensuring the function is scoped securely (e.g. within `DOMContentLoaded`).
