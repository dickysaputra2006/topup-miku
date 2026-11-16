const { test, describe } = require('node:test');
const assert = require('node:assert');
const { timingSafeStringEqual } = require('../../utils/crypto');

describe('crypto Unit Tests: timingSafeStringEqual', () => {
    test('returns true for identical non-empty strings', () => {
        assert.strictEqual(timingSafeStringEqual('secret-token-123', 'secret-token-123'), true);
        assert.strictEqual(timingSafeStringEqual('kunci-utf8-✓', 'kunci-utf8-✓'), true);
    });

    test('returns false for equal-length strings with different content', () => {
        assert.strictEqual(timingSafeStringEqual('abcdef123456', 'abcdef123457'), false);
    });

    test('returns false for strings with different lengths', () => {
        assert.strictEqual(timingSafeStringEqual('short', 'longer-secret'), false);
        assert.strictEqual(timingSafeStringEqual('longer-secret', 'short'), false);
    });

    test('returns false for empty strings (matches active server.js behavior)', () => {
        assert.strictEqual(timingSafeStringEqual('', ''), false);
        assert.strictEqual(timingSafeStringEqual('', 'non-empty'), false);
        assert.strictEqual(timingSafeStringEqual('non-empty', ''), false);
    });

    test('returns false for non-string inputs', () => {
        assert.strictEqual(timingSafeStringEqual(null, null), false);
        assert.strictEqual(timingSafeStringEqual(undefined, 'abc'), false);
        assert.strictEqual(timingSafeStringEqual(12345, '12345'), false);
        assert.strictEqual(timingSafeStringEqual({}, {}), false);
        assert.strictEqual(timingSafeStringEqual(Buffer.from('abc'), Buffer.from('abc')), false);
    });
});
