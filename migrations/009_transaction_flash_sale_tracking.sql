-- Migration 009: Lacak flash_sale_id dan status pemulihan kuota flash sale pada transactions (SEC-002)
-- Aman dan idempoten untuk dijalankan pada database yang sudah memiliki data.

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS flash_sale_id INT REFERENCES flash_sales(id) ON DELETE SET NULL;

ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS flash_sale_restored BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_transactions_flash_sale_id
    ON transactions (flash_sale_id)
    WHERE flash_sale_id IS NOT NULL;
