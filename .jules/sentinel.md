## 2025-01-20 - Predictable Transaction IDs and Unique Codes
**Vulnerability:** Transaction and reference IDs generated using `Date.now()`, and unique deposit codes generated using `Math.random()`.
**Learning:** Using time-based or non-cryptographic random functions for sensitive identifiers makes them predictable, enabling callback forgery and enumeration attacks.
**Prevention:** Always use `crypto.randomBytes()` for random hex IDs and `crypto.randomInt()` for random numerical ranges in security or financial contexts.
