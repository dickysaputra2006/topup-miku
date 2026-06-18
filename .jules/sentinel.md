## YYYY-MM-DD - Server-Side Request Forgery (SSRF) in Outbound Webhooks
**Vulnerability:** Found an SSRF vulnerability where user-provided URLs in `h2h_callback_url` are invoked without DNS validation against private IPs.
**Learning:** SSRF via DNS Rebinding must be protected by validating the IP *after* DNS resolution at the exact time of socket connection using a custom `http.Agent`.
**Prevention:** Implement an intercepting `http/https.Agent` that forces DNS lookups and checks for private networks (IPv4 and IPv6) before connecting.
