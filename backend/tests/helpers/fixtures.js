const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * Create a signed JWT for test users with customizable id, role, and username.
 */
function makeUserToken(id = 1, role = 'User', username = undefined) {
    const payload = { id, role };
    if (username !== undefined) {
        payload.username = username;
    }
    return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Create a signed JWT for an Admin test user.
 */
function makeAdminToken(id = 99, username = 'admin') {
    return jwt.sign({ id, username, role: 'Admin' }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

module.exports = {
    TEST_JWT_SECRET,
    makeUserToken,
    makeAdminToken
};
