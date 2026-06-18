## 2026-06-18 - Avoid repeated disk I/O for static JSON
**Learning:** Reading statically loaded JSON files (`data_cekid.json`) within backend route handlers causes unnecessary disk reads and JSON parsing overhead on every request.
**Action:** Implement an in-memory cache variable outside the route handler to store the parsed result after the first request, drastically reducing response time for subsequent calls.
