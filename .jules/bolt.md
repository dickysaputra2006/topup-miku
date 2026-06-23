## 2026-06-23 - In-Memory Caching for Static JSON Data
**Learning:** Parsing static JSON files (like data_cekid.json) on every request causes unnecessary disk I/O and CPU parsing overhead.
**Action:** Cache the parsed JSON data in-memory at the module level (e.g., let cachedData = null) and reuse it across requests.
