const express = require('express');
const { logSafeError } = require('../../utils/logger');
const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

/**
 * Daftarkan route admin untuk manajemen saldo manual (add/reduce).
 */
module.exports = function createAdminBalanceRoutes(deps) {
    const {
        pool,
        protectAdmin,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAdminBalanceRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminBalanceRoutes requires a protectAdmin middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminBalanceRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    router.post('/api/admin/balance/add', protectAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { username, amount, description } = req.body;
            if (!username || !amount || !description || isNaN(amount) || amount <= 0) throw new Error('Input tidak valid.');
            const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
            if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
            const user = rows[0];
            const addedAmount = parseInt(amount);
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [addedAmount, user.id]);
            const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
            await client.query(historySql, [user.id, addedAmount, 'Deposit', description, `ADMIN_ADD-${Date.now()}`]);
            await client.query('COMMIT');
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.balance.add',
                targetType: 'user_balance',
                targetId: String(user.id),
                beforeData: { balance: Number(user.balance) },
                afterData: {
                    username: String(username),
                    amount: addedAmount,
                    balance: Number(user.balance) + addedAmount,
                    description: String(description),
                },
            });
            res.json({ message: `Saldo sebesar ${amount} berhasil ditambahkan ke akun ${username}.` });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('Error adding balance manually:', error);
            res.status(500).json({ message: 'Gagal menambah saldo.' });
        } finally {
            client.release();
        }
    });

    router.post('/api/admin/balance/reduce', protectAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { username, amount, description } = req.body;
            const numericAmount = Number(amount);
            if (!username || !description || !Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error('Input tidak valid.');
            const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
            if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
            const user = rows[0];
            if (Number(user.balance) < numericAmount) throw new Error('Saldo pengguna tidak mencukupi untuk dikurangi.');
            await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1', [numericAmount, user.id]);
            const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
            await client.query(historySql, [user.id, -numericAmount, 'Refund', description, `ADMIN_REDUCE-${Date.now()}`]);
            await client.query('COMMIT');
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.balance.reduce',
                targetType: 'user_balance',
                targetId: String(user.id),
                beforeData: { balance: Number(user.balance) },
                afterData: {
                    username: String(username),
                    amount: numericAmount,
                    balance: Number(user.balance) - numericAmount,
                    description: String(description),
                },
            });
            res.json({ message: `Saldo akun ${username} berhasil dikurangi sebesar ${numericAmount}.` });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('Error reducing balance manually:', error);
            res.status(500).json({ message: 'Gagal mengurangi saldo.' });
        } finally {
            client.release();
        }
    });

    return router;
};
