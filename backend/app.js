const path = require('path');
const express = require('express');
const { MAX_BODY_SIZE } = require('./config/constants');
const { pool: defaultPool } = require('./config/db');
const { securityHeaders, corsMiddleware } = require('./middleware/securityHeaders');
const { createRateLimiters } = require('./middleware/rateLimiters');
const { createAuthMiddleware } = require('./middleware/auth');
const { createH2HAuthMiddleware } = require('./middleware/h2hAuth');
const { requireWaBotAdminToken } = require('./middleware/waBotAuth');
const { rollbackTransactionResources } = require('./services/refundService');
const { createNotificationService } = require('./services/notificationService');
const createAuthRoutes = require('./routes/auth.routes');
const createDepositRoutes = require('./routes/deposit.routes');
const createOrderRoutes = require('./routes/order.routes');
const createH2HRoutes = require('./routes/h2h.routes');
const createFoxyCallbackRoutes = require('./routes/foxyCallback.routes');
const createPublicRoutes = require('./routes/public.routes');
const createCatalogRoutes = require('./routes/catalog.routes');
const createUserRoutes = require('./routes/user.routes');
const createUserApiKeyRoutes = require('./routes/userApiKey.routes');
const createWaBotRoutes = require('./routes/waBot.routes');
const createAdminDepositsRoutes = require('./routes/admin/deposits.routes');
const createAdminBalanceRoutes = require('./routes/admin/balance.routes');
const createAdminTransactionsRoutes = require('./routes/admin/transactions.routes');
const createAdminPaymentMethodsRoutes = require('./routes/admin/paymentMethods.routes');
const createAdminGamesRoutes = require('./routes/admin/games.routes');
const createAdminProductsRoutes = require('./routes/admin/products.routes');
const createAdminPromosRoutes = require('./routes/admin/promos.routes');
const createAdminFlashSalesRoutes = require('./routes/admin/flashSales.routes');
const createAdminMarginsRoutes = require('./routes/admin/margins.routes');

/**
 * Merakit instance Express beserta seluruh middleware global, limiter, dan 19 grup router
 * dalam urutan identik dengan konfigurasi aplikasi asli.
 */
function createApp({ pool = defaultPool } = {}) {
    const app = express();
    app.set('trust proxy', 1); // untuk mendapatkan IP asli di belakang proxy

    // Middleware (HARUS DI ATAS SEMUA RUTE)
    app.use(securityHeaders);
    app.use(corsMiddleware);
    app.use(express.json({ limit: MAX_BODY_SIZE }));
    const frontendPath = path.join(__dirname, '../frontend');
    app.use(express.static(frontendPath));

    app.use(createPublicRoutes({ pool }));

    const { h2hUserLimiter, applyRateLimiters } = createRateLimiters();
    applyRateLimiters(app);

    // === AUTH ENDPOINTS ===
    app.use(createAuthRoutes({ pool }));

    // === MIDDLEWARE ===
    const { protect, protectAdmin, softProtect } = createAuthMiddleware({ pool });
    const { protectH2H, protectH2HIp } = createH2HAuthMiddleware({ pool });
    const createNotification = createNotificationService({ pool });

    // === USER ENDPOINTS ===
    app.use(createUserRoutes({ pool, protect }));
    app.use(createUserApiKeyRoutes({ pool, protect }));

    // === DEPOSIT & PAYMENT METHOD ENDPOINTS ===
    app.use(createDepositRoutes({ pool, protect }));

    // === ADMIN ENDPOINTS ===
    app.use(createAdminDepositsRoutes({ pool, protectAdmin, createNotification }));
    app.use(createAdminPaymentMethodsRoutes({ pool, protectAdmin }));

    app.use(createAdminBalanceRoutes({ pool, protectAdmin }));
    app.use(createAdminGamesRoutes({ pool, protectAdmin }));
    app.use(createAdminProductsRoutes({ pool, protectAdmin }));

    app.use(createAdminTransactionsRoutes({
        pool,
        protectAdmin,
        createNotification,
        rollbackTransactionResources,
    }));
    app.use(createAdminPromosRoutes({ pool, protectAdmin }));
    app.use(createAdminFlashSalesRoutes({ pool, protectAdmin }));
    app.use(createAdminMarginsRoutes({ pool, protectAdmin }));

    // === PUBLIC ENDPOINTS ===
    app.use(createCatalogRoutes({ pool, protect, softProtect }));

    // === WA BOT ADMIN DEPOSITS ENDPOINTS ===
    app.use(createWaBotRoutes({ pool, createNotification, requireWaBotAdminToken }));

    // === ORDER & H2H ENDPOINTS ===
    app.use(createOrderRoutes({ pool, protect }));
    app.use(createFoxyCallbackRoutes({ pool, createNotification }));

    app.use(createH2HRoutes({
        pool,
        protectH2HIp,
        protectH2H,
        h2hUserLimiter,
    }));

    return app;
}

module.exports = { createApp };
