## 2026-05-30 - In-memory Cache for Static Data Route
**Learning:** Statically loaded JSON files read on every request can be a bottleneck due to disk I/O and JSON parsing overhead.
**Action:** Implement an in-memory cache for static files when possible to avoid repeated disk reads.
