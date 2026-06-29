## 2026-06-29 - Prevent SSRF via 0.0.0.0/8 bypass
**Vulnerability:** The `isPrivateHostname` function did not block the `0.0.0.0/8` IP range.
**Learning:** Attackers can bypass SSRF filters by using `0.0.0.0` to access local services on Linux systems.
**Prevention:** Always block the `0.0.0.0/8` network when implementing custom private IP validation.
