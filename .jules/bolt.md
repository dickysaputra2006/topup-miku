## 2024-05-25 - Avoid disk I/O in route handlers for static JSON
**Learning:** Parsing static JSON files (like `data_cekid.json`) on every request causes unnecessary disk I/O and JSON parsing overhead on hot paths, slowing down response times and consuming extra CPU/memory resources unnecessarily.
**Action:** Always implement a simple module-level in-memory cache for static files or use `require()` if the file is truly static and doesn't change during the application lifecycle.
