## 2025-02-20 - Optimize Independent Database Queries
 **Learning:** Executing independent database queries sequentially in endpoints leads to unnecessary response latency due to the waterfall effect.
 **Action:** Identify scenarios where multiple `SELECT` queries do not depend on each other's results and wrap them in a `Promise.all` to run concurrently, reducing wait time significantly.
