## 2026-06-09 - Caching Static JSON Reads in Route Handlers
**Learning:** Reading and parsing statically loaded JSON files (like `data_cekid.json`) on every request in route handlers causes unnecessary disk I/O and CPU overhead.
**Action:** Implement an in-memory cache variable outside the route handler to store the parsed data and serve it on subsequent requests.
