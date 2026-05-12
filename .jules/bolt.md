## 2023-10-27 - [Debounce Frontend Search]
**Learning:** [The vanilla JavaScript frontend performs synchronous array filtering (e.g., `filter` and `renderGamesDropdown`) on every single keystroke during search input events. This can cause severe main-thread blocking and jank when dealing with large datasets of games.]
**Action:** [Apply a simple debounce utility function locally within each file's `DOMContentLoaded` block to batch these input events. Wait for ~300ms of user inactivity before executing the expensive filter and render operations to maintain a smooth UX.]
