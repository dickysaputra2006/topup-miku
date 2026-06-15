## 2026-06-15 - Cache Static JSON Reads in Route Handlers
**Learning:** Reading and parsing large static JSON files (like `data_cekid.json`) on every request causes unnecessary disk I/O and CPU overhead.
**Action:** Implement in-memory caching for statically loaded JSON files in route handlers to serve subsequent requests from memory.
