require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const axios = require('axios');
const puppeteer = require('puppeteer');

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

async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: pendingTx } = await client.query(
            `SELECT 
                t.id, t.invoice_id, t.user_id, t.price, t.provider_trx_id, t.check_attempts, 
                p.name as product_name, u.h2h_callback_url
             FROM transactions t
             JOIN products p ON t.product_id = p.id
             JOIN users u ON t.user_id = u.id
             WHERE t.status = 'Pending' FOR UPDATE`
        );

        if (pendingTx.length === 0) {
            console.log('No pending transactions found.');
            await client.query('COMMIT');
            return; 
        }

        for (const tx of pendingTx) {
            if (!tx.provider_trx_id) continue;

            try {
                const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, {
                    headers: { 
                        'Authorization': FOXY_API_KEY,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        'Referer': 'https://www.foxygamestore.com/'
                    }
                });

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
                    console.log(`Sending webhook for invoice ${tx.invoice_id} to ${tx.h2h_callback_url}`);
                    axios.post(tx.h2h_callback_url, webhookPayload)
                         .then(res => console.log(`Webhook for ${tx.invoice_id} sent successfully.`))
                         .catch(err => console.error(`Failed to send webhook for ${tx.invoice_id}:`, err.message));
                }

            } catch (foxyError) {
                if (foxyError.response && foxyError.response.status === 404) {
                    const MAX_ATTEMPTS = 5;
                    if (tx.check_attempts < MAX_ATTEMPTS) {
                        console.warn(`Transaction ${tx.provider_trx_id} not found on Foxy. Attempt ${tx.check_attempts + 1}. Retrying on next run.`);
                        await client.query('UPDATE transactions SET check_attempts = check_attempts + 1 WHERE id = $1', [tx.id]);
                    } else {
                        console.error(`Transaction ${tx.provider_trx_id} not found after ${MAX_ATTEMPTS} attempts. Marking as Failed.`);
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

async function syncProductsWithFoxy() { 
    console.log('Running smart product sync job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let providerProducts = [];
        try {
            const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, {
                headers: { 
                    'Authorization': FOXY_API_KEY,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': 'https://www.foxygamestore.com/'
                }
            });
            providerProducts = response.data.data;
        } catch (axiosError) {
            console.warn("Axios request failed, trying Puppeteer bypass...", axiosError.message);
            
            const browser = await puppeteer.launch({ headless: true });
            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
            await page.setExtraHTTPHeaders({ 'Authorization': FOXY_API_KEY });
            
            providerProducts = await page.evaluate(async (url) => {
                const res = await fetch(url, {
                    headers: {
                        'Authorization': document.querySelector('meta[name="Authorization"]')?.content || '',
                        'User-Agent': navigator.userAgent,
                        'Referer': 'https://www.foxygamestore.com/'
                    }
                });
                return await res.json();
            }, `${FOXY_BASE_URL}/v1/products`);

            await browser.close();

            if (!Array.isArray(providerProducts.data)) {
                throw new Error('Format respons Foxy API tidak sesuai dari Puppeteer.');
            }
            providerProducts = providerProducts.data;
        }

        const providerSkus = new Set(providerProducts.map(p => p.product_code));
        const { rows: localProducts } = await client.query('SELECT id, provider_sku, price, status FROM products');
        const localProductMap = new Map(localProducts.map(p => [p.provider_sku, p]));

        for (const product of providerProducts) {
            const gameName = product.category_title;
            const categoryName = product.category_type;
            const productName = product.product_name;
            const productCode = product.product_code;
            const basePriceFoxy = product.product_price;
            const localProduct = localProductMap.get(productCode);

            if (!gameName || !productName || !productCode || basePriceFoxy === undefined) continue;

            if (localProduct) {
                if (localProduct.price !== basePriceFoxy || localProduct.status !== 'Active') {
                    await client.query(
                        'UPDATE products SET price = $1, status = $2 WHERE provider_sku = $3',
                        [basePriceFoxy, 'Active', productCode]
                    );
                    console.log(`UPDATED: ${productName} - Price/Status changed.`);
                }
            } else {
                let { rows: games } = await client.query('SELECT id FROM games WHERE name = $1', [gameName]);
                if (games.length === 0) {
                    const { rows: newGame } = await client.query('INSERT INTO games (name, category, image_url, status) VALUES ($1, $2, $3, $4) RETURNING id', [gameName, categoryName, 'https://via.placeholder.com/200', 'Active']);
                    games = newGame;
                }
                const gameId = games[0].id;

                await client.query(
                    'INSERT INTO products (game_id, name, provider_sku, price, status) VALUES ($1, $2, $3, $4, $5)',
                    [gameId, productName, productCode, basePriceFoxy, 'Active']
                );
                console.log(`INSERTED: ${productName} - New product added.`);
            }
        }

        for (const localProduct of localProducts) {
            if (localProduct.status === 'Active' && !providerSkus.has(localProduct.provider_sku)) {
                await client.query('UPDATE products SET status = $1 WHERE id = $2', ['Inactive', localProduct.id]);
                console.log(`DEACTIVATED: Product with SKU ${localProduct.provider_sku} is no longer available from provider.`);
            }
        }
        
        await client.query('COMMIT');
        console.log('Smart product sync job finished successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Smart product sync job failed:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

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
