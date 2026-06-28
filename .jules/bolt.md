## 2026-06-28 - Cache Static JSON Validation Data
**Learning:** Statically loaded JSON validation data (e.g., `utils/validators/data_cekid.json`) causes repeated disk I/O and parsing overhead if read synchronously or asynchronously on every request.
**Action:** Cache the parsed and transformed JSON data in-memory on the first request to prevent repeated disk I/O and parsing overhead on endpoints like `/api/games/validatable`.
