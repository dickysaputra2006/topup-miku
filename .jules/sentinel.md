## 2024-05-18 - Fix Predictable Transaction IDs
**Vulnerability:** Insecure Direct Object Reference (IDOR) / Predictable Callback IDs. The backend generated transaction IDs (e.g., `TRX-${Date.now()}${userId}`) and provider IDs (e.g., `WEB-${Date.now()}`) using `Date.now()`.
**Learning:** This predictability allowed potential attackers to guess transaction identifiers, which could be exploited to forge webhooks or callbacks from payment/product providers.
**Prevention:** Use cryptographically secure random number generators like Node's built-in `crypto.randomBytes(N).toString('hex')` to generate opaque and unpredictable unique identifiers.
