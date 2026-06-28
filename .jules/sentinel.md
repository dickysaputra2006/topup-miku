## 2026-06-28 - Prevent SSRF via 0.0.0.0/8
**Vulnerability:** The `isPrivateHostname` function failed to block the `0.0.0.0/8` IPv4 network.
**Learning:** In many environments, `0.0.0.0` resolves to localhost, allowing attackers to bypass SSRF protections that only block `127.0.0.1` or standard private networks, potentially accessing internal services.
**Prevention:** Explicitly block the `0.0.0.0/8` network (e.g., checking `parts[0] === 0`) when validating IPv4 addresses for SSRF protection alongside standard private and loopback ranges.
