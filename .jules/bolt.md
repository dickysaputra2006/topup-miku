## 2026-06-17 - Caching Static JSON Read
 **Learning:** Repeated file system reads and JSON parsing in Express route handlers for static configuration files (like data_cekid.json) can create unnecessary disk I/O and CPU bottlenecks on every request.
 **Action:** Implement an in-memory cache variable outside the route handler to store the parsed object on the first request and serve it instantly on subsequent requests.
