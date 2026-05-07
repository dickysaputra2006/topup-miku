const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');

// Use an ephemeral test port before requiring server.
process.env.PORT = '0';
process.env.JWT_SECRET = 'test-secret';

const { pool, startServer } = require('../server.js');

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
        pool.query = async () => ({ rows: [] });

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'unknownuser', password: 'password123' })
        });

        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.strictEqual(data.message, 'Username atau password salah.');

        pool.query = originalQuery;
    });

    test('should return 401 if password does not match', async () => {
        const mockUser = {
            id: 1,
            username: 'testuser',
            password: 'hashedpassword',
            role_name: 'BRONZE'
        };
        pool.query = async () => ({ rows: [mockUser] });
        bcrypt.compare = async () => false;

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', password: 'wrongpassword' })
        });

        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.strictEqual(data.message, 'Username atau password salah.');

        pool.query = originalQuery;
        bcrypt.compare = originalCompare;
    });

    test('should return 200 and token on successful login', async () => {
        const mockUser = {
            id: 1,
            username: 'testuser',
            password: 'hashedpassword',
            role_name: 'BRONZE'
        };
        pool.query = async () => ({ rows: [mockUser] });
        bcrypt.compare = async () => true;

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', password: 'correctpassword' })
        });

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.message, 'Login berhasil!');
        assert.ok(data.token, 'Token should be present in response');

        pool.query = originalQuery;
        bcrypt.compare = originalCompare;
    });

    test('should return 500 on database error', async () => {
        pool.query = async () => {
            throw new Error('Database connection failed');
        };

        const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'testuser', password: 'password123' })
        });

        assert.strictEqual(res.status, 500);
        const data = await res.json();
        assert.strictEqual(data.message, 'Terjadi kesalahan pada server.');

        pool.query = originalQuery;
    });
});
