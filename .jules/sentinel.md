## 2024-06-08 - Insecure Random Number Generation for Financial Transactions
**Vulnerability:** The application uses `Math.random()` to generate the `uniqueCode` for deposit requests.
**Learning:** `Math.random()` is not cryptographically secure and should not be used for anything security-related, including unique codes for financial deposits, as it can lead to predictable values.
**Prevention:** Always use `crypto.randomInt()` from the built-in `crypto` module when generating random numbers for sensitive operations. Ensure the `crypto` module is properly imported using `const crypto = require('crypto');` before use.
