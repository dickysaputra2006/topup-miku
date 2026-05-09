## 2025-02-23 - Predictable Transaction IDs

**Vulnerability:** The application generated transaction IDs (`provider_trx_id` and `invoiceId`) using `Date.now()`. This is predictable and can be guessed.
**Learning:** This is a severe vulnerability as it could allow an attacker to spoof callbacks from the payment provider (Foxy) by guessing the `trx_id` generated during order placement and subsequently sending a forged callback to mark the transaction as "Success". Furthermore, the automated code review agent incorrectly flagged a missing `crypto` import, which requires careful manual verification.
**Prevention:** Always use cryptographically secure randomness, such as `crypto.randomBytes(8).toString('hex')`, when generating sensitive references that act as proof-of-transaction for callbacks.
