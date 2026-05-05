## 2025-05-05 - Insecure Predictable Transaction ID Generation
**Vulnerability:** The application was generating predictable transaction IDs (`trx_id_provider`) for both WEB and H2H orders using only `Date.now()`.
**Learning:** This approach lacked sufficient randomness, creating a severe vulnerability where an attacker could easily guess or forge callback requests from the provider.
**Prevention:** Always append a cryptographically secure random component (e.g., `crypto.randomBytes(8).toString('hex')`) to timestamps when generating unique identifiers used in security-sensitive contexts like callbacks.
