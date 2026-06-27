## 2026-06-27 - SSRF Vulnerability via 0.0.0.0/8
**Vulnerability:** The application's `isPrivateHostname` function failed to explicitly block the `0.0.0.0/8` network range, potentially allowing SSRF attacks on Linux environments where `0.0.0.0` can route to the local loopback interface.
**Learning:** Standard private network lists (e.g., 10.0.0.0/8, 127.0.0.0/8, 192.168.0.0/16) are insufficient for preventing SSRF; meta-addresses like `0.0.0.0` must also be explicitly blocked.
**Prevention:** Always include `0.0.0.0/8` in explicit denylists when validating IP addresses for outbound requests.
