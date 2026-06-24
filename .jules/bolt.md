## 2026-06-24 - Cache Statically Loaded JSON Validations
**Learning:** Statically loaded JSON validation data (e.g., utils/validators/data_cekid.json) was being read and parsed on every request to /api/games/validatable, causing unnecessary disk I/O and parsing overhead.
**Action:** Cache the parsed JSON data in-memory within the backend server to prevent repeated disk I/O and parsing overhead on subsequent requests.
