
## 2025-05-28 - Avoid DB Micro-Optimizations in Cold Paths
**Learning:** Consolidating duplicate user checks and role lookups into subqueries during registration doesn't yield measurable performance improvements, as the process is bottlenecked by `bcrypt.hash`. It only reduces readability and increases the risk of subtle SQL bugs.
**Action:** Focus on frontend UX optimizations (like debouncing) or caching high-traffic endpoints rather than micro-optimizing cold paths like registration.
