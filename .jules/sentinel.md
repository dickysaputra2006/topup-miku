## 2026-06-30 - SSRF Vulnerability via 0.0.0.0/8
**Vulnerability:** The `isPrivateHostname` function failed to block the `0.0.0.0/8` IPv4 network block.
**Learning:** Standard private network checks (10.x, 192.x, 172.x) and loopback (127.x) are insufficient because `0.0.0.0` can also be routed to localhost on many systems, leading to SSRF.
**Prevention:** Always explicitly block `0.0.0.0/8` when validating user-provided IP addresses/hostnames to prevent SSRF.
