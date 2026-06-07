## 2024-05-24 - [Fix Predictable Random Generation]
**Vulnerability:** Weak random number generation in deposit unique codes (`Math.random()`) and predictable timestamp-based IDs (`Date.now()`) for transactions.
**Learning:** `Math.random()` and `Date.now()` are predictable and unsuitable for generating identifiers where unpredictability and cryptographic security are required (like payment references).
**Prevention:** Always use cryptographically secure pseudo-random number generators (CSPRNG) like `crypto.randomBytes()` or `crypto.randomInt()` for security-critical random value generation.
