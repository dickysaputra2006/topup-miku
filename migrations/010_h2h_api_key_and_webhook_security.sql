-- Migration 010: Hash API Key H2H & Secret Webhook per Reseller (SEC-004, SEC-007)
-- Aman dan idempoten untuk dijalankan pada database yang sudah memiliki data.
--
-- Catatan transisi SEC-004 (tanpa memutus reseller yang sudah terintegrasi):
--   1. Key baru (32 byte / 64 hex) hanya disimpan sebagai hash SHA-256 di users.api_key_hash
--      dan 8 karakter awal di users.api_key_prefix (kolom users.api_key dibiarkan NULL).
--   2. Key plaintext lama yang masih tersimpan di users.api_key tetap diterima sementara
--      pada endpoint /h2h/*. Saat request valid pertama memakai key lama, server menghitung
--      SHA-256 hash + prefix, menyimpannya ke api_key_hash/api_key_prefix, lalu mengosongkan
--      kolom users.api_key menjadi NULL (lazy migration).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(64);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(8);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS h2h_webhook_secret VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash
    ON users (api_key_hash)
    WHERE api_key_hash IS NOT NULL;
