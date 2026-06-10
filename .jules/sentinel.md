## 2026-06-10 - Insecure Randomness in Financial Transactions
**Vulnerability:** Found `Math.random()` used to generate unique codes for financial deposits.
**Learning:** This codebase lacked cryptographically secure generation for payment identifiers, which could allow attackers to predict deposit unique codes.
**Prevention:** Always use `crypto.randomInt()` or `crypto.randomBytes()` for any random values involved in financial or security-critical logic.
