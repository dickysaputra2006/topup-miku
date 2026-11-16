const { rollbackTransactionResources } = require('../services/refundService');
const {
    pool,
    safeAxiosError,
    safeErrorDetail,
    checkPendingTransactions,
} = require('../jobs/pendingTransactions');
const { syncProductsWithFoxy } = require('../jobs/productSync');

// ============================================================
// === FUNGSI UTAMA: JALANKAN SEMUA CRON JOBS ===
// Setiap job dibungkus try/catch agar satu gagal tidak hentikan yang lain.
// ============================================================
async function runAllCronJobs() {
    console.log('[cron] Starting all cron jobs...');
    const results = { pending: 'skipped', sync: 'skipped' };

    // Job 1: Cek pending transactions (kritis — selalu jalankan duluan)
    try {
        await checkPendingTransactions();
        results.pending = 'success';
    } catch (err) {
        results.pending = 'failed';
        console.error('[cron] checkPendingTransactions failed:', safeErrorDetail(err));
    }

    // Job 2: Sync produk (non-kritis — gagal tidak stop job lain)
    try {
        await syncProductsWithFoxy();
        results.sync = 'success';
    } catch (err) {
        results.sync = 'failed';
        // Tidak re-throw — cron exit 0 meski sync gagal
        const safeErr = safeAxiosError(err, 'Foxy');
        if (safeErr.isCloudflareChallenge) {
            console.warn('[cron] Product sync blocked by Cloudflare. Pending check still completed.');
        } else {
            console.error('[cron] syncProductsWithFoxy failed:', safeErrorDetail(err));
        }
    }

    console.log(`[cron] All jobs completed. Summary: pending=${results.pending}, sync=${results.sync}`);
    return results;
}

module.exports = {
    checkPendingTransactions,
    syncProductsWithFoxy,
    runAllCronJobs,
    rollbackTransactionResources,
    pool,
};
