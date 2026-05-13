## 2024-05-18 - Insecure Randomness in Deposit Codes
**Vulnerability:** The deposit system used `Math.random()` to generate unique transaction codes. This is cryptographically insecure and could allow attackers to predict codes and forge deposit callbacks or identifiers.
**Learning:** `Math.random()` is not suitable for generating security-sensitive values like transaction codes. The code previously used `Math.floor(Math.random() * 900) + 100` to get a 3-digit number.
**Prevention:** Always use `crypto.randomInt(min, max)` from the built-in Node.js `crypto` module to generate random integers for sensitive operations. Ensure the `crypto` module is imported at the top of the file.
