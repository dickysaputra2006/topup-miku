## 2026-07-02 - Cache static JSON data in memory
**Learning:** The `/api/games/validatable` endpoint reads and parses a static JSON file (`data_cekid.json`) on every request, which incurs unnecessary disk I/O and JSON parsing overhead.
**Action:** Statically loaded JSON validation data should be cached in-memory within `backend/server.js` to prevent repeated disk I/O and parsing overhead.
