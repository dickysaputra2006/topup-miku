## 2024-05-24 - Predictable Transaction IDs

**Vulnerability:** The application used `Date.now()` without additional randomness to generate transaction IDs (`provider_trx_id`, `invoiceId`) and reference IDs for manual balance adjustments.
**Learning:** Using time-based values alone for IDs that act as secure references or are part of callback flows is predictable. An attacker could potentially forge a success callback if they can guess the `provider_trx_id`.
**Prevention:** Always incorporate cryptographically secure randomness, such as `crypto.randomBytes(8).toString('hex')`, when generating identifiers that have security implications.
