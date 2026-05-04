# Project Rules for Codex

This is a reseller topup web application with payment, balance, transactions, reseller API, and provider integration.

## Safety rules
- Do not modify production secrets.
- Do not expose Midtrans server key, provider API key, database password, or reseller API keys.
- Do not remove existing authentication.
- Do not change payment or transaction logic without explaining the risk.
- Prefer small, reviewable changes.
- Do not break existing routes or API response format.
- Always mention database migrations clearly.
- Always provide manual test steps.
- Never expose or commit secrets.
- Never modify .env directly unless I explicitly ask.
- Prefer small, reviewable changes.
- Do not break existing routes or API response formats.
- For payment, balance, transaction, and provider logic, explain risks before changing.
- Always provide manual test steps.
- Always mention database migrations clearly.
- Use sandbox/local data only.
- Do not run destructive database commands.
- Keep changes focused on one task at a time.

## Priorities
1. Security
2. Transaction reliability
3. Payment webhook safety
4. API reseller authentication and rate limiting
5. Database indexing
6. UI/UX improvements
7. Admin and reseller dashboard improvements

## Testing
If the project has tests, run them.
If there are no tests, provide manual test steps.