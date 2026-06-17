## 2024-05-22 - Missing Transactions Foreign Key Index Optimization
**Learning:** The `transactions` table lacks an index on the `user_id` foreign key. In endpoints like `/api/user/transactions` and `/api/user/transaction-summary` which query `transactions` by `user_id`, performance could degrade significantly as the `transactions` table grows (N+1 lookups or sequential scans over a large table).
**Action:** Add an index on `user_id` in the `transactions` table, optionally covering `created_at` DESC as we generally order by that.
## 2024-05-22 - Optimize File I/O in Hot Path
**Learning:** File I/O and JSON parsing inside a route handler (like reading data_cekid.json) creates unnecessary disk reads and CPU overhead on every request. Caching static or rarely changing file data in memory eliminates this bottleneck.
**Action:** Add in-memory cache variables for statically loaded JSON files to serve subsequent requests instantly without hitting the disk.
