## 2026-06-13 - In-Memory Cache for Static JSON
**Learning:** Repeatedly reading and parsing static JSON files (e.g., `data_cekid.json`) on every request causes unnecessary disk I/O and CPU overhead for parsing, creating a bottleneck for high-traffic routes.
**Action:** Declare an in-memory cache variable outside the route handler and populate it on the first request to eliminate disk reads and parsing overhead for subsequent requests.
