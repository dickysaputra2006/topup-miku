const path = require('path');
const http = require('http');
const crypto = require('crypto');

require(path.resolve(__dirname, '../../../backend/node_modules/dotenv')).config({
    path: path.resolve(__dirname, '../../../backend/.env'),
});
const { Pool } = require(path.resolve(__dirname, '../../../backend/node_modules/pg'));
const bcrypt = require(path.resolve(__dirname, '../../../backend/node_modules/bcryptjs'));
const jwt = require(path.resolve(__dirname, '../../../backend/node_modules/jsonwebtoken'));

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000';
const MOCK_URL = process.env.FOXY_BASE_URL || 'http://127.0.0.1:4010';
const QA_PASSWORD = process.env.SEED_QA_PASSWORD || 'MikuQaLocal#2026';

function assertLocalSafety() {
    const dbHost = String(process.env.DB_HOST || '').trim().toLowerCase();
    const dbName = String(process.env.DB_NAME || '').trim();
    if (process.env.NODE_ENV === 'production') {
        throw new Error('QA tests refused: NODE_ENV=production');
    }
    if (!['localhost', '127.0.0.1'].includes(dbHost)) {
        throw new Error(`QA tests refused: DB_HOST="${dbHost}" is not local`);
    }
    if (!/(dev|local|test)/i.test(dbName)) {
        throw new Error(`QA tests refused: DB_NAME="${dbName}" does not look local/test`);
    }
    if (!MOCK_URL.startsWith('http://127.0.0.1') && !MOCK_URL.startsWith('http://localhost')) {
        throw new Error(`QA tests refused: FOXY_BASE_URL="${MOCK_URL}" is not local mock`);
    }
}

function createQaPool() {
    assertLocalSafety();
    return new Pool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: false,
    });
}

async function mockControl(method, endpoint, body) {
    const res = await fetch(`${MOCK_URL}${endpoint}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

async function resetFoxyMock() {
    return mockControl('POST', '/__mock/reset');
}

async function setFoxyMockMode(patch) {
    return mockControl('POST', '/__mock/mode', patch);
}

async function getFoxyMockRequests() {
    return mockControl('GET', '/__mock/requests');
}

async function apiRequest(method, routePath, { token, apiKey, headers = {}, body } = {}) {
    const reqHeaders = { ...headers };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    if (apiKey) reqHeaders['X-API-Key'] = apiKey;
    if (body !== undefined && !reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${BASE_URL}${routePath}`, {
        method,
        headers: reqHeaders,
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text or HTML */ }
    return { status: res.status, headers: res.headers, text, json };
}

function issueQaToken({ id, username, roleName }) {
    return jwt.sign({ id, username, role: roleName }, process.env.JWT_SECRET, { expiresIn: '1d' });
}

async function getSeededUserToken(pool, username) {
    const { rows } = await pool.query(
        'SELECT u.id, u.username, r.name AS role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = $1 LIMIT 1',
        [username]
    );
    if (rows.length === 0) throw new Error(`Seeded user not found: ${username}`);
    return issueQaToken({ id: rows[0].id, username: rows[0].username, roleName: rows[0].role_name });
}

async function loginUser(username, password = QA_PASSWORD) {
    const res = await apiRequest('POST', '/api/auth/login', {
        body: { username, password },
    });
    if (res.status !== 200 || !res.json || !res.json.token) {
        throw new Error(`Login failed for ${username}: status=${res.status}`);
    }
    return res.json.token;
}

async function createIsolatedUser(pool, {
    prefix = 'QATEST',
    roleName = 'BRONZE',
    balance = 100000,
    withApiKey = false,
    whitelistedIps = [],
} = {}) {
    const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const username = `${prefix}_${suffix}`.slice(0, 60);
    const email = `${username.toLowerCase()}@qa.local.test`;
    const phoneSuffix = String(Math.floor(10000000 + Math.random() * 89999999));
    const nomorWa = `+6289${phoneSuffix}`;
    const hash = await bcrypt.hash(QA_PASSWORD, 10);

    const roleRes = await pool.query('SELECT id FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1', [roleName]);
    if (roleRes.rows.length === 0) {
        throw new Error(`Role not found: ${roleName}`);
    }
    const roleId = roleRes.rows[0].id;

    let apiKeyPlain = null;
    let apiKeyHash = null;
    let apiKeyPrefix = null;
    let webhookSecret = null;
    if (withApiKey) {
        apiKeyPlain = crypto.randomBytes(32).toString('hex');
        apiKeyHash = crypto.createHash('sha256').update(apiKeyPlain).digest('hex');
        apiKeyPrefix = apiKeyPlain.slice(0, 8);
        webhookSecret = crypto.randomBytes(32).toString('hex');
    }

    const { rows } = await pool.query(
        `INSERT INTO users (full_name, username, email, nomor_wa, password, role_id, balance, api_key_hash, api_key_prefix, h2h_webhook_secret, whitelisted_ips)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, username, email, balance`,
        [
            `QA ${username}`,
            username,
            email,
            nomorWa,
            hash,
            roleId,
            balance,
            apiKeyHash,
            apiKeyPrefix,
            webhookSecret,
            whitelistedIps,
        ]
    );
    return {
        ...rows[0],
        roleName,
        password: QA_PASSWORD,
        apiKeyPlain,
        webhookSecret,
    };
}

async function cleanupIsolatedUser(pool, userId) {
    if (!userId) return;
    await pool.query('DELETE FROM admin_audit_logs WHERE admin_id = $1 OR (target_type = $2 AND target_id = $3)', [userId, 'user', String(userId)]).catch(() => {});
    await pool.query('DELETE FROM password_resets WHERE email IN (SELECT email FROM users WHERE id = $1)', [userId]).catch(() => {});
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM promo_usages WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM balance_history WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM deposits WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

async function sendLocalCallback({ trxId, token = (process.env.FOXY_CALLBACK_SECRET || '').trim(), placement = 'header', extraBody = {} }) {
    const url = new URL(`${BASE_URL}/api/foxy/callback`);
    const headers = { 'Content-Type': 'application/json' };
    if (placement === 'header' && token) headers['X-Callback-Token'] = token;
    if (placement === 'query' && token) url.searchParams.set('token', token);
    const res = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ trx_id: trxId, ...extraBody }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, text, json };
}

function getCallbackSecret() {
    return (process.env.FOXY_CALLBACK_SECRET || '').trim();
}

module.exports = {
    BASE_URL,
    MOCK_URL,
    QA_PASSWORD,
    createQaPool,
    resetFoxyMock,
    setFoxyMockMode,
    getFoxyMockRequests,
    apiRequest,
    issueQaToken,
    getSeededUserToken,
    loginUser,
    createIsolatedUser,
    cleanupIsolatedUser,
    sendLocalCallback,
    getCallbackSecret,
};
