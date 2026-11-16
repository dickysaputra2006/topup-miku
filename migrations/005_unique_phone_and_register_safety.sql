-- ============================================================
-- 005_unique_phone_and_register_safety.sql
-- Phase 2B: Registration Safety
-- Normalize existing nomor_wa data THEN enforce uniqueness
-- ============================================================
--
-- CRITICAL CONTEXT:
--   Before Phase 2B, users could register with various formats:
--     - '081234567890'   (local Indonesian format, leading 0)
--     - '6281234567890'  (country code without +)
--     - '+6281234567890' (E.164, correct)
--     - '628 1234 5678'  (with spaces)
--   Phase 2B backend now stores E.164 (+6281234567890) for new users.
--   This migration normalizes ALL existing rows to E.164 before
--   creating the unique index — preventing false "not duplicate"
--   situations where '6281234...' and '+6281234...' refer to the
--   same real phone number but differ at the string level.
--
-- NORMALIZATION RULES APPLIED (Indonesia-centric, extendable):
--   1. Strip spaces, dashes, parentheses from nomor_wa
--   2. If result starts with '+': already E.164, keep as-is
--   3. If result starts with '62': assume Indonesia, prepend '+'
--   4. If result starts with '60': assume Malaysia, prepend '+'
--   5. If result starts with '65': assume Singapore, prepend '+'
--   6. If result starts with '63': assume Philippines, prepend '+'
--   7. If result starts with '0': assume Indonesian local,
--      strip leading '0', prepend '+62'
--   8. NULL / empty string: skip (partial index ignores these)
--
-- SAFETY GUARANTEES:
--   - Entire migration runs inside BEGIN/COMMIT (atomic)
--   - If normalized duplicates are detected AFTER normalization
--     (Step 2), the migration raises an exception and ROLLS BACK
--     automatically — no data is corrupted
--   - IF NOT EXISTS on the index makes re-runs idempotent
--   - No rows are deleted; only nomor_wa column values are updated
--
-- PRE-FLIGHT: Run the queries below BEFORE applying this migration
-- ============================================================

-- ============================================================
-- PRE-FLIGHT STEP 0: Inspect raw nomor_wa values (informational)
-- Run this first to understand what formats exist in your DB.
-- ============================================================
/*
SELECT
    id,
    username,
    nomor_wa AS raw,
    CASE
        WHEN nomor_wa IS NULL OR nomor_wa = '' THEN NULL
        ELSE
            CASE
                WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '+%'
                    THEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '62%'
                    THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '60%'
                    THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '65%'
                    THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '63%'
                    THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '0%'
                    THEN '+62' || substring(regexp_replace(nomor_wa, '[\s\-().]', '', 'g') FROM 2)
                ELSE regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
            END
    END AS normalized_nomor_wa
FROM users
WHERE nomor_wa IS NOT NULL AND nomor_wa <> ''
ORDER BY id;
*/

-- ============================================================
-- PRE-FLIGHT STEP 1: Detect duplicates AFTER normalization
-- If this query returns ANY rows, resolve them manually first.
-- ============================================================
/*
WITH normalized AS (
    SELECT
        id,
        username,
        nomor_wa AS raw,
        CASE
            WHEN nomor_wa IS NULL OR nomor_wa = '' THEN NULL
            ELSE
                CASE
                    WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '+%'
                        THEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                    WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '62%'
                        THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                    WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '60%'
                        THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                    WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '65%'
                        THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                    WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '63%'
                        THEN '+' || regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                    WHEN regexp_replace(nomor_wa, '[\s\-().]', '', 'g') LIKE '0%'
                        THEN '+62' || substring(regexp_replace(nomor_wa, '[\s\-().]', '', 'g') FROM 2)
                    ELSE regexp_replace(nomor_wa, '[\s\-().]', '', 'g')
                END
        END AS normalized_wa
    FROM users
    WHERE nomor_wa IS NOT NULL AND nomor_wa <> ''
)
SELECT
    normalized_wa,
    COUNT(*) AS total,
    array_agg(id ORDER BY id) AS user_ids,
    array_agg(username ORDER BY id) AS usernames,
    array_agg(raw ORDER BY id) AS raw_values
FROM normalized
WHERE normalized_wa IS NOT NULL
GROUP BY normalized_wa
HAVING COUNT(*) > 1
ORDER BY total DESC, normalized_wa;
*/

-- ============================================================
-- PRE-FLIGHT STEP 2: Check if unique index already exists
-- (Migration is idempotent, but good to know before running)
-- ============================================================
/*
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'uq_users_nomor_wa';
*/

