-- ============================================================
-- 007_concurrency_and_balance_guards.sql
-- Keamanan Saldo & Konkurensi (Anti Saldo Negatif, Anti Double-Refund, Anti Double-Credit Deposit)
-- ============================================================
--
-- JALANKAN MIGRATION:
--   psql -U <user> -d <dbname> -f migrations/007_concurrency_and_balance_guards.sql
-- ============================================================

BEGIN;

-- 1. Cegah saldo user menjadi negatif di level database
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_balance_non_negative'
    ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);
        RAISE NOTICE '[007] Constraint users_balance_non_negative created.';
    ELSE
        RAISE NOTICE '[007] Constraint users_balance_non_negative already exists, skipped.';
    END IF;
END $$;

-- 2. Partial unique index: Cegah double-refund untuk invoice yang sama
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_refund_per_invoice
    ON balance_history (reference_id)
    WHERE type = 'Refund' AND reference_id IS NOT NULL;

-- 3. Partial unique index: Cegah double-credit deposit untuk ID deposit yang sama
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_deposit_credit
    ON balance_history (reference_id)
    WHERE type = 'Deposit' AND reference_id IS NOT NULL;

COMMIT;
