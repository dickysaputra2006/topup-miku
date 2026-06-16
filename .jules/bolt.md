## 2026-06-16 - Prevent repeated file I/O in route handlers
 **Learning:** Statically loaded JSON files (like `data_cekid.json`) accessed within route handlers cause repeated disk reads and JSON parsing overhead on every request.
 **Action:** Implement an in-memory cache variable outside the route handler to store the parsed data on the first request and serve it directly on subsequent requests.
