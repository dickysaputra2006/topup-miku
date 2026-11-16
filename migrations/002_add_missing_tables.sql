-- 002_add_missing_tables.sql
-- Purpose: Create tables referenced by server.js and cronUtils.js but absent
-- from setup_db.sql.
--
-- Order: Run after 001_add_missing_columns.sql and before index migrations.
-- Risk: Medium to High. Tables are additive, but they unlock code paths for
-- password reset, notifications, promos, flash sales, per-game margins, and
-- game server lists. Foreign keys are included where they are straightforward.

BEGIN;

CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_password_resets_email
        FOREIGN KEY (email)
        REFERENCES users(email)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    message TEXT NOT NULL,
    link TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_margins (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL,
    use_custom_margin BOOLEAN DEFAULT FALSE,
    bronze_margin DECIMAL(5, 2),
    silver_margin DECIMAL(5, 2),
    gold_margin DECIMAL(5, 2),
    partner_margin DECIMAL(5, 2),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_game_margins_game
        FOREIGN KEY (game_id)
        REFERENCES games(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_servers (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL,
    server_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_game_servers_game
        FOREIGN KEY (game_id)
        REFERENCES games(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(100) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL,
    value DECIMAL(15, 2) NOT NULL,
    expires_at TIMESTAMPTZ,
    rules JSONB DEFAULT '{}'::jsonb,
    max_uses INT,
    uses_count INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_usages (
    id SERIAL PRIMARY KEY,
    promo_code_id INT NOT NULL,
    user_id INT,
    product_id INT,
    transaction_id INT,
    customer_game_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_promo_usages_promo
        FOREIGN KEY (promo_code_id)
        REFERENCES promo_codes(id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_promo_usages_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_promo_usages_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE SET NULL,
    CONSTRAINT fk_promo_usages_transaction
        FOREIGN KEY (transaction_id)
        REFERENCES transactions(id)
        ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS flash_sales (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL,
    discount_price DECIMAL(15, 2) NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    max_uses INT,
    uses_count INT DEFAULT 0,
    rules JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_flash_sales_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE
);

COMMIT;
