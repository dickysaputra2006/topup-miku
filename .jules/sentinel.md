## 2024-10-27 - Predictable Transaction IDs

**Vulnerability:** Transaction IDs were generated using predictable timestamps (`Date.now()`).
**Learning:** This predictability can allow attackers to forge callbacks or exploit race conditions. Non-secret user-facing IDs (like deposit unique codes which are just amounts) do not need cryptographic security, but database keys used for webhooks/callbacks do.
**Prevention:** Always append cryptographically secure randomness (`crypto.randomBytes()`) when generating transaction IDs, tokens, or any value used for validation.
