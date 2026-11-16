-- Migration 011: Idempotency keys untuk transactions (ref_id) & deposits (idempotency_key) (SEC-009)
-- Aman dan idempoten untuk dijalankan pada database yang sudah memiliki data.

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS ref_id VARCHAR(100) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_user_ref_id
    ON transactions (user_id, ref_id)
    WHERE ref_id IS NOT NULL;

ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(100) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_user_idempotency_key
    ON deposits (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
