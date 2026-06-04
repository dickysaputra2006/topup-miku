## 2024-06-04 - Caching static JSON reading for validatable games
**Learning:** Static JSON reading with `fs.readFile` and parsing at `/api/games/validatable` adds disk I/O and JSON parsing overhead on every request.
**Action:** Implement an in-memory cache to store parsed data and reuse it to optimize performance.
