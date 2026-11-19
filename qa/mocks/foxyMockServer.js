const http = require('http');
const path = require('path');

// Load dotenv from backend/.env strictly in memory for local DB product catalog & callback secret
require(path.resolve(__dirname, '../../backend/node_modules/dotenv')).config({
    path: path.resolve(__dirname, '../../backend/.env'),
});
const { Pool } = require(path.resolve(__dirname, '../../backend/node_modules/pg'));

const DEFAULT_FALLBACK_PRODUCTS = [
    { product_code: 'DUMMY-ML-5', product_name: '5 Diamonds', product_price: 1500 },
    { product_code: 'DUMMY-ML-12', product_name: '12 Diamonds', product_price: 3500 },
    { product_code: 'DUMMY-ML-86', product_name: '86 Diamonds', product_price: 19500 },
    { product_code: 'DUMMY-ML-172', product_name: '172 Diamonds', product_price: 38000 },
    { product_code: 'DUMMY-ML-257', product_name: '257 Diamonds', product_price: 57000 },
    { product_code: 'DUMMY-FF-5', product_name: '5 Diamonds', product_price: 900 },
    { product_code: 'DUMMY-FF-70', product_name: '70 Diamonds', product_price: 9500 },
    { product_code: 'DUMMY-FF-140', product_name: '140 Diamonds', product_price: 18500 },
    { product_code: 'DUMMY-FF-355', product_name: '355 Diamonds', product_price: 46000 },
    { product_code: 'DUMMY-GI-60', product_name: '60 Genesis Crystals', product_price: 14000 },
    { product_code: 'DUMMY-GI-300', product_name: '300+30 Genesis Crystals', product_price: 68000 },
    { product_code: 'DUMMY-GI-WELKIN', product_name: 'Blessing of the Welkin Moon', product_price: 68000 },
    { product_code: 'DUMMY-VAL-125', product_name: '125 Points', product_price: 14500 },
    { product_code: 'DUMMY-VAL-420', product_name: '420 Points', product_price: 47000 },
    { product_code: 'DUMMY-VAL-700', product_name: '700 Points', product_price: 76000 },
    { product_code: 'DUMMY-VAL-1375', product_name: '1375 Points', product_price: 145000 },
];

function readJsonBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve({ _raw: raw });
            }
        });
    });
}

async function loadProductsFromLocalDb() {
    const dbHost = String(process.env.DB_HOST || '').trim().toLowerCase();
    if (!['localhost', '127.0.0.1'].includes(dbHost)) {
        return DEFAULT_FALLBACK_PRODUCTS;
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: false,
    });
    try {
        const { rows } = await pool.query(
            "SELECT provider_sku, name, price FROM products WHERE provider_sku IS NOT NULL ORDER BY id ASC"
        );
        if (!rows || rows.length === 0) return DEFAULT_FALLBACK_PRODUCTS;
        return rows.map((r) => ({
            product_code: r.provider_sku,
            product_name: r.name,
            product_price: Number(r.price),
        }));
    } catch {
        return DEFAULT_FALLBACK_PRODUCTS;
    } finally {
        await pool.end().catch(() => {});
    }
}

function createFoxyMockState() {
    return {
        productsBehavior: 'ok',       // ok | empty | http500 | price_spike | custom
        orderBehavior: 'accept',      // accept | reject | http500 | timeout | invalid_json | slow_accept
        orderDelayMs: 0,
        defaultStatus: 'SUCCESS',     // SUCCESS | FAILED | REFUNDED | PENDING | PARTIAL_REFUND
        statusBehavior: 'ok',         // ok | http500 | http404 | incomplete | mismatch_sku | mismatch_trx
        autoCallbackDelayMs: null,    // if number >= 0, auto POST callback_url after delay
        customProducts: null,
        priceOverrides: {},           // { [sku]: number }
        ordersByTrx: {},              // { [trx_id]: { product_code, user_id, server_id, trx_id, callback_url } }
        statusOverrides: {},          // { [trx_id]: { status, sn, message, product_code, trx_id } }
        requests: [],
    };
}

