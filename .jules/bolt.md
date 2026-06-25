## 2026-06-25 - Initializing Bolt Journal\n**Learning:** Started keeping track of performance optimizations.\n**Action:** Will document critical learnings here.
## 2026-06-25 - In-Memory Caching for Static JSON Files
**Learning:** Parsing large JSON files (like `data_cekid.json`) on every API request causes unnecessary disk I/O and CPU overhead.
**Action:** Cache the parsed and transformed data in-memory at the module level for endpoints serving static data that rarely changes.
