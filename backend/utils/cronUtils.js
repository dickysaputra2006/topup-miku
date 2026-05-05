require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

// --- KONFIGURASI DATABASE ---
const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
};
const pool = new Pool(dbConfig);

// --- KONFIGURASI FOXY API ---
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY;

const foxyApiHeaders = { 
    'Authorization': FOXY_API_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Referer': 'https://www.foxygamestore.com/'
};

function safeErrorDetail(error) {
    if (!error) return { message: 'Unknown error' };
    const detail = {};
    if (error.code) detail.code = error.code;
    if (error.response && error.response.status) detail.status = error.response.status;
    if (error.message) detail.message = String(error.message).replace(/(api[_-]?key|authorization|password|token|secret)=?[^\s,]*/gi, '$1=[REDACTED]');
    return detail;
}

// ========================================================================
// === FUNGSI: CEK STATUS TRANSAKSI PENDING ===
// ========================================================================
async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    let pendingTx;
    try {
        const res = await pool.query(
            `SELECT t.id, t.invoice_id, t.user_id, t.price, t.provider_trx_id, t.check_attempts, p.name as product_name, u.h2h_callback_url FROM transactions t JOIN products p ON t.product_id = p.id JOIN users u ON t.user_id = u.id WHERE t.status = 'Pending'`
        );
        pendingTx = res.rows;
    } catch (err) {
        console.error('Database error during checkPendingTransactions job (initial fetch):', safeErrorDetail(err));
        return;
    }

    if (pendingTx.length === 0) {
        console.log('No pending transactions found.');
        return;
    }

    for (const tx of pendingTx) {
        if (!tx.provider_trx_id) continue;

        let foxyStatus = null;
        let serialNumber = 'Tidak ada SN';
        let isNotFound = false;

        try {
            const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, { headers: foxyApiHeaders });
            const foxyData = foxyResponse.data.data;
            foxyStatus = foxyData.status.toUpperCase();
            serialNumber = foxyData.sn || 'Tidak ada SN';
        } catch (foxyError) {
            if (foxyError.response && foxyError.response.status === 404) {
                isNotFound = true;
            } else {
                console.error(`Error checking Foxy status for ${tx.provider_trx_id}:`, safeErrorDetail(foxyError));
                continue;
            }
        }

        const client = await pool.connect();
        let finalStatus = null;
        // committedStatus is assigned only after COMMIT succeeds.
        // H2H webhook must never fire if the DB write was rolled back.
        let committedStatus = null;
        try {
            await client.query('BEGIN');
            
            const checkRes = await client.query('SELECT status, check_attempts FROM transactions WHERE id = $1 FOR UPDATE', [tx.id]);
            if (checkRes.rows.length === 0) {
                await client.query('ROLLBACK');
                continue;
            }
            const currentDbTx = checkRes.rows[0];
            
            if (currentDbTx.status !== 'Pending') {
                await client.query('ROLLBACK');
                continue;
            }

            if (isNotFound) {
                const MAX_ATTEMPTS = 5;
                if (currentDbTx.check_attempts < MAX_ATTEMPTS) {
                    await client.query('UPDATE transactions SET check_attempts = check_attempts + 1 WHERE id = $1', [tx.id]);
                } else {
                    finalStatus = 'Failed';
                    await client.query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2', [finalStatus, tx.id]);
                    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                    const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: Transaksi kadaluarsa di provider (Cron)`;
                    await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)', [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
                }
            } else if (foxyStatus === 'SUCCESS') {
                finalStatus = 'Success';
                await client.query('UPDATE transactions SET status = $1, provider_sn = $2, updated_at = NOW() WHERE id = $3', [finalStatus, serialNumber, tx.id]);
            } else if (foxyStatus === 'FAILED' || foxyStatus === 'REFUNDED') {
                finalStatus = 'Failed';
                await client.query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2', [finalStatus, tx.id]);
                await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: Gagal/Refund dari provider (Cron)`;
                await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)', [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
            }

            await client.query('COMMIT');
            // Only mark as committed once COMMIT succeeds; catch block cannot reach here.
            committedStatus = finalStatus;
        } catch (dbError) {
            await client.query('ROLLBACK');
            console.error(`Database error during tx ${tx.invoice_id} resolution:`, safeErrorDetail(dbError));
        } finally {
            client.release();
        }

        if (committedStatus && tx.h2h_callback_url) {
            const webhookPayload = {
                invoice_id: tx.invoice_id,
                status: finalStatus,
                product_name: tx.product_name,
                price: tx.price,
                serial_number: serialNumber,
                timestamp: new Date().toISOString()
            };
            axios.post(tx.h2h_callback_url, webhookPayload)
                 .catch(err => console.error(`Failed to send webhook for ${tx.invoice_id}:`, err.message));
        }
    }
}


