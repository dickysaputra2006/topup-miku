## 2026-06-02 - Caching static JSON reads in route handlers
**Learning:** Reading and parsing static JSON files (like `data_cekid.json`) on every request within Express route handlers causes unnecessary disk I/O and JSON parsing overhead, which can become a bottleneck under high load.
**Action:** Always implement an in-memory cache variable outside the route handler for static files that don't change at runtime, so the file is read and parsed only once on the first request.
