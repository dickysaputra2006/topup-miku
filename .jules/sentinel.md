## 2024-05-18 - Predictable Transaction Identifiers
**Vulnerability:** Transaction IDs and deposit codes were generated using `Date.now()` and `Math.random()`.
**Learning:** Predictable identifiers can lead to callback forgery or enumeration attacks.
**Prevention:** Always use `crypto.randomBytes` or `crypto.randomInt` for generating sensitive identifiers.