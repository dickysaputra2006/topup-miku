const {
    PORT,
    validateEnvironment,
} = require('./config/env');
const { pool } = require('./config/db');
const { createApp } = require('./app');
const { invalidateFoxyProductCache } = require('./services/foxyClient');
const { callbackClock, clearCallbackCooldownCache } = require('./routes/foxyCallback.routes');

const app = createApp({ pool });

/**
 * Menjalankan HTTP server setelah validasi environment strict lolos.
 */
function startServer(port = PORT) {
    validateEnvironment({ strict: true });
    const startedServer = app.listen(port, () => {
        const address = startedServer.address();
        const actualPort = address && typeof address === 'object' ? address.port : port;
        console.log(`Server berjalan di port ${actualPort}`);
    });
    return startedServer;
}

let server = null;
if (require.main === module) {
    server = startServer();
}

// Re-export kompatibilitas sementara hingga seluruh impor tes/skrip diarahkan di Commit 2-3
module.exports = {
    app,
    pool,
    startServer,
    server,
    validateEnvironment,
    invalidateFoxyProductCache,
    callbackClock,
    clearCallbackCooldownCache,
};
