require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const axios = require('axios');

// --- KONFIGURASI DATABASE UNTUK CRON JOB ---
const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
};
const pool = new Pool(dbConfig);

// --- KONFIGURASI FOXY API UNTUK CRON JOB ---
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY;

// Konfigurasi headers default untuk semua panggilan ke Foxy
const foxyApiHeaders = { 
    'Authorization': FOXY_API_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Referer': 'https://www.foxygamestore.com/'
};


// ========================================================================
// === FUNGSI: CEK STATUS TRANSAKSI PENDING ===
// ========================================================================
async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: pendingTx } = await client.query(
            `SELECT t.id, t.invoice_id, t.user_id, t.price, t.provider_trx_id, t.check_attempts, p.name as product_name, u.h2h_callback_url FROM transactions t JOIN products p ON t.product_id = p.id JOIN users u ON t.user_id = u.id WHERE t.status = 'Pending' FOR UPDATE`
        );

        if (pendingTx.length === 0) {
            console.log('No pending transactions found.');
            await client.query('COMMIT');
            return; 
        }

        for (const tx of pendingTx) {
            if (!tx.provider_trx_id) continue;

            try {
                const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, { headers: foxyApiHeaders });

                const foxyData = foxyResponse.data.data;
                const foxyStatus = foxyData.status.toUpperCase();
                const serialNumber = foxyData.sn || 'Tidak ada SN';
                
                let finalStatus = null;

                if (foxyStatus === 'SUCCESS') {
                    finalStatus = 'Success';
                    await client.query('UPDATE transactions SET status = $1, provider_sn = $2, updated_at = NOW() WHERE id = $3', [finalStatus, serialNumber, tx.id]);
                } else if (foxyStatus === 'FAILED' || foxyStatus === 'REFUNDED') {
                    finalStatus = 'Failed';
                    await client.query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2', [finalStatus, tx.id]);
                    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                }

                if (finalStatus && tx.h2h_callback_url) {
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

            } catch (foxyError) {
                if (foxyError.response && foxyError.response.status === 404) {
                    const MAX_ATTEMPTS = 5;
                    if (tx.check_attempts < MAX_ATTEMPTS) {
                        await client.query('UPDATE transactions SET check_attempts = check_attempts + 1 WHERE id = $1', [tx.id]);
                    } else {
                        await client.query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2', ['Failed', tx.id]);
                        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                    }
                } else {
                    console.error(`Error checking Foxy status for ${tx.provider_trx_id}:`, foxyError.message);
                }
            }
        }
        await client.query('COMMIT');
    } catch (dbError) {
        await client.query('ROLLBACK');
        console.error('Database error during checkPendingTransactions job:', dbError);
        throw dbError;
    } finally {
        client.release();
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

        // 2. Ambil semua produk dan game yang ada di database kita
        const { rows: localProducts } = await client.query('SELECT id, provider_sku, price, status FROM products');
        const localProductMap = new Map(localProducts.map(p => [p.provider_sku, p]));
        const { rows: localGames } = await client.query('SELECT id, name FROM games');
        const localGameMap = new Map(localGames.map(g => [g.name.toLowerCase(), g.id]));

        // 3. Looping produk dari Foxy untuk INSERT atau UPDATE
        for (const product of providerProducts) {
            const gameName = product.category_title;
            const categoryName = product.category_type;
            const productName = product.product_name;
            const productCode = product.product_code;
            const basePriceFoxy = product.product_price;
            const localProduct = localProductMap.get(productCode);

            if (!gameName || !productName || !productCode || basePriceFoxy === undefined) continue;

            // Dapatkan atau buat gameId
            let gameId = localGameMap.get(gameName.toLowerCase());
            if (!gameId) {
                const { rows: newGame } = await client.query('INSERT INTO games (name, category, image_url, status) VALUES ($1, $2, $3, $4) RETURNING id', [gameName, categoryName, 'https://via.placeholder.com/200', 'Active']);
                gameId = newGame[0].id;
                localGameMap.set(gameName.toLowerCase(), gameId); // Tambahkan ke map agar tidak buat ulang
            }

            // --- LOGIKA BARU UNTUK CATEGORY_ID ---
            // Cek apakah kategori sudah ada untuk game ini
            let { rows: categories } = await client.query('SELECT id FROM product_categories WHERE name = $1 AND game_id = $2', [categoryName, gameId]);
            let categoryId;
            if (categories.length === 0) {
                // Jika tidak ada, buat kategori baru
                const { rows: newCat } = await client.query('INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id', [gameId, categoryName]);
                categoryId = newCat[0].id;
            } else {
                categoryId = categories[0].id;
            }
            // --- AKHIR LOGIKA BARU ---

            if (localProduct) {
                // PRODUK SUDAH ADA -> Lakukan UPDATE
                await client.query(
                    'UPDATE products SET price = $1, status = $2, name = $3, game_id = $4, category_id = $5 WHERE provider_sku = $6',
                    [basePriceFoxy, 'Active', productName, gameId, categoryId, productCode]
                );
            } else {
                // PRODUK BARU -> Lakukan INSERT
                await client.query(
                    'INSERT INTO products (game_id, category_id, name, provider_sku, price, status) VALUES ($1, $2, $3, $4, $5, $6)',
                    [gameId, categoryId, productName, productCode, basePriceFoxy, 'Active']
                );
            }
        }

        // 4. Cek produk lokal yang tidak ada di Foxy lagi -> NONAKTIFKAN
        for (const localProduct of localProducts) {
            if (localProduct.status === 'Active' && !providerSkus.has(localProduct.provider_sku)) {
                await client.query('UPDATE products SET status = $1 WHERE id = $2', ['Inactive', localProduct.id]);
                console.log(`DEACTIVATED: Product with SKU ${localProduct.provider_sku}`);
            }
        }
        
        await client.query('COMMIT');
        console.log('Smart product sync job finished successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Smart product sync job failed:', error.response ? error.response.data : error.message);
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
        throw error;
    }
}

module.exports = { checkPendingTransactions, syncProductsWithFoxy, runAllCronJobs };