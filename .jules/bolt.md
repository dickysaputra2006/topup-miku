## 2026-06-22 - Pre-calculate invariants outside nested loops
**Learning:** In nested loops over lists (e.g. products map containing roles iteration), calculating strings like `role.name.toLowerCase()` or dividing percentages by 100 inside the inner loop is extremely wasteful and adds latency.
**Action:** Pre-calculate invariants (like lowercased property names and decimal fractions) into an optimized configuration array outside the main loop before iterating.
