
const { Pool } = require('pg');
const axios = require('axios');


const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
};
const pool = new Pool(dbConfig);


const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY;

async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Modifikasi query untuk mengambil juga callback_url dan nama produk
        const { rows: pendingTx } = await client.query(
            `SELECT t.id, t.invoice_id, t.user_id, t.price, t.provider_trx_id, p.name as product_name, u.h2h_callback_url
             FROM transactions t
             JOIN products p ON t.product_id = p.id
             JOIN users u ON t.user_id = u.id
             WHERE t.status = 'Pending' FOR UPDATE`
        );

        if (pendingTx.length === 0) {
            console.log('No pending transactions found.');
            await client.query('COMMIT');
            client.release();
            return;
        }

        for (const tx of pendingTx) {
            if (!tx.provider_trx_id) continue;

            try {
                const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, {
                    headers: { 'Authorization': FOXY_API_KEY }
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
                    // Anda bisa menambahkan logika untuk mencatat refund di balance_history di sini
                }

                // =======================================================
                // BAGIAN BARU: KIRIM WEBHOOK JIKA STATUS BERUBAH
                // =======================================================
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
                    
                    // Kirim notifikasi ke URL callback milik partner
                    // Dijalankan tanpa 'await' agar tidak memblokir cron job jika salah satu webhook lambat
                    axios.post(tx.h2h_callback_url, webhookPayload)
                         .then(res => console.log(`Webhook for ${tx.invoice_id} sent successfully.`))
                         .catch(err => console.error(`Failed to send webhook for ${tx.invoice_id}:`, err.message));
                }
                // =======================================================

            } catch (foxyError) {
                console.error(`Error checking Foxy status for ${tx.provider_trx_id}:`, foxyError.message);
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
    console.log('Running syncProductsWithFoxy job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

     

        const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, {
            headers: { 'Authorization': FOXY_API_KEY }
        });

        const providerProducts = response.data.data;

        if (!Array.isArray(providerProducts)) {
            throw new Error('Format respons Foxy API tidak sesuai: "data" bukan array.');
        }

        let productsSyncedCount = 0;
        let gamesAddedCount = 0;

        for (const product of providerProducts) {
            const gameName = product.category_title;
            const categoryName = product.category_type;
            const productName = product.product_name;
            const productCode = product.product_code;
            const basePriceFoxy = product.product_price; // Harga pokok murni dari Foxy API

            if (!gameName || !categoryName || !productName || !productCode || basePriceFoxy === undefined || basePriceFoxy === null) {
                 console.warn(`Produk Foxy dilewati karena data tidak lengkap:`, {
                     gameName, categoryName, productName, productCode, basePriceFoxy, originalProduct: product
                 });
                 continue;
            }
            
            let { rows: games } = await client.query('SELECT id FROM games WHERE name = $1', [gameName]);
            if (games.length === 0) {
                console.warn(`Game "${gameName}" tidak ditemukan. Membuat game baru.`);
                const { rows: newGameResult } = await client.query('INSERT INTO games (name, category, image_url, needs_server_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [gameName, categoryName, 'https://via.placeholder.com/200', false, 'Active']);
                games = [{ id: newGameResult[0].id }];
                gamesAddedCount++;
            }
            const gameId = games[0].id;

            let { rows: categories } = await client.query('SELECT id FROM product_categories WHERE name = $1 AND game_id = $2', [categoryName, gameId]);
            let categoryId;
            if (categories.length === 0) {
                const { rows: newCat } = await client.query('INSERT INTO product_categories (game_id, name) VALUES ($1, $2) RETURNING id', [gameId, categoryName]);
                categoryId = newCat[0].id;
            } else {
                categoryId = categories[0].id;
            }

            // Simpan HARGA POKOK MURNI dari Foxy ke database (products.price)
            const sql = `INSERT INTO products (game_id, category_id, name, provider_sku, price, status) 
                         VALUES ($1, $2, $3, $4, $5, $6) 
                         ON CONFLICT (provider_sku) DO UPDATE 
                         SET name = EXCLUDED.name, price = EXCLUDED.price, game_id = EXCLUDED.game_id, category_id = EXCLUDED.category_id, status = EXCLUDED.status`;
            await client.query(sql, [gameId, categoryId, productName, productCode, basePriceFoxy, 'Active']); // Gunakan basePriceFoxy langsung
            productsSyncedCount++;
        }
        await client.query('COMMIT');
        console.log(`syncProductsWithFoxy job finished. Synced ${productsSyncedCount} products, added ${gamesAddedCount} new games.`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('syncProductsWithFoxy job failed:', error.response ? error.response.data : error.message);
        throw error;
    } finally {
        client.release();
    }
}

async function runAllCronJobs() {
    console.log('Starting all cron jobs...');
    try {
        await checkPendingTransactions(); // Tetap jalankan pengecekan transaksi
        await syncProductsWithFoxy();     // Panggil sinkronisasi produk otomatis
        console.log('All cron jobs completed successfully.');
    } catch (error) {
        console.error('One or more cron jobs failed:', error);
        throw error; // Re-throw untuk ditangkap oleh cron_job_script.js
    }
}


module.exports = { checkPendingTransactions, syncProductsWithFoxy, runAllCronJobs };