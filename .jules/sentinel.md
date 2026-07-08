## 2026-07-08 - SSRF Evasion via 0.0.0.0/8
**Vulnerability:** The application's webhook URL validation (`isPrivateHostname`) failed to block the `0.0.0.0/8` network range, creating an SSRF vulnerability where attackers could target internal services bound to all interfaces.
**Learning:** Standard private IPs (`10.x.x.x`, `192.168.x.x`, `127.0.0.1`) are often blocked, but developers frequently forget that `0.0.0.0` is treated as localhost/loopback by many operating systems and networking libraries.
**Prevention:** Always explicitly block the `0.0.0.0/8` network (`parts[0] === 0`) in addition to standard RFC 1918 private and loopback ranges when validating IPv4 addresses to prevent SSRF.
