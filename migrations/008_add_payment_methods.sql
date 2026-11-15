-- ============================================================
-- 008_add_payment_methods.sql
-- Paket 2: Sistem Metode Pembayaran Dinamis untuk Deposit
-- ============================================================
--
-- SAFETY:
--   - Menggunakan CREATE TABLE IF NOT EXISTS, ALTER CONDITIONAL, dan ON CONFLICT DO NOTHING
--   - Idempotent (aman dijalankan ulang tanpa merusak data yang ada)
--   - Memperlebar deposits.method dari VARCHAR(30) menjadi VARCHAR(100)
--     agar selaras dengan payment_methods.name VARCHAR(100)
--
-- JALANKAN MIGRATION:
--   psql -U <user> -d <dbname> -f migrations/008_add_payment_methods.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payment_methods (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(30) NOT NULL DEFAULT 'ewallet',
    account_number VARCHAR(100),
    account_name VARCHAR(150),
    qris_image_url TEXT,
    instructions TEXT,
    is_qris BOOLEAN NOT NULL DEFAULT false,
    min_amount DECIMAL(15, 2) NOT NULL DEFAULT 10000,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_payment_methods_type CHECK (type IN ('ewallet', 'bank', 'qris')),
    CONSTRAINT chk_payment_methods_min_amount CHECK (min_amount >= 1000)
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_active_sort
    ON payment_methods (is_active, sort_order, id);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'deposits'
          AND column_name = 'method'
          AND character_maximum_length < 100
    ) THEN
        ALTER TABLE deposits ALTER COLUMN method TYPE VARCHAR(100);
        RAISE NOTICE '[008] Column deposits.method widened to VARCHAR(100).';
    END IF;
END $$;

INSERT INTO payment_methods (
    code,
    name,
    type,
    account_number,
    account_name,
    qris_image_url,
    instructions,
    is_qris,
    min_amount,
    is_active,
    sort_order
) VALUES
(
    'GOPAY',
    'GoPay',
    'ewallet',
    '081200000001',
    'Admin MIKU Store (Placeholder)',
    NULL,
    'Buka aplikasi Gojek/GoPay, transfer tepat sesuai total nominal termasuk kode unik 3 digit, lalu ajukan request deposit.',
    false,
    10000,
    true,
    1
),
(
    'DANA',
    'DANA',
    'ewallet',
    '081200000002',
    'Admin MIKU Store (Placeholder)',
    NULL,
    'Buka aplikasi DANA, kirim tepat sesuai total nominal termasuk kode unik 3 digit, lalu cantumkan ID deposit bila diminta.',
    false,
    10000,
    true,
    2
),
(
    'SHOPEEPAY',
    'ShopeePay',
    'ewallet',
    '081200000003',
    'Admin MIKU Store (Placeholder)',
    NULL,
    'Transfer melalui menu Kirim ke Nomor ShopeePay tepat sesuai total nominal beserta kode unik 3 digit.',
    false,
    10000,
    true,
    3
),
(
    'SEABANK',
    'SeaBank',
    'bank',
    '901000000004',
    'Admin MIKU Store (Placeholder)',
    NULL,
    'Transfer ke rekening SeaBank di atas (bebas biaya admin dari sesama SeaBank/BI-FAST) sesuai total nominal + kode unik.',
    false,
    10000,
    true,
    4
)
ON CONFLICT (code) DO NOTHING;

COMMIT;
