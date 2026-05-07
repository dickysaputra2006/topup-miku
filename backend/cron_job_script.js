require('dotenv').config();
const fs = require('fs');
const { checkPendingTransactions, syncProductsWithFoxy } = require('./utils/cronUtils.js');

// ============================================================
// === KONFIGURASI ===
// ============================================================
const LOCK_FILE = '/tmp/topup-miku-cron.lock';
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 menit — anggap stale jika lebih lama
const GLOBAL_TIMEOUT_MS = 4 * 60 * 1000; // 4 menit batas total run

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
    return true;
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
            if (content === String(process.pid)) {
                fs.unlinkSync(LOCK_FILE);
            }
        }
    } catch (_) { /* tidak fatal */ }
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
const args = process.argv.slice(2);
const MODE_PENDING_ONLY = args.includes('--pending-only');
const MODE_SYNC_ONLY = args.includes('--sync-only');

// ============================================================
// === MAIN ===
// ============================================================
async function main() {
    const startTime = Date.now();
    console.log(`[cron] Run started at ${new Date().toISOString()} | mode: ${MODE_PENDING_ONLY ? 'pending-only' : MODE_SYNC_ONLY ? 'sync-only' : 'all'}`);

    // Acquire lock — jika gagal (proses lain aktif), exit 0 (bukan error)
    if (!acquireLock()) {
        process.exit(0);
    }

    const results = { pending: 'skipped', sync: 'skipped' };

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

        // Exit success jika setidaknya job yang dijadwalkan tidak crash fatal
        process.exit(0);

    } catch (fatalError) {
        console.error('[cron] Fatal unexpected error:', fatalError.message);
        process.exit(1);
    } finally {
        clearTimeout(globalTimeout);
        releaseLock();
    }
}

main();