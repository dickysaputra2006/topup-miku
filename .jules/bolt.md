## 2026-07-04 - Prevent Disk I/O on Static JSON Endpoints
**Learning:** Reading and parsing static JSON files (like data_cekid.json) on every API request causes unnecessary disk I/O and CPU overhead.
**Action:** Cache the parsed and transformed static JSON data in-memory on the first request to eliminate parsing overhead for subsequent requests.
