## 2024-05-24 - Cache statically loaded JSON files
**Learning:** Reading statically loaded JSON files or performing file I/O within backend route handlers (like `data_cekid.json`) causes unnecessary disk reads and JSON parsing overhead on every request.
**Action:** Implement an in-memory cache to prevent repeated disk reads and JSON parsing overhead on every request.
