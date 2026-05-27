## 2024-05-27 - Cache Static JSON Parses
**Learning:** Parsing large JSON files (like `data_cekid.json`) on every request blocks the main thread and introduces significant disk I/O and CPU overhead.
**Action:** Always implement in-memory caching for data derived from static JSON files that are read in hot path endpoint handlers.
