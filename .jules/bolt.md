## 2026-06-21 - Cache statically loaded JSON data
**Learning:** Discovered an anti-pattern where a ~27KB static JSON file (`data_cekid.json`) was being read from disk and parsed synchronously on every single request to `/api/games/validatable`, creating unnecessary disk I/O and CPU bottlenecks.
**Action:** Always implement simple in-memory variables to cache data that originates from static configuration files, especially for public/frequently-accessed endpoints.
