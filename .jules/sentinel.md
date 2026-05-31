## 2024-05-31 - Predictable Transaction IDs
**Vulnerability:** Transaction and invoice IDs (`invoiceId`, `provider_trx_id`, `reference_id`) were generated using only `${Date.now()}` appended with predictable data (like user ID), making them vulnerable to brute-forcing, enumeration, and callback forgery.
**Learning:** Using predictable timestamps alone for sensitive IDs lacks sufficient entropy. Attackers could guess transaction IDs or forge callbacks by predicting the exact time a request was made.
**Prevention:** Append cryptographically secure random bytes (e.g., `crypto.randomBytes(4).toString('hex')`) to timestamps when generating unique IDs. This maintains chronological sorting properties while ensuring unpredictability.
