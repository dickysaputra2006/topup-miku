## 2024-06-01 - Insecure Random Number Generation for Financial Transactions
**Vulnerability:** Used `Math.random()` to generate unique codes for deposits.
**Learning:** `Math.random()` is not cryptographically secure and can be predictable. It shouldn't be used for anything related to financial transactions or sensitive data.
**Prevention:** Use `crypto.randomInt()` or `crypto.randomBytes()` instead for generating secure random numbers.
