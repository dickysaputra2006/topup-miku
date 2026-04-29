## 2024-04-29 - Predictable Transaction IDs / Callback Forgery

**Vulnerability:** The application used predictable transaction IDs (`Date.now()` combined with user ID) for both internal invoice tracking (`invoiceId`) and provider callback references (`provider_trx_id`).

**Learning:** When callback endpoints accept transaction IDs generated with predictable patterns (like timestamps), attackers can potentially guess these IDs and forge "Success" callback requests to complete fake or unpurchased orders, bypassing payment checks.

**Prevention:** Always append cryptographically secure random bytes (e.g., `crypto.randomBytes(8).toString('hex')`) to transaction IDs or use UUIDs to ensure unpredictability and mitigate callback forgery risks.
