## 2026-06-19 - In-Memory Cache for Static Data

**Learning:** Reading statically loaded JSON files (e.g., `data_cekid.json`) or performing file I/O within backend route handlers causes repeated disk reads and JSON parsing overhead on every request, creating a performance bottleneck under load.

**Action:** Implement an in-memory cache to store the parsed static data so that subsequent requests bypass the filesystem and parsing, resolving instantly.
