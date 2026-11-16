-- 001_add_missing_columns.sql
-- Purpose: Add columns referenced by the current application code but missing
-- from setup_db.sql.
--
-- Order: Run this before table/index migrations.
-- Risk: Medium. These are additive changes with defaults where the code expects
-- non-null-ish behavior. No existing data is deleted or rewritten beyond safe
-- default values for new columns.

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS whitelisted_ips TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS h2h_callback_url TEXT;

ALTER TABLE games
    ADD COLUMN IF NOT EXISTS target_id_label VARCHAR(255);

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS validation_config JSONB,
    ADD COLUMN IF NOT EXISTS use_manual_prices BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS manual_prices JSONB DEFAULT '{}'::jsonb;

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS provider_sn TEXT,
    ADD COLUMN IF NOT EXISTS check_attempts INT DEFAULT 0;

COMMIT;
