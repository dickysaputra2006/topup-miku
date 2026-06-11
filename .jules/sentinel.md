## 2026-06-11 - Insecure Unique Code Generation
**Vulnerability:** The application uses `Math.random()` to generate the `uniqueCode` for deposits.
**Learning:** `Math.random()` is not cryptographically secure and its output can be predicted, potentially allowing malicious users to predict deposit amounts and game the deposit system.
**Prevention:** Use `crypto.randomInt()` or `crypto.randomBytes()` for generating random numbers for financial transactions or sensitive data.
