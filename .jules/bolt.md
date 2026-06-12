## 2026-06-12 - Caching static JSON reads in route handlers
**Learning:** Reading and parsing a static JSON file (like `data_cekid.json`) on every single request to a route handler causes unnecessary file I/O and JSON parsing overhead, creating a performance bottleneck under high load.
**Action:** Implement an in-memory cache variable outside the route handler for statically loaded JSON files to ensure they are only read from disk and parsed once per server lifecycle.
