## 2026-07-06 - Reduce 1+1 queries and avoid lock contention in transaction routes
**Learning:** Joining tables inside a `FOR UPDATE` query in Postgres locks all joined tables unless explicitly restricted, which causes severe concurrency bottlenecks when locking shared rows (like the `roles` table).
**Action:** Always fetch related configurations using a `JOIN` instead of separate 1+1 queries, but be careful to specify `FOR UPDATE OF u` (the target table alias) so that shared tables aren't locked during transactions.
