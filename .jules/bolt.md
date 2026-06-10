## 2026-06-10 - Cache static JSON reads in route handlers
**Learning:** Reading statically loaded JSON files inside route handlers causes I/O and JSON parsing overhead on every request.
**Action:** Implement in-memory caching for statically loaded JSON files to prevent repeated disk reads and parsing overhead.
