## 2024-05-18 - [Debounce Search Input]
**Learning:** Implemented a debounce function for the global search input in `script.js` to reduce unnecessary DOM manipulations and potential performance bottlenecks during filtering of large game datasets.
**Action:** Consider applying this pattern to other search inputs in the application, such as in `admin.js`, `compare-prices.js`, and `validate.js`, which currently filter synchronously on every keystroke.
