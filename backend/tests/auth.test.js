const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');

// Set port to a test port before requiring server
process.env.PORT = '3001';
process.env.JWT_SECRET = 'test-secret';

const { app, pool, server } = require('../server.js');

const baseUrl = `http://127.0.0.1:${process.env.PORT}/api/auth/login`;

describe('Auth Login Tests', () => {
    let originalQuery;
    let originalCompare;

    before(() => {
        // Mock pool.query and bcrypt.compare
        originalQuery = pool.query;
        originalCompare = bcrypt.compare;
    });

    after(() => {
        // Restore mocks and close server
        pool.query = originalQuery;
        bcrypt.compare = originalCompare;
        server.close();
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
