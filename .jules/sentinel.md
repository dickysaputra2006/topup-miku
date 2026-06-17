## 2024-05-22 - [Sentinel Fix Weak Random Number]
**Vulnerability:** Weak random number generation using `Math.random()` for unique financial codes.
**Learning:** Using `Math.random()` is predictable and not cryptographically secure, which allows prediction of deposits.
**Prevention:** Use `crypto.randomInt()` or `crypto.randomBytes()` for cryptographically secure random number generation in sensitive contexts.
