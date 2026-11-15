const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');

// Use an ephemeral test port before requiring server.
process.env.PORT = '0';
process.env.JWT_SECRET = 'test-secret';

const { pool, startServer } = require('../helpers/appFactory');

let baseUrl;

describe('Auth Login Tests', () => {
    let originalQuery;
    let originalCompare;
    let server;

    before(() => {
        server = startServer(0);
        baseUrl = `http://127.0.0.1:${server.address().port}/api/auth/login`;
        // Mock pool.query and bcrypt.compare
        originalQuery = pool.query;
        originalCompare = bcrypt.compare;
    });

    after(async () => {
        // Restore mocks and close server
        pool.query = originalQuery;
        bcrypt.compare = originalCompare;
        await new Promise(resolve => server.close(resolve));
    });

    test('should return 400 if username or password is missing', async () => {
        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser' }) // missing password
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.strictEqual(data.message, 'Input tidak boleh kosong.');
    });

    test('should return 401 if user is not found', async () => {
        mock.method(pool, 'query', async () => ({ rows: [] }));

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'unknownuser', password: 'password123' })
        });

        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.strictEqual(data.message, 'Username atau password salah.');

        // Restore mock
        pool.query.mock.restore();
    });

    test('should return 401 if password does not match', async () => {
        const mockUser = {
            id: 1,
            username: 'testuser',
            password: 'hashedpassword',
            role_name: 'BRONZE'
        };
        mock.method(pool, 'query', async () => ({ rows: [mockUser] }));
        mock.method(bcrypt, 'compare', async () => false); // Password doesn't match

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', password: 'wrongpassword' })
        });

        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.strictEqual(data.message, 'Username atau password salah.');

        // Restore mocks
        pool.query.mock.restore();
        bcrypt.compare.mock.restore();
    });

    test('should return 200 and token on successful login', async () => {
        const mockUser = {
            id: 1,
            username: 'testuser',
            password: 'hashedpassword',
            role_name: 'BRONZE'
        };
        mock.method(pool, 'query', async () => ({ rows: [mockUser] }));
        mock.method(bcrypt, 'compare', async () => true); // Password matches

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', password: 'correctpassword' })
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.message, 'Login berhasil!');
        assert.ok(data.token, 'Token should be present in response');

        // Restore mocks
        pool.query.mock.restore();
        bcrypt.compare.mock.restore();
    });

    test('should return 500 on database error', async () => {
        mock.method(pool, 'query', async () => {
            throw new Error('Database connection failed');
        });

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', password: 'password123' })
        });

        assert.strictEqual(res.status, 500);
        const data = await res.json();
        assert.strictEqual(data.message, 'Terjadi kesalahan pada server.');

        // Restore mock
        pool.query.mock.restore();
    });
});

// =========================================================
// Phase 2B: Register Safety Tests
// =========================================================
describe('Auth Register Tests (Phase 2B)', () => {
    let server;
    let registerUrl;

    before(() => {
        server = startServer(0);
        registerUrl = `http://127.0.0.1:${server.address().port}/api/auth/register`;
    });

    after(async () => {
        pool.query = pool.query; // no-op restore
        await new Promise(resolve => server.close(resolve));
    });

    test('should return 400 if any required field is missing', async () => {
        const res = await fetch(registerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', email: 'test@test.com' })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.ok(data.message, 'Should return a message');
    });

    test('should return 400 for invalid countryCode format', async () => {
        const res = await fetch(registerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Test User',
                username: 'testuser2b',
                email: 'test2b@test.com',
                countryCode: 'ABC', // invalid
                nomorWa: '81234567890',
                password: 'password123'
            })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.match(data.message, /kode negara/i);
    });

    test('should return 400 for invalid local phone number (too short)', async () => {
        const res = await fetch(registerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Test User',
                username: 'testuser2b',
                email: 'test2b@test.com',
                countryCode: '+62',
                nomorWa: '123', // too short
                password: 'password123'
            })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.match(data.message, /tidak valid/i);
    });

    test('should return 400 for phone with non-digit chars', async () => {
        const res = await fetch(registerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Test User',
                username: 'testuser2b',
                email: 'test2b@test.com',
                countryCode: '+62',
                nomorWa: '8abc12345', // has letters
                password: 'password123'
            })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.match(data.message, /tidak valid/i);
    });

    test('should return 409 when nomor_wa is already registered', async () => {
        // Mock dupCheck returning a row with same nomor_wa
        const mockedPhone = '+6281234567890';
        mock.method(pool, 'query', async (sql, params) => {
            // dupCheck query
            if (typeof sql === 'string' && sql.includes('WHERE username') && sql.includes('nomor_wa')) {
                return { rows: [{ username: 'other_user', email: 'other@email.com', nomor_wa: mockedPhone }] };
            }
            return { rows: [] };
        });

        const res = await fetch(registerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Test User',
                username: 'uniqueuser123',
                email: 'unique123@test.com',
                countryCode: '+62',
                nomorWa: '81234567890', // normalizes to +6281234567890
                password: 'password123'
            })
        });

        pool.query.mock.restore();

        assert.strictEqual(res.status, 409);
        const data = await res.json();
        assert.match(data.message, /whatsapp/i);
    });
});
