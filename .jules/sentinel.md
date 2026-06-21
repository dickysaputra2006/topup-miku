## 2026-06-21 - Secure Randomness in Transaction IDs
**Vulnerability:** Transaction and invoice IDs used predictable timestamps (`Date.now()`), allowing potential callback forgery or enumeration.
**Learning:** Purely timestamp-based IDs are predictable.
**Prevention:** Always append secure random generation (`crypto.randomBytes(4).toString('hex')`) to timestamp-based IDs for security.
