require('dotenv').config();
const { Pool } = require('pg');

const dbSslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';

/**
 * Bangun konfigurasi koneksi PostgreSQL beserta opsi SSL bila diaktifkan.
 */
function getDbConfig() {
    const sslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';
    const config = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT || 5432),
    };

    if (sslEnabled) {
        config.ssl = { rejectUnauthorized: false };
    }

    return config;
}

const dbConfig = getDbConfig();

/**
 * Buat instance pg.Pool terpisah memakai konfigurasi database bersama.
 */
function createPool(overrides = {}) {
    return new Pool({
        ...getDbConfig(),
        ...overrides,
    });
}

// Instance pool tunggal aplikasi HTTP/Web/H2H (cron memakai createPool() terpisah agar mock tes terisolasi)
const pool = createPool();

pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'Asia/Jakarta'");
});

module.exports = {
    dbSslEnabled,
    dbConfig,
    getDbConfig,
    createPool,
    pool,
};
