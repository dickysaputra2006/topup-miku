## 2023-11-20 - Predictable Transaction IDs Callback Forgery
**Vulnerability:** Predictable transaction IDs generated using `WEB-${Date.now()}` and `H2H-PROVIDER-${Date.now()}` which allowed attackers to forge Foxy API callbacks.
**Learning:** Hardcoded text appended by `Date.now()` is not random or secure and could easily be brute forced or predicted by an attacker looking at the order request timestamp.
**Prevention:** Use cryptographically secure random number generators for important values like callback IDs. To prevent callback forgery, we replaced predictable values with a random 16 character hex string.
