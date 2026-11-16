require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rollbackTransactionResources } = require('../services/refundService');
const {
    pool,
    safeAxiosError,
    safeErrorDetail,
    checkPendingTransactions,
} = require('./pendingTransactions');
const { syncProductsWithFoxy } = require('./productSync');

// ============================================================
// === KONFIGURASI ===
// ============================================================
const LOCK_FILE = path.join(os.tmpdir(), 'topup-miku-cron.lock');
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 menit — anggap stale jika lebih lama
const GLOBAL_TIMEOUT_MS = 4 * 60 * 1000; // 4 menit batas total run

// Track apakah lock berhasil di-acquire oleh proses ini
let lockAcquired = false;

// ============================================================
// === OVERLAP PREVENTION — LOCK FILE ===
// ============================================================
function acquireLock() {
    if (fs.existsSync(LOCK_FILE)) {
        let lockAge = Infinity;
        try {
            lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        } catch (_) { /* file mungkin dihapus race */ }

        if (lockAge < LOCK_STALE_MS) {
            console.warn(`[cron] Lock file exists and is fresh (age: ${Math.round(lockAge / 1000)}s). Exiting to prevent overlap.`);
            return false;
        }
        // Lock kadaluarsa — proses sebelumnya mungkin crash
        console.warn(`[cron] Stale lock file detected (age: ${Math.round(lockAge / 1000)}s). Removing and proceeding.`);
    }

    try {
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'w' });
    } catch (err) {
        console.error('[cron] Failed to write lock file:', err.message);
        return false;
    }
    lockAcquired = true;
    return true;
}

/**
 * Hapus lock file — hanya jika milik PID kita.
 * Aman dipanggil berkali-kali (idempotent).
 */
function releaseLock() {
    if (!lockAcquired) return;
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
            if (content === String(process.pid)) {
                fs.unlinkSync(LOCK_FILE);
            }
        }
    } catch (err) {
        console.warn('[cron] Failed to remove lock file:', err.message);
    }
    lockAcquired = false;
}

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

// ============================================================
// === CLI RUNNER (kompatibel dengan cron_job_script.js) ===
// ============================================================
function runCronCli(argv = process.argv.slice(2)) {
    // ============================================================
    // === SAFETY NET — pastikan lock selalu dihapus ===
    // ============================================================
    // process.on('exit') berjalan saat event loop habis atau setelah
    // process.exit() dipanggil — sebagai jaring pengaman terakhir.
    process.on('exit', () => {
        releaseLock();
    });

    // Tangkap signal agar cleanup jalan sebelum OS kill proses
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            console.warn(`[cron] Received ${sig}, cleaning up...`);
            releaseLock();
            process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
        });
    }

    // ============================================================
    // === GLOBAL TIMEOUT — cron tidak boleh hang selamanya ===
    // ============================================================
    const globalTimeout = setTimeout(() => {
        console.error(`[cron] TIMEOUT: Cron exceeded ${GLOBAL_TIMEOUT_MS / 1000}s. Forcing exit.`);
        releaseLock();
        process.exit(1);
    }, GLOBAL_TIMEOUT_MS);
    // Jangan tahan event loop hanya karena timeout ini
    globalTimeout.unref();

    // ============================================================
    // === MODE ARGUMEN ===
    // Gunakan untuk memisahkan schedule di crontab:
    //   --pending-only  → hanya checkPendingTransactions
    //   --sync-only     → hanya syncProductsWithFoxy
    //   (tanpa arg)     → jalankan keduanya (untuk manual run / testing)
    // ============================================================
    const MODE_PENDING_ONLY = argv.includes('--pending-only');
    const MODE_SYNC_ONLY = argv.includes('--sync-only');

    async function main() {
        const startTime = Date.now();
        console.log(`[cron] Run started at ${new Date().toISOString()} | mode: ${MODE_PENDING_ONLY ? 'pending-only' : MODE_SYNC_ONLY ? 'sync-only' : 'all'}`);

        // Acquire lock — jika gagal (proses lain aktif), exit 0 (bukan error)
        if (!acquireLock()) {
            process.exit(0);
        }

        const results = { pending: 'skipped', sync: 'skipped' };
        let exitCode = 0;

        try {
            if (MODE_SYNC_ONLY) {
                // Hanya sync produk
                try {
                    await syncProductsWithFoxy();
                    results.sync = 'success';
                } catch (err) {
                    results.sync = 'failed';
                    // Error sudah di-log di dalam syncProductsWithFoxy
                }
            } else if (MODE_PENDING_ONLY) {
                // Hanya cek pending transaction
                try {
                    await checkPendingTransactions();
                    results.pending = 'success';
                } catch (err) {
                    results.pending = 'failed';
                    console.error('[cron] checkPendingTransactions failed:', err.message);
                }
            } else {
                // Jalankan keduanya (manual / no-arg)
                try {
                    await checkPendingTransactions();
                    results.pending = 'success';
                } catch (err) {
                    results.pending = 'failed';
                    console.error('[cron] checkPendingTransactions failed:', err.message);
                }

                try {
                    await syncProductsWithFoxy();
                    results.sync = 'success';
                } catch (err) {
                    results.sync = 'failed';
                    // Error sudah di-log di dalam syncProductsWithFoxy
                }
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[cron] Finished at ${new Date().toISOString()} | elapsed: ${elapsed}s | pending=${results.pending}, sync=${results.sync}`);

        } catch (fatalError) {
            console.error('[cron] Fatal unexpected error:', fatalError.message);
            exitCode = 1;
        } finally {
            clearTimeout(globalTimeout);
            releaseLock();
            process.exit(exitCode);
        }
    }

    return main();
}

if (require.main === module) {
    runCronCli();
}

module.exports = {
    LOCK_FILE,
    LOCK_STALE_MS,
    GLOBAL_TIMEOUT_MS,
    acquireLock,
    releaseLock,
    runAllCronJobs,
    runCronCli,
    checkPendingTransactions,
    syncProductsWithFoxy,
    rollbackTransactionResources,
    pool,
};
