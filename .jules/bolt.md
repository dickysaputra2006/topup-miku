## 2026-07-05 - In-memory JSON caching
**Learning:** Statically loaded JSON validation data (e.g., utils/validators/data_cekid.json) causes unnecessary disk I/O and parsing overhead on endpoints like /api/games/validatable when read on every request.
**Action:** Cache static JSON parsing results in-memory within the backend server state (e.g., in a top-level variable) to improve endpoint response time and reduce overhead.
