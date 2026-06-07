## 2024-06-07 - Insecure Transaction ID Generation
**Vulnerability:** Transaction IDs (`invoiceId`, `trx_id_provider`, `reference_id`) are generated using `Date.now()` without sufficient randomness. This allows predicting transaction IDs and opens up vulnerabilities like callback forgery and ID guessing.
**Learning:** In backend operations, `Date.now()` alone doesn't provide enough entropy for unique identifiers, especially those used in callbacks and sensitive operations.
**Prevention:** Always append a secure random string (e.g., `crypto.randomBytes(4).toString('hex')`) to timestamps when generating unique transaction or invoice IDs.
