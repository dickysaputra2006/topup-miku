## 2024-05-29 - [Insecure Randomness in Deposit Codes]
**Vulnerability:** Deposit unique codes were generated using `Math.random()`, making them predictable.
**Learning:** In financial systems where unique deposit codes are used to identify and verify payments, predictable codes can lead to spoofing or claiming other users' deposits.
**Prevention:** Always use cryptographically secure random number generators (e.g., `crypto.randomInt(100, 1000)`) for generating financial transaction values or unique identifiers.
