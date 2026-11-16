const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { Pool } = require('pg');

// Pengaman agar seeder data dummy tidak pernah dijalankan di environment production
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error('[seed] DIBATALKAN: Seeder dummy tidak boleh dijalankan saat NODE_ENV=production.');
    process.exit(1);
}

const dbSslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT || 5432)
};
if (dbSslEnabled) {
    dbConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(dbConfig);

/**
 * Buat SVG data URI lokal sebagai gambar game agar tampil cepat dan tidak bergantung CDN eksternal.
 * @param {string} label - Nama singkat / judul game
 * @param {string} bgStart - Warna gradien awal (hex)
 * @param {string} bgEnd - Warna gradien akhir (hex)
 * @returns {string} Data URI SVG
 */
function makeGameBadgeDataUri(label, bgStart, bgEnd) {
    const safeLabel = String(label).replace(/[<>&"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bgStart}"/><stop offset="100%" stop-color="${bgEnd}"/></linearGradient></defs><rect width="320" height="320" rx="28" fill="url(#g)"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-weight="700" font-size="28">${safeLabel}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DEFAULT_ROLES = [
    { name: 'User', margin: 10.00 },
    { name: 'Admin', margin: 0.00 },
    { name: 'GOLD', margin: 5.00 },
    { name: 'SILVER', margin: 7.50 },
    { name: 'BRONZE', margin: 12.00 },
    { name: 'OWNER', margin: 0.00 },
    { name: 'PARTNER', margin: 8.00 }
];

const DUMMY_GAMES = [
    {
        name: 'Mobile Legends',
        category: 'Mobile Game',
        image_url: makeGameBadgeDataUri('MOBILE LEGENDS', '#1d4ed8', '#0f172a'),
        needs_server_id: true,
        target_id_label: 'Masukkan User ID (tanpa Server ID)',
        servers: [],
        categories: ['Diamonds', 'Membership & Pass'],
        products: [
            { sku: 'DUMMY-ML-19', category: 'Diamonds', name: '19 Diamonds (17 + 2 Bonus)', price: 5000 },
            { sku: 'DUMMY-ML-86', category: 'Diamonds', name: '86 Diamonds (78 + 8 Bonus)', price: 19000 },
            { sku: 'DUMMY-ML-172', category: 'Diamonds', name: '172 Diamonds (156 + 16 Bonus)', price: 38000 },
            { sku: 'DUMMY-ML-WDP', category: 'Membership & Pass', name: 'Weekly Diamond Pass', price: 25000 }
        ]
    },
    {
        name: 'Free Fire',
        category: 'Mobile Game',
        image_url: makeGameBadgeDataUri('FREE FIRE', '#c2410c', '#18181b'),
        needs_server_id: false,
        target_id_label: 'Masukkan Player ID',
        servers: [],
        categories: ['Diamonds', 'Membership'],
        products: [
            { sku: 'DUMMY-FF-50', category: 'Diamonds', name: '50 Diamonds', price: 6500 },
            { sku: 'DUMMY-FF-140', category: 'Diamonds', name: '140 Diamonds', price: 18000 },
            { sku: 'DUMMY-FF-355', category: 'Diamonds', name: '355 Diamonds', price: 44000 },
            { sku: 'DUMMY-FF-MM', category: 'Membership', name: 'Member Mingguan', price: 27000 }
        ]
    },
    {
        name: 'Genshin Impact',
        category: 'Mobile Game',
        image_url: makeGameBadgeDataUri('GENSHIN IMPACT', '#0e7490', '#1e1b4b'),
        needs_server_id: true,
        target_id_label: 'Masukkan UID',
        servers: ['Asia', 'America', 'Europe', 'TW, HK, MO'],
        categories: ['Genesis Crystals', 'Blessing'],
        products: [
            { sku: 'DUMMY-GI-60', category: 'Genesis Crystals', name: '60 Genesis Crystals', price: 12000 },
            { sku: 'DUMMY-GI-330', category: 'Genesis Crystals', name: '330 Genesis Crystals (300 + 30)', price: 58000 },
            { sku: 'DUMMY-GI-1090', category: 'Genesis Crystals', name: '1090 Genesis Crystals (980 + 110)', price: 130000 },
            { sku: 'DUMMY-GI-WELKIN', category: 'Blessing', name: 'Blessing of the Welkin Moon', price: 57000 }
        ]
    },
    {
        name: 'Valorant',
        category: 'PC Game',
        image_url: makeGameBadgeDataUri('VALORANT', '#be123c', '#09090b'),
        needs_server_id: false,
        target_id_label: 'Masukkan Riot ID (Contoh: Player#SEA)',
        servers: [],
        categories: ['Valorant Points'],
        products: [
            { sku: 'DUMMY-VAL-125', category: 'Valorant Points', name: '125 Valorant Points', price: 13500 },
            { sku: 'DUMMY-VAL-475', category: 'Valorant Points', name: '475 Valorant Points', price: 48000 },
            { sku: 'DUMMY-VAL-1000', category: 'Valorant Points', name: '1000 Valorant Points', price: 95000 },
            { sku: 'DUMMY-VAL-1475', category: 'Valorant Points', name: '1475 Valorant Points', price: 133000 }
        ]
    }
];

async function ensureRoles(client) {
    for (const role of DEFAULT_ROLES) {
        await client.query(
            'INSERT INTO roles (name, margin_percent) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
            [role.name, role.margin]
        );
    }
}

async function seedLocalDummy() {
    const client = await pool.connect();
    try {
        console.log('[seed] Memulai seeding data dummy lokal...');
        await client.query('BEGIN');

        await ensureRoles(client);

        const seededProductsBySku = new Map();

        for (const gameData of DUMMY_GAMES) {
            const { rows: gameRows } = await client.query(
                `INSERT INTO games (name, category, image_url, needs_server_id, status, target_id_label)
                 VALUES ($1, $2, $3, $4, 'Active', $5)
                 ON CONFLICT (name) DO UPDATE SET
                    category = EXCLUDED.category,
                    image_url = EXCLUDED.image_url,
                    needs_server_id = EXCLUDED.needs_server_id,
                    status = 'Active',
                    target_id_label = EXCLUDED.target_id_label,
                    updated_at = NOW()
                 RETURNING id`,
                [gameData.name, gameData.category, gameData.image_url, gameData.needs_server_id, gameData.target_id_label]
            );
            const gameId = gameRows[0].id;

            for (const serverName of gameData.servers) {
                const { rows: existingServer } = await client.query(
                    'SELECT id FROM game_servers WHERE game_id = $1 AND server_name = $2 LIMIT 1',
                    [gameId, serverName]
                );
                if (existingServer.length === 0) {
                    await client.query(
                        'INSERT INTO game_servers (game_id, server_name) VALUES ($1, $2)',
                        [gameId, serverName]
                    );
                }
            }

            const categoryIdMap = new Map();
            for (const catName of gameData.categories) {
                const { rows: catRows } = await client.query(
                    `INSERT INTO product_categories (game_id, name)
                     VALUES ($1, $2)
                     ON CONFLICT (game_id, name) DO UPDATE SET name = EXCLUDED.name
                     RETURNING id`,
                    [gameId, catName]
                );
                categoryIdMap.set(catName, catRows[0].id);
            }

            for (const prod of gameData.products) {
                const categoryId = categoryIdMap.get(prod.category);
                const { rows: prodRows } = await client.query(
                    `INSERT INTO products (game_id, category_id, name, provider_sku, price, status, use_manual_prices, manual_prices)
                     VALUES ($1, $2, $3, $4, $5, 'Active', false, '{}'::jsonb)
                     ON CONFLICT (provider_sku) DO UPDATE SET
                        game_id = EXCLUDED.game_id,
                        category_id = EXCLUDED.category_id,
                        name = EXCLUDED.name,
                        price = EXCLUDED.price,
                        status = 'Active',
                        updated_at = NOW()
                     RETURNING id`,
                    [gameId, categoryId, prod.name, prod.sku, prod.price]
                );
                seededProductsBySku.set(prod.sku, prodRows[0].id);
            }
        }

        // Seed 1 promo code aktif: MIKUBARU (10%, maks Rp 5.000)
        const promoRules = {
            min_price: 10000,
            max_discount_amount: 5000,
            max_uses_per_user: 3
        };
        const { rows: existingPromo } = await client.query(
            "SELECT id FROM promo_codes WHERE code = 'MIKUBARU' LIMIT 1"
        );
        if (existingPromo.length > 0) {
            await client.query(
                `UPDATE promo_codes
                 SET description = $1,
                     type = 'percentage',
                     value = 10,
                     expires_at = NOW() + INTERVAL '30 days',
                     rules = $2,
                     max_uses = 100,
                     is_active = true,
                     updated_at = NOW()
                 WHERE id = $3`,
                ['Promo Pengujian Lokal 10% (Maks Rp 5.000)', promoRules, existingPromo[0].id]
            );
        } else {
            await client.query(
                `INSERT INTO promo_codes (code, description, type, value, expires_at, rules, max_uses, uses_count, is_active)
                 VALUES ('MIKUBARU', $1, 'percentage', 10, NOW() + INTERVAL '30 days', $2, 100, 0, true)`,
                ['Promo Pengujian Lokal 10% (Maks Rp 5.000)', promoRules]
            );
        }

        // Seed 1 item Flash Sale aktif untuk Mobile Legends 86 Diamonds
        const flashProductId = seededProductsBySku.get('DUMMY-ML-86');
        if (flashProductId) {
            const { rows: existingFs } = await client.query(
                'SELECT id FROM flash_sales WHERE product_id = $1 LIMIT 1',
                [flashProductId]
            );
            if (existingFs.length > 0) {
                await client.query(
                    `UPDATE flash_sales
                     SET discount_price = 17500,
                         start_at = NOW() - INTERVAL '1 hour',
                         end_at = NOW() + INTERVAL '7 days',
                         max_uses = 50,
                         is_active = true,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [existingFs[0].id]
                );
            } else {
                await client.query(
                    `INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, uses_count, is_active)
                     VALUES ($1, 17500, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days', 50, 0, true)`,
                    [flashProductId]
                );
            }
        }

        await client.query('COMMIT');
        console.log(`[seed] Selesai! ${DUMMY_GAMES.length} game, ${seededProductsBySku.size} produk, 1 promo (MIKUBARU), dan 1 flash sale aktif siap digunakan.`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[seed] Gagal melakukan seeding:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

seedLocalDummy();
