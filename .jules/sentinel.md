## 2026-07-01 - SSRF bypass using 0.0.0.0
**Vulnerability:** Found an SSRF risk where the 0.0.0.0/8 IPv4 range was not blocked in `isPrivateHostname`.
**Learning:** `0.0.0.0` resolves to the local machine (localhost) on Linux systems, bypassing standard private IP checks.
**Prevention:** Always explicitly block `0.0.0.0/8` in addition to `127.0.0.0/8` and standard private network ranges when validating URLs to prevent SSRF.