function startFoxyMockServer({ port = Number(process.env.MOCK_FOXY_PORT || 4010), host = '127.0.0.1' } = {}) {
    const state = createFoxyMockState();

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://${host}:${port}`);
        const pathname = urlObj.pathname;
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};

        if (!pathname.startsWith('/__mock/')) {
            state.requests.push({
                method: req.method,
                path: pathname,
                body,
                hasAuthHeader: Boolean(req.headers.authorization),
                at: new Date().toISOString(),
            });
        }

        // === MOCK CONTROL ENDPOINTS ===
        if (pathname === '/__mock/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, service: 'foxy-mock', host, port }));
        }

        if (pathname === '/__mock/state' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                productsBehavior: state.productsBehavior,
                orderBehavior: state.orderBehavior,
                orderDelayMs: state.orderDelayMs,
                defaultStatus: state.defaultStatus,
                statusBehavior: state.statusBehavior,
                autoCallbackDelayMs: state.autoCallbackDelayMs,
                priceOverrides: state.priceOverrides,
                ordersCount: Object.keys(state.ordersByTrx).length,
                requestsCount: state.requests.length,
            }));
        }

        if (pathname === '/__mock/requests' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ requests: state.requests, ordersByTrx: state.ordersByTrx }));
        }

        if (pathname === '/__mock/reset' && req.method === 'POST') {
            Object.assign(state, createFoxyMockState());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, reset: true }));
        }

        if (pathname === '/__mock/mode' && req.method === 'POST') {
            const allowedKeys = [
                'productsBehavior', 'orderBehavior', 'orderDelayMs', 'defaultStatus',
                'statusBehavior', 'autoCallbackDelayMs', 'customProducts', 'priceOverrides', 'statusOverrides',
            ];
            for (const key of allowedKeys) {
                if (body[key] !== undefined) {
                    if (key === 'statusOverrides' && typeof body[key] === 'object' && body[key] !== null) {
                        state.statusOverrides = { ...state.statusOverrides, ...body[key] };
                    } else if (key === 'priceOverrides' && typeof body[key] === 'object' && body[key] !== null) {
                        state.priceOverrides = { ...state.priceOverrides, ...body[key] };
                    } else {
                        state[key] = body[key];
                    }
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }

        // === FOXY PROVIDER MOCK ENDPOINTS ===
        if (pathname === '/v1/products' && req.method === 'GET') {
            if (state.productsBehavior === 'http500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: false, message: 'Mock Foxy internal error' }));
            }
            if (state.productsBehavior === 'empty') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: true, data: [] }));
            }

            let products = Array.isArray(state.customProducts)
                ? state.customProducts
                : await loadProductsFromLocalDb();

            products = products.map((item) => {
                let price = Number(item.product_price);
                if (state.priceOverrides[item.product_code] !== undefined) {
                    price = Number(state.priceOverrides[item.product_code]);
                } else if (state.productsBehavior === 'price_spike') {
                    price = price * 5;
                }
                return { ...item, product_price: price };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: true, data: products }));
        }

        if (pathname === '/v1/order' && req.method === 'POST') {
            const trxId = body.trx_id ? String(body.trx_id) : `MOCK-TRX-${Date.now()}`;
            state.ordersByTrx[trxId] = {
                trx_id: trxId,
                product_code: body.product_code || null,
                user_id: body.user_id || null,
                server_id: body.server_id || '',
                callback_url: body.callback_url || null,
                created_at: new Date().toISOString(),
            };

            if (state.orderBehavior === 'timeout') {
                // Intentionally wait 18s (exceeds PROVIDER_TIMEOUT_MS=15000) unless socket closes
                const timer = setTimeout(() => {
                    if (!res.writableEnded) {
                        res.writeHead(504, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: false, message: 'Mock timeout' }));
                    }
                }, 18000);
                req.on('close', () => clearTimeout(timer));
                return;
            }

            const delay = Number(state.orderDelayMs || (state.orderBehavior === 'slow_accept' ? 250 : 0));
            if (delay > 0) {
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            if (state.orderBehavior === 'http500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: false, message: 'Mock Foxy HTTP 500' }));
            }
            if (state.orderBehavior === 'invalid_json') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<html>Just a moment... mock malformed response</html>');
            }
            if (state.orderBehavior === 'reject') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: false, message: 'Mock provider menolak pesanan.' }));
            }

            if (typeof state.autoCallbackDelayMs === 'number' && state.autoCallbackDelayMs >= 0 && body.callback_url) {
                const targetUrl = body.callback_url;
                setTimeout(() => {
                    const cbSecret = (process.env.FOXY_CALLBACK_SECRET || '').trim();
                    const payloadStr = JSON.stringify({ trx_id: trxId });
                    const target = new URL(targetUrl);
                    const cbReq = http.request({
                        hostname: target.hostname,
                        port: target.port || 80,
                        path: target.pathname + target.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(payloadStr),
                            ...(cbSecret ? { 'X-Callback-Token': cbSecret } : {}),
                        },
                    }, (cbRes) => cbRes.resume());
                    cbReq.on('error', () => {});
                    cbReq.write(payloadStr);
                    cbReq.end();
                }, state.autoCallbackDelayMs);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: true,
                message: 'Order mock diterima',
                data: { trx_id: trxId, status: 'PENDING' },
            }));
        }

        if (pathname.startsWith('/v1/status/') && req.method === 'GET') {
            const trxId = decodeURIComponent(pathname.slice('/v1/status/'.length));
            if (state.statusBehavior === 'http500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: false, message: 'Mock status error 500' }));
            }
            if (state.statusBehavior === 'http404') {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: false, message: 'Transaction not found' }));
            }
            if (state.statusBehavior === 'incomplete') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: true, data: {} }));
            }

            const stored = state.ordersByTrx[trxId] || {};
            const ov = state.statusOverrides[trxId] || {};
            let returnedTrxId = ov.trx_id || trxId;
            let returnedSku = ov.product_code || stored.product_code || null;

            if (state.statusBehavior === 'mismatch_trx') {
                returnedTrxId = `${trxId}-TAMPERED`;
            }
            if (state.statusBehavior === 'mismatch_sku') {
                returnedSku = 'WRONG-SKU-999';
            }

            const statusVal = ov.status || state.defaultStatus;
            const snVal = ov.sn !== undefined ? ov.sn : (statusVal === 'SUCCESS' ? `SN-MOCK-${trxId.slice(-8)}` : null);
            const msgVal = ov.message !== undefined ? ov.message : `Mock status ${statusVal}`;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                status: true,
                data: {
                    trx_id: returnedTrxId,
                    product_code: returnedSku,
                    status: statusVal,
                    sn: snVal,
                    message: msgVal,
                },
            }));
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: false, message: 'Mock endpoint not found' }));
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
            resolve({ server, state, url: `http://${host}:${port}` });
        });
    });
}

if (require.main === module) {
    startFoxyMockServer()
        .then(({ url }) => {
            console.log(`[foxy-mock] Running at ${url} (local mock only)`);
        })
        .catch((err) => {
            console.error('[foxy-mock] Failed to start:', err.message);
            process.exit(1);
        });
}

module.exports = { startFoxyMockServer, loadProductsFromLocalDb };
