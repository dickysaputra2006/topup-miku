// utils/cronUtils.js
const { Pool } = require('pg'); // Import Pool untuk koneksi database
const axios = require('axios'); // Untuk panggilan API Foxy

// --- KONFIGURASI DATABASE UNTUK CRON JOB ---
// Ini harus sama dengan dbConfig di server.js Anda.
// Pastikan Environment Variables ini diatur di layanan Cron Job Render juga.
const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
};

const pool = new Pool(dbConfig); // Buat pool koneksi baru untuk cron job

// --- KONFIGURASI FOXY API UNTUK CRON JOB ---
// Ini harus sama dengan konfigurasi di server.js Anda.
// Pastikan Environment Variable FOXY_API_KEY ini diatur di layanan Cron Job Render juga.
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY; // Dapatkan dari Environment Variable

// Fungsi utama untuk memeriksa transaksi pending
async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    const client = await pool.connect(); // Dapatkan koneksi dari pool
    try {
        await client.query('BEGIN'); // Mulai transaksi database

        // 1. Ambil semua transaksi dengan status 'Pending'
        // Gunakan FOR UPDATE untuk mengunci baris agar tidak diproses oleh proses lain secara bersamaan
        const { rows: pendingTx } = await client.query(
            `SELECT id, invoice_id, user_id, product_id, price, provider_trx_id FROM transactions WHERE status = 'Pending' FOR UPDATE`
        );

        if (pendingTx.length === 0) {
            console.log('No pending transactions found.');
            await client.query('COMMIT'); // Commit transaksi meskipun tidak ada yang perlu diupdate
            return;
        }

        console.log(`Found ${pendingTx.length} pending transactions. Checking status with Foxy API...`);

        for (const tx of pendingTx) {
            try {
                // Panggil Foxy API untuk mendapatkan status transaksi
                const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, {
                    headers: { 'Authorization': FOXY_API_KEY }
                });

                const foxyStatus = foxyResponse.data.data.status; // Asumsi status ada di response.data.data.status
                const foxyMessage = foxyResponse.data.message || 'No specific message from provider.';

                console.log(`Transaction ${tx.invoice_id} (Provider ID: ${tx.provider_trx_id}) - Foxy Status: ${foxyStatus}`);

                if (foxyStatus === 'SUCCESS') {
                    // Update status transaksi menjadi Sukses
                    await client.query('UPDATE transactions SET status = \'Success\', updated_at = NOW() WHERE id = $1', [tx.id]);
                    console.log(`Transaction ${tx.invoice_id} updated to SUCCESS.`);
                } else if (foxyStatus === 'FAILED' || foxyStatus === 'REFUNDED') {
                    // Update status menjadi Gagal/Refund dan kembalikan saldo
                    await client.query('UPDATE transactions SET status = \'Failed\', updated_at = NOW() WHERE id = $1', [tx.id]);
                    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                    // Catat di riwayat saldo
                    const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} (Gagal/Refund dari provider): ${foxyMessage}`;
                    await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                        [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
                    console.log(`Transaction ${tx.invoice_id} updated to FAILED/REFUNDED and balance refunded.`);
                }
                // Jika statusnya masih 'PENDING' dari Foxy, biarkan saja di database Anda, cron job akan cek lagi nanti.

            } catch (foxyError) {
                console.error(`Error checking Foxy status for ${tx.invoice_id}:`, foxyError.response ? foxyError.response.data : foxyError.message);
                // Penting: Jangan ROLLBACK di sini, hanya log error Foxy API.
                // Transaksi DB keseluruhan hanya akan di-rollback jika ada error DB.
            }
        }

        await client.query('COMMIT'); // Commit semua update transaksi yang berhasil
        console.log('checkPendingTransactions job finished.');

    } catch (dbError) {
        await client.query('ROLLBACK'); // Rollback seluruh transaksi jika ada error database
        console.error('Database error during checkPendingTransactions job:', dbError);
    } finally {
        client.release(); // Selalu kembalikan koneksi ke pool
    }
}

// Export fungsi agar bisa diakses oleh cron_job_script.js
module.exports = { checkPendingTransactions };