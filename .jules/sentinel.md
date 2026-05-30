## YYYY-MM-DD - Callback Forgery via Predictable Transaction IDs
**Vulnerability:** Transaction IDs sent to third-party payment/providers were generated using `Date.now()`.
**Learning:** Because these IDs were predictable, an attacker could guess the pending ID and forge the asynchronous callback to falsely fail the transaction locally. This allowed the attacker to get their local balance refunded while the transaction proceeded successfully.
**Prevention:** Always append cryptographically secure random bytes (e.g., `crypto.randomBytes(8).toString('hex')`) to transaction and callback IDs to make them unguessable.
