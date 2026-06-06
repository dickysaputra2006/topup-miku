## 2026-06-06 - In-Memory Caching for Static JSON Files
**Learning:** Reading statically loaded JSON files (e.g., `data_cekid.json`) inside backend route handlers causes repeated disk reads and JSON parsing overhead on every request.
**Action:** Declare an in-memory cache variable (`let cache = null;`) outside the route handler and check if populated to prevent redundant disk I/O.
