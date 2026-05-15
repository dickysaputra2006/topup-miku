## 2024-05-15 - Insecure Random Number Generation for Deposit Codes
**Vulnerability:** Deposit unique codes were generated using `Math.floor(Math.random() * 900) + 100`, making the values predictable.
**Learning:** `Math.random()` is not a cryptographically secure pseudo-random number generator (CSPRNG) and should never be used for security-sensitive operations or generating financial transaction codes.
**Prevention:** Always use Node.js `crypto.randomInt()` or `crypto.randomBytes()` when generating unique codes, tokens, or transaction IDs.
