## 2024-05-28 - [Cache Static File Reads]
**Learning:** Performing file I/O and JSON parsing for static files (like data_cekid.json) inside frequently accessed route handlers is a major performance bottleneck that wastes CPU and blocks the event loop.
**Action:** Always implement an in-memory cache (or load on startup) for statically loaded data to prevent repeated disk reads and JSON parsing overhead on every request.
