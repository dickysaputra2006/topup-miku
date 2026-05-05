-- 004_add_low_risk_unique_constraints.sql
-- Purpose: Add low-risk uniqueness needed by existing ON CONFLICT usage and
-- lookup semantics.
--
-- Order: Run after 001 and 002. It can be run before or after 003.
-- Risk: Low to Medium. These constraints are likely safe because the new tables
-- should normally be empty in a local sandbox. Still run the duplicate-check
-- queries from README.md before applying if you already have data.
--
-- Deliberately excluded high-risk constraints:
-- - balance_history(reference_id, type), because duplicate ledger rows may
--   already exist and a failed unique index would interrupt migration.
-- - transactions client idempotency keys, because the app does not yet have a
--   client_order_id/external_order_id column or logic.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_resets_token
    ON password_resets(token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_game_margins_game_id
    ON game_margins(game_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_codes_code
    ON promo_codes(code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_game_servers_game_server_name
    ON game_servers(game_id, server_name);

COMMIT;
