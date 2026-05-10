-- ============================================================
-- 006_add_deposit_method_note.sql
-- Phase 4C: Deposit Method & Note
-- Tambah kolom method dan note pada tabel deposits
-- ============================================================
--
-- KONTEKS:
--   Phase 4B hanya menyimpan: id, user_id, amount, unique_code,
--   status, created_at, updated_at.
--   Phase 4C menambahkan:
--     - method VARCHAR(30): metode pembayaran (GoPay, DANA, dll.)
--     - note   VARCHAR(200): catatan opsional dari user
--
-- SAFETY:
--   - Menggunakan ADD COLUMN IF NOT EXISTS → idempotent (aman re-run)
--   - Kolom nullable → deposit lama (NULL method/note) tetap valid
--   - Tidak ada UPDATE pada data lama
--   - Tidak ada DROP COLUMN
--   - Tidak ada perubahan index/constraint yang breaking
--
-- VALIDASI SEBELUM MENJALANKAN:
--   SELECT column_name, data_type, character_maximum_length
--   FROM information_schema.columns
--   WHERE table_name = 'deposits'
--   ORDER BY ordinal_position;
--
-- JALANKAN MIGRATION:
--   psql -U <user> -d <dbname> -f migrations/006_add_deposit_method_note.sql
--
-- POST-MIGRATION VERIFICATION:
--   SELECT id, method, note FROM deposits LIMIT 5;
-- ============================================================

BEGIN;

-- Tambah kolom method (opsional untuk deposit lama)
ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS method VARCHAR(30),
    ADD COLUMN IF NOT EXISTS note VARCHAR(200);

-- Index ringan pada method untuk mempermudah filter admin di masa depan
-- Hanya buat jika belum ada (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename  = 'deposits'
          AND indexname  = 'idx_deposits_method'
    ) THEN
        CREATE INDEX idx_deposits_method ON deposits (method)
            WHERE method IS NOT NULL;
        RAISE NOTICE '[006] Index idx_deposits_method created.';
    ELSE
        RAISE NOTICE '[006] Index idx_deposits_method already exists, skipped.';
    END IF;
END $$;

DO $$
BEGIN
    RAISE NOTICE '[006] Migration 006_add_deposit_method_note completed successfully.';
    RAISE NOTICE '[006] Columns added: deposits.method VARCHAR(30), deposits.note VARCHAR(200)';
    RAISE NOTICE '[006] Existing deposits have method=NULL, note=NULL — this is expected.';
END $$;

COMMIT;

-- ============================================================
-- POST-MIGRATION VERIFICATION (jalankan setelah migration)
-- ============================================================
/*
-- Cek kolom baru:
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_name = 'deposits'
  AND column_name IN ('method', 'note')
ORDER BY ordinal_position;

-- Cek index:
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'deposits'
  AND indexname = 'idx_deposits_method';

-- Cek data deposit lama (method/note harus NULL):
SELECT id, status, method, note FROM deposits LIMIT 10;
*/