-- ============================================================
-- MIGRATION START
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 1: Create a helper function for E.164 normalization
-- This avoids repeating the CASE expression multiple times.
-- The function is created temporarily within the transaction.
-- ============================================================
CREATE OR REPLACE FUNCTION normalize_wa_to_e164(raw_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    stripped TEXT;
BEGIN
    -- Return NULL for null/empty inputs (partial index will skip these)
    IF raw_phone IS NULL OR trim(raw_phone) = '' THEN
        RETURN NULL;
    END IF;

    -- Strip spaces, dashes, dots, parentheses
    stripped := regexp_replace(trim(raw_phone), '[\s\-().]', '', 'g');

    -- Already E.164: starts with '+'
    IF stripped LIKE '+%' THEN
        RETURN stripped;
    END IF;

    -- Country codes: starts with known country code digits, prepend '+'
    IF stripped LIKE '62%' THEN RETURN '+' || stripped; END IF;  -- Indonesia
    IF stripped LIKE '60%' THEN RETURN '+' || stripped; END IF;  -- Malaysia
    IF stripped LIKE '65%' THEN RETURN '+' || stripped; END IF;  -- Singapore
    IF stripped LIKE '63%' THEN RETURN '+' || stripped; END IF;  -- Philippines
    IF stripped LIKE '66%' THEN RETURN '+' || stripped; END IF;  -- Thailand
    IF stripped LIKE '84%' THEN RETURN '+' || stripped; END IF;  -- Vietnam
    IF stripped LIKE '1%'  THEN RETURN '+' || stripped; END IF;  -- US/Canada

    -- Indonesian local format: starts with '0', strip '0', prepend '+62'
    IF stripped LIKE '0%' THEN
        RETURN '+62' || substring(stripped FROM 2);
    END IF;

    -- Unrecognized format: return as-is (won't be touched)
    RETURN stripped;
END;
$$;

-- ============================================================
-- STEP 2: Normalize all existing nomor_wa values to E.164
-- Only updates rows where normalization actually changes the value.
-- NULL and empty strings are untouched.
-- ============================================================
UPDATE users
SET nomor_wa = normalize_wa_to_e164(nomor_wa)
WHERE nomor_wa IS NOT NULL
  AND nomor_wa <> ''
  AND normalize_wa_to_e164(nomor_wa) IS DISTINCT FROM nomor_wa;

-- Log how many rows were updated (visible in psql output)
DO $$
DECLARE updated_count INT;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE '[005] Step 2 complete: % nomor_wa rows normalized to E.164.', updated_count;
END $$;

-- ============================================================
-- STEP 3: Safety check — detect duplicates AFTER normalization
-- If any duplicates exist, RAISE EXCEPTION to trigger ROLLBACK.
-- This protects against creating an invalid unique index AND
-- prevents silent data corruption.
-- ============================================================
DO $$
DECLARE
    dup_count INT;
    dup_detail TEXT;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT nomor_wa
        FROM users
        WHERE nomor_wa IS NOT NULL AND nomor_wa <> ''
        GROUP BY nomor_wa
        HAVING COUNT(*) > 1
    ) AS dups;

    IF dup_count > 0 THEN
        -- Gather detail for the error message
        SELECT string_agg(nomor_wa || ' (' || cnt::text || ' rows)', ', ')
        INTO dup_detail
        FROM (
            SELECT nomor_wa, COUNT(*) AS cnt
            FROM users
            WHERE nomor_wa IS NOT NULL AND nomor_wa <> ''
            GROUP BY nomor_wa
            HAVING COUNT(*) > 1
            ORDER BY cnt DESC
            LIMIT 10
        ) AS top_dups;

        RAISE EXCEPTION
            E'[005] MIGRATION ABORTED: % duplicate nomor_wa group(s) found after normalization.\n'
            'Duplicates (showing up to 10): %\n'
            'Resolve these manually before re-running this migration.\n'
            'Use the PRE-FLIGHT STEP 1 query (commented out above) to identify affected users.',
            dup_count, dup_detail;
    ELSE
        RAISE NOTICE '[005] Step 3 complete: No duplicates found after normalization. Safe to proceed.';
    END IF;
END $$;

-- ============================================================
-- STEP 4: Create partial unique index
-- Partial: NULL and empty-string values are excluded, allowing
-- legacy accounts with no phone to coexist safely.
-- IF NOT EXISTS makes this idempotent on re-run.
-- Wrapped in DO block so RAISE NOTICE is valid PL/pgSQL.
-- ============================================================
DO $$
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_nomor_wa
        ON users (nomor_wa)
        WHERE nomor_wa IS NOT NULL AND nomor_wa <> '';
    RAISE NOTICE '[005] Step 4 complete: Unique index uq_users_nomor_wa created (or already exists).';
END $$;

-- ============================================================
-- STEP 5: Clean up helper function (not needed after migration)
-- ============================================================
DO $$
BEGIN
    DROP FUNCTION IF EXISTS normalize_wa_to_e164(TEXT);
    RAISE NOTICE '[005] Step 5 complete: Helper function dropped.';
    RAISE NOTICE '[005] Migration 005 completed successfully.';
END $$;

COMMIT;

-- ============================================================
-- POST-MIGRATION VERIFICATION
-- Run after migration to confirm all steps applied correctly.
-- ============================================================
/*
-- Confirm index exists:
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'uq_users_nomor_wa';

-- Confirm all nomor_wa values are now E.164 (start with '+'):
SELECT COUNT(*) AS non_e164_count
FROM users
WHERE nomor_wa IS NOT NULL
  AND nomor_wa <> ''
  AND nomor_wa NOT LIKE '+%';

-- Should return 0. If > 0, some edge-case values were not recognized.
-- Review them:
SELECT id, username, nomor_wa
FROM users
WHERE nomor_wa IS NOT NULL
  AND nomor_wa <> ''
  AND nomor_wa NOT LIKE '+%';
*/
