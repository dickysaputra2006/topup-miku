-- ============================================================
-- 012_add_admin_audit_logs.sql
-- SEC-010 / SEC-016b: Tabel Audit Log Aksi Admin Sensitif
-- ============================================================
--
-- SAFETY:
--   - Menggunakan CREATE TABLE IF NOT EXISTS dan CREATE INDEX IF NOT EXISTS
--   - Additive & idempotent (aman dijalankan ulang tanpa mengubah data eksisting)
--   - Tabel bersifat append-only untuk jejak audit mutasi admin (saldo, deposit,
--     resolve transaksi, margin, game, metode pembayaran)
--
-- JALANKAN MIGRATION:
--   psql -U <user> -d <dbname> -f migrations/012_add_admin_audit_logs.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(60) NOT NULL,
    target_id VARCHAR(120),
    before_data JSONB,
    after_data JSONB,
    ip_address VARCHAR(64),
    user_agent VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_created
    ON admin_audit_logs (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target
    ON admin_audit_logs (target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_action_created
    ON admin_audit_logs (action, created_at DESC);

COMMIT;
