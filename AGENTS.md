

This is a local-only sandbox project. It is not connected to GitHub.

Important project context:
- Stack: Express 4 + PostgreSQL + static HTML/CSS/JS frontend.
- This is a reseller topup web app with balance, deposits, orders, H2H API, and Foxy provider integration.
- Midtrans is expected but not implemented yet.
- Current highest risks are schema drift, insecure provider callback, order/provider reliability, balance safety, and payment flow.

Rules:
- Never use GitHub, pull requests, or push commands.
- Never expose or commit secrets.
- Never modify .env unless I explicitly ask.
- Never run destructive database commands.
- Do not change production URLs/secrets without asking.
- Prefer small, reviewable changes.
- Do not break existing routes or API response formats.
- For payment, balance, transaction, provider, and callback logic, explain risks before changing.
- Always provide manual test steps.
- Always mention database migrations clearly.
- Use local/sandbox data only.
- Keep changes focused on one task at a time.

