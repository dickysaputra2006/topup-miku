## 2026-06-26 - In-Memory Caching for Static JSON Files
**Learning:** Parsing static JSON files like `data_cekid.json` on every request causes unnecessary disk I/O and CPU parsing overhead.
**Action:** Declare `let cachedValidatableGames = null;` at the module scope and populate it on the first request to eliminate this bottleneck for subsequent requests.
