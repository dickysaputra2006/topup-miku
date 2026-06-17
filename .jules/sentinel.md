## 2024-05-24 - SSRF Bypass via 0.0.0.0
**Vulnerability:** Attackers could bypass loopback checks by using 0.0.0.0, which routes to localhost on Linux/macOS.
**Learning:** `net.isIP()` returns 4 for 0.0.0.0, and `split('.')[0]` maps to 0. Prior `isPrivateHostname` only checked 127, 10, 172, 192, and 169.
**Prevention:** Always explicitly check and block `0.0.0.0/8` (i.e. `parts[0] === 0`) in SSRF protection alongside standard loopback addresses.
