## 2026-07-04 - SSRF via 0.0.0.0 Bypass
**Vulnerability:** The webhook URL validation allowed 0.0.0.0/8 IP addresses, which can bypass private network protections.
**Learning:** In Linux/Unix environments, 0.0.0.0 is often routed to the localhost, creating an SSRF vector if not explicitly blocked.
**Prevention:** Always block the 0.0.0.0/8 network alongside 127.0.0.0/8 and private ranges when preventing SSRF.
