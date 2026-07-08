## 2024-07-08 - Cache validatable games data
**Learning:** Statically loaded JSON validation data (e.g., `utils/validators/data_cekid.json`) should be cached in-memory within `backend/server.js` to prevent repeated disk I/O and parsing overhead on endpoints like `/api/games/validatable`.
**Action:** Use a variable to store the parsed JSON and serve from memory if populated.
