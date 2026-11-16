-- 003_add_safe_indexes.sql
-- Purpose: Add indexes for routes and jobs used by the application.
--
-- Order: Run after 001 and 002.
-- Risk: Low to Medium. Index creation is additive. For a busy production
-- database, use CREATE INDEX CONCURRENTLY outside a transaction instead.
-- This local sandbox migration keeps regular CREATE INDEX IF NOT EXISTS.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_users_role_id
    ON users(role_id);

CREATE INDEX IF NOT EXISTS idx_users_api_key_not_null
    ON users(api_key)
    WHERE api_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deposits_status_created_at
    ON deposits(status, created_at);

CREATE INDEX IF NOT EXISTS idx_deposits_user_id_created_at
    ON deposits(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_balance_history_user_created_at
    ON balance_history(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_balance_history_reference_id
    ON balance_history(reference_id);

CREATE INDEX IF NOT EXISTS idx_games_status_category_name
    ON games(status, category, name);

CREATE INDEX IF NOT EXISTS idx_products_game_status_price
    ON products(game_id, status, price);

CREATE INDEX IF NOT EXISTS idx_products_category_id
    ON products(category_id);

CREATE INDEX IF NOT EXISTS idx_transactions_user_created_at
    ON transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_status_updated_at
    ON transactions(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_transactions_product_id
    ON transactions(product_id);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at
    ON notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, is_read)
    WHERE is_read = false;

CREATE INDEX IF NOT EXISTS idx_password_resets_email
    ON password_resets(email);

CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at
    ON password_resets(expires_at);

CREATE INDEX IF NOT EXISTS idx_flash_sales_active_window
    ON flash_sales(is_active, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_flash_sales_product_id
    ON flash_sales(product_id);

CREATE INDEX IF NOT EXISTS idx_promo_usages_customer_game_id
    ON promo_usages(customer_game_id);

CREATE INDEX IF NOT EXISTS idx_promo_usages_promo_code_id
    ON promo_usages(promo_code_id);

CREATE INDEX IF NOT EXISTS idx_game_servers_game_id
    ON game_servers(game_id);

COMMIT;
