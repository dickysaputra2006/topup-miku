## 2025-02-18 - Caching Static Files in Route Handlers
**Learning:** In this Node.js architecture, reading and parsing large static JSON files (like `data_cekid.json`) on every request within route handlers creates unnecessary disk I/O and CPU overhead.
**Action:** Implement an in-memory cache for static JSON files that are read during route execution to avoid reading them on every request.
