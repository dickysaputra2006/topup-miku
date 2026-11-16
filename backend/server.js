const {
    PORT,
    validateEnvironment,
} = require('./config/env');
const { pool } = require('./config/db');
const { createApp } = require('./app');

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

if (require.main === module) {
    startServer();
}

module.exports = { startServer };
