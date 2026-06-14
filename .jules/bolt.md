## 2026-06-14 - Caching Static JSON Reads in Route Handlers
**Learning:** Route handlers performing file I/O to read static JSON files (like `data_cekid.json`) on every request create an unnecessary bottleneck through repeated disk reads and JSON parsing overhead.
**Action:** Implement an in-memory cache variable outside the route handler so the disk read and JSON parsing only happen once.
