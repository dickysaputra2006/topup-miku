-- 013_auth_revocation_and_email_cascade.sql
-- Purpose:
--   1. BUG-008: Tambahkan ON UPDATE CASCADE pada FK fk_password_resets_email agar
--      perubahan email profil user tidak gagal dengan error foreign key (23503).
--   2. BUG-011: Tambahkan kolom users.token_version INTEGER NOT NULL DEFAULT 1
--      untuk revokasi JWT lama saat user mengganti atau mereset password.
--
-- Safe & Idempotent: aman dijalankan berulang di lokal maupun production.

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'password_resets'
    ) THEN
        ALTER TABLE password_resets
            DROP CONSTRAINT IF EXISTS fk_password_resets_email;

        ALTER TABLE password_resets
            ADD CONSTRAINT fk_password_resets_email
            FOREIGN KEY (email)
            REFERENCES users(email)
            ON DELETE CASCADE
            ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;
