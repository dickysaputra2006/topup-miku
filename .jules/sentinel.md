
## 2024-05-08 - Predictable Transaction IDs in Order Creation
**Vulnerability:** Transaction IDs (`invoiceId` and `provider_trx_id`) were generated predictably using `Date.now()`. This is an enumeration and spoofing risk.
**Learning:** `Date.now()` does not provide adequate entropy for secure identifiers. Attackers could guess these IDs to track business logic, enumerate orders, or potentially spoof provider callbacks in Insecure Direct Object Reference (IDOR) attacks.
**Prevention:** Use cryptographically secure random bytes (e.g., `crypto.randomBytes(8).toString('hex')`) in addition to or instead of timestamps for any critical transaction or invoice IDs.
