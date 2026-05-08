# Database Migrations

These migrations reconcile the current application code with `setup_db.sql`.
They are intended for local sandbox use and are additive only.

## Files And Order

1. `001_add_missing_columns.sql`
   - Adds missing columns to `users`, `games`, `products`, and `transactions`.
   - Risk: Medium. Additive columns with safe defaults where needed.

2. `002_add_missing_tables.sql`
   - Creates missing tables: `password_resets`, `notifications`, `game_margins`, `game_servers`, `promo_codes`, `promo_usages`, and `flash_sales`.
   - Risk: Medium to High. Additive, but it enables runtime paths that were previously broken on a fresh schema.

3. `003_add_safe_indexes.sql`
   - Adds performance indexes for auth, H2H, deposits, transactions, products, notifications, password resets, promos, and flash sales.
   - Risk: Low to Medium. On a busy production database, convert these to `CREATE INDEX CONCURRENTLY` and run outside a transaction.

4. `004_add_low_risk_unique_constraints.sql`
   - Adds low-risk unique indexes for new support tables.
   - Risk: Low to Medium if the tables are empty. Run duplicate checks first if the tables already contain data.

5. `005_unique_phone_and_register_safety.sql`
   - **Phase 2B: Registration Safety.** Normalizes all existing `users.nomor_wa` values to E.164 format (`+6281234567890`), then enforces a partial unique index.
   - **5 steps (all atomic in one transaction):**
     1. Creates temporary PL/pgSQL helper `normalize_wa_to_e164()`
     2. `UPDATE users SET nomor_wa = ...` — normalizes formats: leading-`0`, `62xxx`, `60xxx`, `65xxx`, `63xxx` → E.164
     3. Safety check: if post-normalization duplicates exist → `RAISE EXCEPTION` → automatic `ROLLBACK`
     4. `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_nomor_wa` (partial: excludes NULL/empty)
     5. Drops helper function
   - **Risk:** Low if no post-normalization duplicates exist. Run pre-flight queries first.
   - **Pre-flight:** See commented queries inside the migration file (Step 0 and Step 1).

## Manual Apply Commands

Run these manually from the project root after connecting to your local PostgreSQL database. Replace the connection string with your local database.

```powershell
psql "postgresql://USER:PASSWORD@localhost:5432/DB_NAME" -f .\migrations\001_add_missing_columns.sql
psql "postgresql://USER:PASSWORD@localhost:5432/DB_NAME" -f .\migrations\002_add_missing_tables.sql
psql "postgresql://USER:PASSWORD@localhost:5432/DB_NAME" -f .\migrations\003_add_safe_indexes.sql
psql "postgresql://USER:PASSWORD@localhost:5432/DB_NAME" -f .\migrations\004_add_low_risk_unique_constraints.sql
psql "postgresql://USER:PASSWORD@localhost:5432/DB_NAME" -f .\migrations\005_unique_phone_and_register_safety.sql
```

If you prefer an interactive session:

```sql
\i migrations/001_add_missing_columns.sql
\i migrations/002_add_missing_tables.sql
\i migrations/003_add_safe_indexes.sql
\i migrations/004_add_low_risk_unique_constraints.sql
\i migrations/005_unique_phone_and_register_safety.sql
```

## Preflight Checks

### Before `004_add_low_risk_unique_constraints.sql`

Run these if your database already has data in the new tables:

```sql
SELECT token, COUNT(*)
FROM password_resets
GROUP BY token
HAVING COUNT(*) > 1;

SELECT game_id, COUNT(*)
FROM game_margins
GROUP BY game_id
HAVING COUNT(*) > 1;

SELECT code, COUNT(*)
FROM promo_codes
GROUP BY code
HAVING COUNT(*) > 1;

SELECT game_id, server_name, COUNT(*)
FROM game_servers
GROUP BY game_id, server_name
HAVING COUNT(*) > 1;
```

### Before `005_unique_phone_and_register_safety.sql`

**Step 0 — Inspect existing formats** (see what's in the DB before migration):

```sql
SELECT
    id,
    username,
    nomor_wa AS raw,
    CASE
        WHEN nomor_wa IS NULL OR nomor_wa = '' THEN NULL
        ELSE CASE
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
```

**Step 1 — Detect duplicates AFTER normalization** (must return 0 rows before applying):

```sql
WITH normalized AS (
    SELECT
        id, username, nomor_wa AS raw,
        CASE
            WHEN nomor_wa IS NULL OR nomor_wa = '' THEN NULL
            ELSE CASE
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
ORDER BY total DESC;
```

> If Step 1 returns any rows: do NOT apply migration 005. Resolve duplicates manually (contact users, merge accounts) and re-run Step 1 until it returns 0 rows.

## Verification SQL

Confirm missing tables now exist:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'password_resets',
    'notifications',
    'promo_codes',
    'promo_usages',
    'flash_sales',
    'game_margins',
    'game_servers'
  )
ORDER BY table_name;
```

Confirm missing columns now exist:

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'users' AND column_name IN ('whitelisted_ips', 'h2h_callback_url'))
    OR (table_name = 'games' AND column_name IN ('target_id_label'))
    OR (table_name = 'products' AND column_name IN ('validation_config', 'use_manual_prices', 'manual_prices'))
    OR (table_name = 'transactions' AND column_name IN ('provider_sn', 'check_attempts'))
  )
ORDER BY table_name, column_name;
```

Confirm indexes exist:

```sql
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;
```

Confirm low-risk unique indexes exist:

```sql
SELECT tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'uq_password_resets_token',
    'uq_game_margins_game_id',
    'uq_promo_codes_code',
    'uq_game_servers_game_server_name'
  )
ORDER BY tablename, indexname;
```

Check foreign keys:

```sql
SELECT conrelid::regclass AS table_name, conname, confrelid::regclass AS references_table
FROM pg_constraint
WHERE contype = 'f'
  AND connamespace = 'public'::regnamespace
ORDER BY table_name::text, conname;
```

## Rollback Notes

These migrations are additive, so the safest rollback is usually to leave the schema in place and revert application behavior if needed.

For a local sandbox only, rollback would mean manually dropping newly added indexes, tables, or columns in reverse order. That is destructive and intentionally not included in these migration files.

Do not run rollback SQL against any database with data you care about unless you have a verified backup.
