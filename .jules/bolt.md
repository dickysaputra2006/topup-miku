## 2024-05-31 - [In-Memory Cache for Static Data Reads]
**Learning:** Route handlers performing repeated synchronous or asynchronous disk reads and parsing operations (e.g., `fs.readFile` and `JSON.parse`) on static files like `data_cekid.json` introduce unnecessary I/O overhead and block the event loop, acting as a measurable performance bottleneck.
**Action:** Always implement an in-memory variable to cache the parsed output of static file reads in route handlers, returning the cached data for subsequent requests to eliminate the I/O and parsing overhead.
