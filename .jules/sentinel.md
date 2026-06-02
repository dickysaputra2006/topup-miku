## 2026-06-02 - Insecure Randomness in Deposit Codes
**Vulnerability:** Found `Math.random()` being used to generate `uniqueCode` for user deposits.
**Learning:** `Math.random()` is not cryptographically secure and makes deposit values predictable, which could potentially be abused by malicious users to manipulate payment verifications.
**Prevention:** Always use `crypto.randomInt()` or `crypto.randomBytes()` for any financial or security-sensitive random value generation.
