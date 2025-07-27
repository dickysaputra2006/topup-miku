-- Pastikan Anda terhubung ke database PostgreSQL yang benar di Render sebelum menjalankan skrip ini.

-- Buat tabel roles
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    margin_percent DECIMAL(5, 2) DEFAULT 0.00
);

-- Masukkan data role awal (Jika belum ada, atau ingin reset)
INSERT INTO roles (name, margin_percent) VALUES
('User', 10.00),
('Admin', 0.00),
('GOLD', 5.00),
('SILVER', 7.50),
('BRONZE', 12.00),
('OWNER', 0.00),
('PARTNER', 8.00)
ON CONFLICT (name) DO NOTHING; -- Hindari duplikasi jika sudah ada

-- Buat tabel users
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    nomor_wa VARCHAR(255),
    password VARCHAR(255) NOT NULL,
    balance DECIMAL(15, 2) DEFAULT 0.00,
    role_id INT DEFAULT 1, -- Default role 'User'
    api_key VARCHAR(255) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- Akan diperbarui secara manual di aplikasi atau trigger
    CONSTRAINT fk_role
        FOREIGN KEY(role_id)
        REFERENCES roles(id)
        ON DELETE SET DEFAULT
);

-- Buat tabel deposits
CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    unique_code INT NOT NULL,
    status VARCHAR(50) DEFAULT 'Pending',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- Akan diperbarui secara manual di aplikasi atau trigger
    CONSTRAINT fk_user_deposit
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

-- Buat tabel balance_history
CREATE TABLE IF NOT EXISTS balance_history (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    type VARCHAR(50) NOT NULL, -- e.g., 'Deposit', 'Purchase', 'Refund', 'Admin Add', 'Admin Reduce'
    description TEXT,
    reference_id VARCHAR(255), -- Invoice ID, Deposit ID, etc.
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_balance_history
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

-- Buat tabel games
CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(255),
    image_url TEXT,
    needs_server_id BOOLEAN DEFAULT FALSE,
    status VARCHAR(50) DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP -- Akan diperbarui secara manual di aplikasi atau trigger
);

-- Buat tabel product_categories (kategori seperti 'Diamonds', 'UC', dll. per game)
CREATE TABLE IF NOT EXISTS product_categories (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    UNIQUE(game_id, name), -- Kategori unik per game
    CONSTRAINT fk_game_category
        FOREIGN KEY(game_id)
        REFERENCES games(id)
        ON DELETE CASCADE
);

-- Buat tabel products
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    game_id INT NOT NULL,
    category_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    provider_sku VARCHAR(255) UNIQUE NOT NULL, -- SKU dari provider (misal Foxy) harus unik
    price DECIMAL(15, 2) NOT NULL, -- Harga pokok dari provider
    status VARCHAR(50) DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- Akan diperbarui secara manual di aplikasi atau trigger
    CONSTRAINT fk_game_product
        FOREIGN KEY(game_id)
        REFERENCES games(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_category_product
        FOREIGN KEY(category_id)
        REFERENCES product_categories(id)
        ON DELETE CASCADE
);

-- Buat tabel transactions
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    invoice_id VARCHAR(255) UNIQUE NOT NULL,
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    target_game_id VARCHAR(255) NOT NULL, -- Bisa UserID saja atau UserID|ServerID
    price DECIMAL(15, 2) NOT NULL,
    status VARCHAR(50) DEFAULT 'Pending', -- Pending, Success, Failed, Refunded
    provider_trx_id VARCHAR(255) UNIQUE, -- ID transaksi dari provider Foxy
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- Akan diperbarui secara manual di aplikasi atau trigger
    CONSTRAINT fk_user_transaction
        FOREIGN KEY(user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_product_transaction
        FOREIGN KEY(product_id)
        REFERENCES products(id)
        ON DELETE CASCADE
);