
## 2025-05-01 - Prevent Callback Forgery via Predictable Transaction IDs
**Vulnerability:** The system generated `provider_trx_id`s sequentially or predictably using `Date.now()`. The `/api/foxy/callback` endpoint only checks this ID along with a status string without other validations.
**Learning:** This exposes the system to transaction callback forgery. An attacker could potentially iterate or guess transaction IDs matching `Date.now()` and post a 'SUCCESS' status to the callback endpoint, thus artificially validating unpaid orders or crediting themselves.
**Prevention:** Always append a secure random component (e.g., `crypto.randomBytes(8).toString('hex')`) to transaction IDs used for third-party service callbacks to make them unguessable.
