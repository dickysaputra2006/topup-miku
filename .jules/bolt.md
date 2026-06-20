## 2026-06-20 - Cache statically loaded validation JSON in memory
**Learning:** The `/api/games/validatable` endpoint was performing disk I/O and JSON parsing of a static file on every request.
**Action:** Used an in-memory cache variable (`cachedValidatableGames`) to store the parsed and mapped result on the first request, avoiding unnecessary overhead on subsequent calls.
