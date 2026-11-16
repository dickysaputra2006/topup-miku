const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { Pool } = require('pg');

// Pengaman agar seeder data dummy tidak pernah dijalankan di production maupun DB remote
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error('[seed] DIBATALKAN: Seeder dummy tidak boleh dijalankan saat NODE_ENV=production.');
    process.exit(1);
}

const configuredDbHost = String(process.env.DB_HOST || '').trim().toLowerCase();
const hasLocalConfirmFlag = process.argv.includes('--confirm-local');
if (configuredDbHost && !['localhost', '127.0.0.1'].includes(configuredDbHost) && !hasLocalConfirmFlag) {
    console.error(`[seed] DIBATALKAN: DB_HOST ("${configuredDbHost}") bukan localhost/127.0.0.1. Tambahkan --confirm-local jika ini DB lokal.`);
    process.exit(1);
}

const BCRYPT_SALT_ROUNDS = 12;
const rotateQaKeys = process.argv.includes('--rotate-qa-keys');

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
 * Buat SVG data URI lokal sebagai gambar game agar tampil cepat tanpa bergantung CDN eksternal.
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

const DEFAULT_PAYMENT_METHODS = [
    {
        code: 'GOPAY',
        name: 'GoPay',
        type: 'ewallet',
        account_number: '081200000001',
        account_name: 'Admin MIKU Store (QA)',
        qris_image_url: null,
        instructions: 'Transfer tepat sesuai total nominal termasuk kode unik 3 digit.',
        is_qris: false,
        min_amount: 10000,
        sort_order: 1
    },
    {
        code: 'QRIS',
        name: 'QRIS All Payment',
        type: 'qris',
        account_number: null,
        account_name: 'MIKU Store QA',
        qris_image_url: null,
        instructions: 'Scan QRIS lalu bayar tepat nominal deposit tanpa kode unik.',
        is_qris: true,
        min_amount: 10000,
        sort_order: 2
    }
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

async function ensureRolesAndGetMap(client) {
    for (const role of DEFAULT_ROLES) {
        await client.query(
            'INSERT INTO roles (name, margin_percent) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
            [role.name, role.margin]
        );
    }
    const { rows } = await client.query('SELECT id, LOWER(name) AS role_key FROM roles');
    return new Map(rows.map(r => [r.role_key, r.id]));
}

async function ensurePaymentMethods(client) {
    for (const pm of DEFAULT_PAYMENT_METHODS) {
        await client.query(
            `INSERT INTO payment_methods (
                code, name, type, account_number, account_name, qris_image_url,
                instructions, is_qris, min_amount, is_active, sort_order
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)
             ON CONFLICT (code) DO NOTHING`,
            [
                pm.code, pm.name, pm.type, pm.account_number, pm.account_name,
                pm.qris_image_url, pm.instructions, pm.is_qris, pm.min_amount, pm.sort_order
            ]
        );
    }
}

async function seedQaAccounts(client, roleMap) {
    const qaPassword = (process.env.SEED_QA_PASSWORD || '').trim() || 'MikuQaLocal#2026';
    const hashedPassword = await bcrypt.hash(qaPassword, BCRYPT_SALT_ROUNDS);

    const rawApiKey = crypto.randomBytes(32).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const apiKeyPrefix = rawApiKey.slice(0, 8);
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const accounts = [
        {
            username: 'qa_member',
            fullName: 'QA Member Store',
            email: 'qa.member@local.test',
            nomorWa: '+628110000001',
            balance: 100000,
            roleId: roleMap.get('bronze') || roleMap.get('user') || 1,
            isH2H: false
        },
        {
            username: 'qa_reseller',
            fullName: 'QA Reseller H2H',
            email: 'qa.reseller@local.test',
            nomorWa: '+628110000002',
            balance: 500000,
            roleId: roleMap.get('partner') || roleMap.get('gold') || 1,
            isH2H: true
        },
        {
            username: 'qa_admin',
            fullName: 'QA Admin Store',
            email: 'qa.admin@local.test',
            nomorWa: '+628110000003',
            balance: 0,
            roleId: roleMap.get('admin') || 2,
            isH2H: false
        }
    ];

    let exposedResellerKey = null;
    let resellerPrefix = apiKeyPrefix;

    for (const acc of accounts) {
        const keyUpdateSql = rotateQaKeys
            ? 'api_key = NULL, api_key_hash = EXCLUDED.api_key_hash, api_key_prefix = EXCLUDED.api_key_prefix, h2h_webhook_secret = COALESCE(users.h2h_webhook_secret, EXCLUDED.h2h_webhook_secret)'
            : 'api_key = NULL, api_key_hash = COALESCE(users.api_key_hash, EXCLUDED.api_key_hash), api_key_prefix = COALESCE(users.api_key_prefix, EXCLUDED.api_key_prefix), h2h_webhook_secret = COALESCE(users.h2h_webhook_secret, EXCLUDED.h2h_webhook_secret)';

        const { rows } = await client.query(
            `INSERT INTO users (
                full_name, username, email, nomor_wa, password, balance, role_id,
                api_key, api_key_hash, api_key_prefix, h2h_webhook_secret, whitelisted_ips
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11)
             ON CONFLICT (username) DO UPDATE SET
                full_name = EXCLUDED.full_name,
                email = EXCLUDED.email,
                nomor_wa = EXCLUDED.nomor_wa,
                password = EXCLUDED.password,
                balance = EXCLUDED.balance,
                role_id = EXCLUDED.role_id,
                ${acc.isH2H ? keyUpdateSql : 'api_key = users.api_key'},
                updated_at = NOW()
             RETURNING api_key_hash, api_key_prefix`,
            [
                acc.fullName,
                acc.username,
                acc.email,
                acc.nomorWa,
                hashedPassword,
                acc.balance,
                acc.roleId,
                acc.isH2H ? apiKeyHash : null,
                acc.isH2H ? apiKeyPrefix : null,
                acc.isH2H ? webhookSecret : null,
                []
            ]
        );

        if (acc.isH2H && rows[0]) {
            resellerPrefix = rows[0].api_key_prefix || apiKeyPrefix;
            if (rows[0].api_key_hash === apiKeyHash) {
                exposedResellerKey = rawApiKey;
            }
        }
    }

    return { qaPassword, exposedResellerKey, resellerPrefix };
}

async function seedCatalog(client) {
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
            await client.query(
                'INSERT INTO game_servers (game_id, server_name) VALUES ($1, $2) ON CONFLICT (game_id, server_name) DO NOTHING',
                [gameId, serverName]
            );
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

    const promoRules = { min_price: 10000, max_discount_amount: 5000, max_uses_per_user: 3 };
    await client.query(
        `INSERT INTO promo_codes (code, description, type, value, expires_at, rules, max_uses, uses_count, is_active)
         VALUES ('MIKUBARU', $1, 'percentage', 10, NOW() + INTERVAL '30 days', $2, 100, 0, true)
         ON CONFLICT (code) DO UPDATE SET
            description = EXCLUDED.description,
            type = EXCLUDED.type,
            value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            rules = EXCLUDED.rules,
            max_uses = EXCLUDED.max_uses,
            is_active = true,
            updated_at = NOW()`,
        ['Promo Pengujian Lokal 10% (Maks Rp 5.000)', promoRules]
    );

    const flashProductId = seededProductsBySku.get('DUMMY-ML-86');
    if (flashProductId) {
        const { rows: existingFs } = await client.query(
            'SELECT id FROM flash_sales WHERE product_id = $1 LIMIT 1',
            [flashProductId]
        );
        if (existingFs.length > 0) {
            await client.query(
                `UPDATE flash_sales
                 SET discount_price = 17500, start_at = NOW() - INTERVAL '1 hour',
                     end_at = NOW() + INTERVAL '7 days', max_uses = 50, is_active = true, updated_at = NOW()
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

    return seededProductsBySku.size;
}

async function seedLocalDummy() {
    const client = await pool.connect();
    try {
        console.log('[seed] Memulai seeding data dummy & akun QA lokal...');
        await client.query('BEGIN');

        const roleMap = await ensureRolesAndGetMap(client);
        await ensurePaymentMethods(client);
        const productCount = await seedCatalog(client);
        const { qaPassword, exposedResellerKey, resellerPrefix } = await seedQaAccounts(client, roleMap);

        await client.query('COMMIT');
        console.log(`[seed] Selesai! ${DUMMY_GAMES.length} game, ${productCount} produk, promo MIKUBARU, flash sale DUMMY-ML-86, payment_methods, dan 3 akun QA (qa_member, qa_reseller, qa_admin) siap.`);
        console.log(`[seed] Kredensial akun QA lokal -> password: "${qaPassword}" (bcrypt cost ${BCRYPT_SALT_ROUNDS})`);
        if (exposedResellerKey) {
            console.log(`[seed] qa_reseller H2H API Key baru (simpan untuk QA H2H): ${exposedResellerKey}`);
        } else {
            console.log(`[seed] qa_reseller H2H API Key sudah terdaftar (prefix: ${resellerPrefix}). Jalankan dengan --rotate-qa-keys atau Dashboard H2H bila ingin rotasi.`);
        }
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
