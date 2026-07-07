## 2024-07-07 - In-memory Caching for Static JSON Data
**Learning:** Statically loaded JSON validation data (`utils/validators/data_cekid.json`) was being read from disk and parsed on every request to `/api/games/validatable`, adding unnecessary I/O overhead.
**Action:** Cache static data in-memory at server startup to prevent repeated disk I/O and parsing overhead.
