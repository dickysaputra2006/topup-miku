## 2024-05-18 - [Frontend Search Bottleneck Resolved]
**Learning:** Vanilla JS frontends lacking frameworks often execute search filtering synchronously on every keystroke (`keyup` or `input`). For lists with hundreds of entries, this blocks the main thread and creates input lag.
**Action:** Always inspect native DOM event listeners (e.g., `addEventListener('input')`) for expensive operations. If found, inject a local `debounce` utility directly inside the `DOMContentLoaded` scope to batch executions without polluting the global namespace.
