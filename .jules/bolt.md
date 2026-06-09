## 2024-04-27 - Performance Optimization: Debounce Search Inputs
**Learning:** Found multiple instances where search inputs filtered large arrays of games synchronously on the main thread for every `input` keystroke. This causes unneeded DOM updates and CPU overhead.
**Action:** Implemented a debounce utility and applied it to `script.js`, `admin.js`, `compare-prices.js`, and `validate.js` to batch typing events. Next time, always check `addEventListener('input')` on search fields for debounce opportunities.
