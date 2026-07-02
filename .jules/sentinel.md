## 2026-07-02 - Prevent SSRF via 0.0.0.0 bypass
**Vulnerability:** The `isPrivateHostname` function failed to block the `0.0.0.0/8` network block.
**Learning:** On Linux, `0.0.0.0` can route to `127.0.0.1`, bypassing standard SSRF filters that only check for `127.0.0.0/8` or private IP ranges.
**Prevention:** Always include `parts[0] === 0` when validating IPv4 addresses to prevent SSRF bypasses.
