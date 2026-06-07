## 2024-06-07 - In-Memory Cache for Static File
**Learning:** Performing disk I/O and JSON parsing for static files like `data_cekid.json` on every API request causes unnecessary performance overhead and bottlenecks.
**Action:** Implement an in-memory variable cache in route handlers when serving static or rarely changed data to serve repeated requests faster.
