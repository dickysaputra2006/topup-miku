## 2024-05-23 - [Cache static JSON files in route handlers]
**Learning:** Reading statically loaded JSON files (like `data_cekid.json`) and parsing them on every request introduces unnecessary disk I/O and JSON parsing overhead, which can be a performance bottleneck.
**Action:** Implement an in-memory cache variable outside the route handler to store the parsed data. Return the cached data on subsequent requests to improve endpoint response time and reduce server load.
