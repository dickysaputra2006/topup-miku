## 2026-06-22 - SSRF Bypass via 0.0.0.0/8 Network
**Vulnerability:** The application's SSRF protection in `isPrivateHostname` failed to block the `0.0.0.0/8` IP range.
**Learning:** SSRF defenses that block private IP ranges (RFC 1918) and loopback (127.0.0.0/8) often miss the "this host on this network" range (0.0.0.0/8). In many environments (like Linux), 0.0.0.0 routes to localhost, allowing an attacker to bypass loopback restrictions.
**Prevention:** Explicitly block `0.0.0.0/8` (`parts[0] === 0`) when validating IPv4 addresses for SSRF protection, in addition to standard private and loopback ranges.