// ========================================================================
// === FUNGSI: SINKRONISASI PRODUK ===
// ========================================================================
async function syncProductsWithFoxy() { 
    console.log('Running smart product sync job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Konfigurasi Axios dengan User-Agent
        const axiosConfig = {
            headers: { 
                'Authorization': FOXY_API_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                'Referer': 'https://www.foxygamestore.com/'
            }
        };

        // 1. Ambil semua produk dari Foxy
        const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, axiosConfig);
        const providerProducts = response.data.data;
        if (!Array.isArray(providerProducts)) {
            throw new Error('Format respons Foxy API tidak sesuai.');
        }
        const providerSkus = new Set(providerProducts.map(p => p.product_code));

        // 2. Ambil semua produk, game, dan kategori yang ada di database kita
        const { rows: localProducts } = await client.query('SELECT id, provider_sku, price, status FROM products');
        const { rows: localGames } = await client.query('SELECT id, name FROM games');
        const localGameMap = new Map(localGames.map(g => [g.name.toLowerCase(), g.id]));
        const { rows: localCategories } = await client.query('SELECT id, game_id, name FROM product_categories');
        const localCategoryMap = new Map(localCategories.map(c => [`${c.game_id}:${c.name.toLowerCase()}`, c.id]));

        const productBatch = {
            gameIds: [],
            categoryIds: [],
            names: [],
            skus: [],
            prices: [],
            statuses: []
        };

        // 3. Looping produk dari Foxy untuk mengumpulkan data batch
        for (const product of providerProducts) {
            const gameName = product.category_title;
            const categoryName = product.category_type;
            const productName = product.product_name;
            const productCode = product.product_code;
            const basePriceFoxy = product.product_price;

            if (!gameName || !productName || !productCode || basePriceFoxy === undefined) continue;

            // Dapatkan atau buat gameId
            let gameId = localGameMap.get(gameName.toLowerCase());
            if (!gameId) {
                const { rows: newGame } = await client.query('INSERT INTO games (name, category, image_url, status) VALUES ($1, $2, $3, $4) RETURNING id', [gameName, categoryName, 'https://via.placeholder.com/200', 'Active']);
                gameId = newGame[0].id;
                localGameMap.set(gameName.toLowerCase(), gameId);
            }

            // Dapatkan atau buat categoryId
            const categoryKey = `${gameId}:${categoryName.toLowerCase()}`;
            let categoryId = localCategoryMap.get(categoryKey);
            if (!categoryId) {
                const { rows: newCat } = await client.query('INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id', [gameId, categoryName]);
                categoryId = newCat[0].id;
                localCategoryMap.set(categoryKey, categoryId);
            }

            productBatch.gameIds.push(gameId);
            productBatch.categoryIds.push(categoryId);
            productBatch.names.push(productName);
            productBatch.skus.push(productCode);
            productBatch.prices.push(basePriceFoxy);
            productBatch.statuses.push('Active');
        }

        // Jalankan UPSERT batch untuk produk
        if (productBatch.skus.length > 0) {
            await client.query(`
                INSERT INTO products (game_id, category_id, name, provider_sku, price, status)
                SELECT * FROM unnest($1::int[], $2::int[], $3::varchar[], $4::varchar[], $5::decimal[], $6::varchar[])
                ON CONFLICT (provider_sku) DO UPDATE SET
                    game_id = EXCLUDED.game_id,
                    category_id = EXCLUDED.category_id,
                    name = EXCLUDED.name,
                    price = EXCLUDED.price,
                    status = EXCLUDED.status,
                    updated_at = NOW()
            `, [
                productBatch.gameIds,
                productBatch.categoryIds,
                productBatch.names,
                productBatch.skus,
                productBatch.prices,
                productBatch.statuses
            ]);
        }

        // 4. Nonaktifkan produk lokal yang tidak ada di Foxy lagi secara batch
        const deactivateIds = localProducts
            .filter(lp => lp.status === 'Active' && !providerSkus.has(lp.provider_sku))
            .map(lp => lp.id);

        if (deactivateIds.length > 0) {
            await client.query('UPDATE products SET status = $1, updated_at = NOW() WHERE id = ANY($2::int[])', ['Inactive', deactivateIds]);
            console.log(`DEACTIVATED: ${deactivateIds.length} products`);
        }
        
        await client.query('COMMIT');
        console.log('Smart product sync job finished successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Smart product sync job failed:', safeErrorDetail(error));
        throw error;
    } finally {
        client.release();
    }
}

// ========================================================================
// === FUNGSI UTAMA UNTUK MENJALANKAN SEMUA CRON JOB ===
// ========================================================================
async function runAllCronJobs() {
    console.log('Starting all cron jobs...');
    try {
        await checkPendingTransactions();
        await syncProductsWithFoxy();
        console.log('All cron jobs completed successfully.');
    } catch (error) {
        console.error('One or more cron jobs failed:', error);
        // Lemparkan error agar bisa ditangkap oleh pemanggil
        throw error; 
    }
}

module.exports = { checkPendingTransactions, syncProductsWithFoxy, runAllCronJobs };
