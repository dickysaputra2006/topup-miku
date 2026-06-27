## 2026-06-27 - Cached Validatable Games JSON parsing
**Learning:** `data_cekid.json` is statically loaded but was being read from disk and parsed on every request to `/api/games/validatable`.
**Action:** Always cache statically loaded JSON data in memory when possible to prevent redundant disk I/O and JSON parsing overhead, especially on frequently accessed endpoints.
