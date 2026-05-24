## 2024-05-24 - File I/O Optimization for Static Configs
**Learning:** Repeatedly reading and parsing static configuration JSON files on every API request causes unnecessary disk I/O and synchronous parsing overhead, leading to a bottleneck under load.
**Action:** Implement a lazy-initialized in-memory cache variable to parse and map the data once during the first request, then serve the cached version for all subsequent requests.
