// utils/cronUtils.js
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

// ========================================================================
// === FUNGSI: CEK STATUS TRANSAKSI PENDING ===
// ========================================================================
async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    const client = await pool.connect(); // Dapatkan koneksi dari pool
    try {
        await client.query('BEGIN'); // Mulai transaksi database

        const { rows: pendingTx } = await client.query(
            `SELECT id, invoice_id, user_id, product_id, price, provider_trx_id FROM transactions WHERE status = 'Pending' FOR UPDATE`
        );

        if (pendingTx.length === 0) {
            console.log('No pending transactions found.');
            await client.query('COMMIT');
            return;
        }

        console.log(`Found ${pendingTx.length} pending transactions. Checking status with Foxy API...`);

        for (const tx of pendingTx) {
            // Pastikan tx.provider_trx_id valid sebelum memanggil Foxy API
            if (!tx.provider_trx_id) {
                console.warn(`Transaction ${tx.invoice_id} skipped in cron job: provider_trx_id is missing.`);
                continue; // Lewati transaksi ini jika ID provider tidak ada
            }

            try {
                const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, {
                    headers: { 'Authorization': FOXY_API_KEY }
                });

                const foxyStatus = foxyResponse.data.data.status;
                const foxyMessage = foxyResponse.data.message || 'No specific message from provider.';

                console.log(`Transaction ${tx.invoice_id} (Provider ID: ${tx.provider_trx_id}) - Foxy Status: ${foxyStatus}`);

                if (foxyStatus === 'SUCCESS') {
                    await client.query('UPDATE transactions SET status = \'Success\', updated_at = NOW() WHERE id = $1', [tx.id]);
                    console.log(`Transaction ${tx.invoice_id} updated to SUCCESS.`);
                } else if (foxyStatus === 'FAILED' || foxyStatus === 'REFUNDED') {
                    await client.query('UPDATE transactions SET status = \'Failed\', updated_at = NOW() WHERE id = $1', [tx.id]);
                    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                    const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} (Gagal/Refund dari provider): ${foxyMessage}`;
                    await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                        [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
                    console.log(`Transaction ${tx.invoice_id} updated to FAILED/REFUNDED and balance refunded.`);
                }
                // Jika statusnya masih 'PENDING' dari Foxy, biarkan saja di database Anda.

            } catch (foxyError) {
                // HANYA log error Foxy API, JANGAN re-throw atau rollback seluruh transaksi DB
                // Ini memastikan satu error API tidak menghentikan pemrosesan transaksi lain
                // dan tidak mengganggu commit transaksi DB utama.
                console.error(`Error checking Foxy status for ${tx.invoice_id} (Provider ID: ${tx.provider_trx_id}):`, foxyError.response ? foxyError.response.data : foxyError.message);
                if (foxyError.response && foxyError.response.status === 404) {
                    console.warn(`Foxy API returned 404 (INVOICE_NOT_FOUND) for ${tx.provider_trx_id}. This transaction might need manual review.`);
                }
            }
        }
        await client.query('COMMIT'); // Commit semua update transaksi yang berhasil
        console.log('checkPendingTransactions job finished.');

    } catch (dbError) {
        await client.query('ROLLBACK'); // Rollback seluruh transaksi jika ada error database
        console.error('Database error during checkPendingTransactions job:', dbError);
        throw dbError; // Lempar ulang error DB agar cron_job_script.js menangkapnya
    } finally {
        client.release(); // Selalu kembalikan koneksi ke pool
    }
}

// ========================================================================
// === FUNGSI SINKRONISASI PRODUK DENGAN FOXY API (OTOMATIS) ===
// ========================================================================
async function syncProductsWithFoxy(manualMarginPercent = null) { // Tambahkan parameter untuk margin manual
    console.log('Running syncProductsWithFoxy job...');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let margin_percent;
        if (manualMarginPercent !== null) {
            margin_percent = manualMarginPercent; // Gunakan margin manual jika disediakan
            console.log(`Syncing with manual margin: ${manualMarginPercent}%`);
        } else {
            // Mengambil rata-rata margin dari semua role yang bukan Admin atau Owner
            const { rows: roles } = await client.query('SELECT margin_percent FROM roles WHERE name NOT IN (\'Admin\', \'Owner\')');
            let totalMargin = 0;
            if (roles.length > 0) {
                totalMargin = roles.reduce((sum, role) => sum + parseFloat(role.margin_percent), 0) / roles.length;
            } else {
                totalMargin = 10; // Margin default jika tidak ada role yang cocok
            }
            margin_percent = totalMargin;
            console.log(`Syncing with average margin: ${margin_percent}%`);
        }


        const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, {
            headers: { 'Authorization': FOXY_API_KEY }
        });

        // Hapus console.log ini setelah debugging selesai untuk menjaga log Render tetap bersih
        // console.log('Foxy API Products Response Data:', JSON.stringify(response.data, null, 2));

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
            const basePrice = product.product_price;

            if (!gameName || !categoryName || !productName || !productCode || basePrice === undefined || basePrice === null) {
                 console.warn(`Produk Foxy dilewati karena data tidak lengkap:`, {
                     gameName, categoryName, productName, productCode, basePrice, originalProduct: product
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

            const sellingPrice = basePrice * (1 + (margin_percent / 100));

            const sql = `INSERT INTO products (game_id, category_id, name, provider_sku, price, status) 
                         VALUES ($1, $2, $3, $4, $5, $6) 
                         ON CONFLICT (provider_sku) DO UPDATE 
                         SET name = EXCLUDED.name, price = EXCLUDED.price, game_id = EXCLUDED.game_id, category_id = EXCLUDED.category_id, status = EXCLUDED.status`;
            await client.query(sql, [gameId, categoryId, productName, productCode, sellingPrice, 'Active']);
            productsSyncedCount++;
        }
        await client.query('COMMIT');
        console.log(`syncProductsWithFoxy job finished. Synced ${productsSyncedCount} products, added ${gamesAddedCount} new games.`);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('syncProductsWithFoxy job failed:', error.response ? error.response.data : error.message);
        throw error; // Re-throw to be caught by cron_job_script.js
    } finally {
        client.release();
    }
}

// ========================================================================
// === FUNGSI UTAMA CRON JOB (Memanggil Pengecek Transaksi DAN Sinkronisasi Produk) ===
// ========================================================================
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

// Export fungsi-fungsi agar bisa diakses oleh cron_job_script.js dan server.js
module.exports = { checkPendingTransactions, syncProductsWithFoxy, runAllCronJobs };