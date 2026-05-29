## 2024-05-29 - Caching Statically Loaded JSON Files
**Learning:** Repeatedly reading and parsing static JSON files (like `data_cekid.json`) inside backend route handlers introduces unnecessary disk I/O and JSON parsing overhead on every request, creating a performance bottleneck for frequently accessed endpoints.
**Action:** Always implement an in-memory cache for static JSON responses within route handlers to serve subsequent requests directly from RAM, bypassing disk access and parsing entirely.
