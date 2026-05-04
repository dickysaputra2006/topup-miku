## 2025-05-04 - Predictable Transaction IDs

**Vulnerability:** Transaction IDs (`provider_trx_id` and `invoice_id`) were generated predictably using `Date.now()`.
**Learning:** This approach enables predictable references which could allow callback forgery, leading to unauthorized state modifications or bypassing verification checks.
**Prevention:** Use a secure source of randomness, such as `crypto.randomBytes(8).toString('hex')`, appended to the ID string instead of relying solely on time-based predictable values.
