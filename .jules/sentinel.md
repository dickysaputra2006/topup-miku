## 2024-06-06 - Replace insecure Math.random with crypto.randomInt
**Vulnerability:** Found `Math.random()` being used to generate unique codes for deposit transactions.
**Learning:** `Math.random()` generates predictable values which shouldn't be used for transaction uniqueness like deposit codes, potentially leading to collision or manipulation of deposit amounts.
**Prevention:** Always use `crypto.randomInt()` or `crypto.randomBytes()` for generating sensitive codes and cryptographic purposes.
