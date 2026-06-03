## 2026-06-03 - Insecure Randomness in Deposit Codes
**Vulnerability:** Used Math.random() to generate unique codes for deposit transactions.
**Learning:** Math.random() is not cryptographically secure and predictable, which could be exploited in financial transactions.
**Prevention:** Always use crypto.randomInt() or crypto.randomBytes() for security-sensitive random number generation, especially in financial operations.
