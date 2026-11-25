const express = require('express');
const { logSafeError } = require('../../utils/logger');
const {
    getBodyObject,
    requireString,
    requirePositiveInt,
} = require('../../utils/schemaValidators');
const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');
const {
    extractTargetIdentifier,
    lookupUserByIdentifier,
    updateUserRoleAtomic,
} = require('../../services/adminUserOpsService');

function validateBalanceAdjustmentPayload(req) {
    const bodyRes = getBodyObject(req);
    if (bodyRes.error) return { error: bodyRes.error };
    const body = bodyRes.value;

    const usernameRes = requireString(body.username, 'Username', { min: 1, max: 255 });
    if (usernameRes.error) return { error: usernameRes.error };

    const amountRes = requirePositiveInt(body.amount, 'Jumlah saldo', { min: 1, max: 100000000 });
    if (amountRes.error) return { error: amountRes.error };

    const descriptionRes = requireString(body.description, 'Deskripsi', { min: 1, max: 255 });
    if (descriptionRes.error) return { error: descriptionRes.error };

    return {
        value: {
            username: usernameRes.value,
            amount: amountRes.value,
            description: descriptionRes.value,
        },
    };
}

/**
 * Daftarkan route admin untuk manajemen saldo manual (add/reduce).
 */
module.exports = function createAdminBalanceRoutes(deps) {
    const {
        pool,
        protectAdmin,
        createNotification = async () => {},
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
        const parsed = validateBalanceAdjustmentPayload(req);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        const { username, amount: addedAmount, description } = parsed.value;

        const client = await pool.connect();
        let inTx = false;
        try {
            await client.query('BEGIN');
            inTx = true;
            const { rows } = await client.query(
                'SELECT id, balance FROM users WHERE username = $1 OR LOWER(email) = LOWER($2) FOR UPDATE',
                [username, username]
            );
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                inTx = false;
                return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
            }
            const user = rows[0];
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [addedAmount, user.id]);
            const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
            await client.query(historySql, [user.id, addedAmount, 'Deposit', description, `ADMIN_ADD-${Date.now()}`]);
            await client.query('COMMIT');
            inTx = false;
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.balance.add',
                targetType: 'user_balance',
                targetId: String(user.id),
                beforeData: { balance: Number(user.balance) },
                afterData: {
                    username,
                    amount: addedAmount,
                    balance: Number(user.balance) + addedAmount,
                    description,
                },
            });
            res.json({ message: `Saldo sebesar ${addedAmount} berhasil ditambahkan ke akun ${username}.` });
        } catch (error) {
            if (inTx) await client.query('ROLLBACK').catch(() => {});
            logSafeError('Error adding balance manually:', error);
            res.status(500).json({ message: 'Gagal menambah saldo.' });
        } finally {
            client.release();
        }
    });

    router.post('/api/admin/balance/reduce', protectAdmin, async (req, res) => {
        const parsed = validateBalanceAdjustmentPayload(req);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        const { username, amount: numericAmount, description } = parsed.value;

        const client = await pool.connect();
        let inTx = false;
        try {
            await client.query('BEGIN');
            inTx = true;
            const { rows } = await client.query(
                'SELECT id, balance FROM users WHERE username = $1 OR LOWER(email) = LOWER($2) FOR UPDATE',
                [username, username]
            );
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                inTx = false;
                return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
            }
            const user = rows[0];
            if (Number(user.balance) < numericAmount) {
                await client.query('ROLLBACK');
                inTx = false;
                return res.status(400).json({ message: 'Saldo pengguna tidak mencukupi untuk dikurangi.' });
            }
            await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1', [numericAmount, user.id]);
            const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
            await client.query(historySql, [user.id, -numericAmount, 'Refund', description, `ADMIN_REDUCE-${Date.now()}`]);
            await client.query('COMMIT');
            inTx = false;
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.balance.reduce',
                targetType: 'user_balance',
                targetId: String(user.id),
                beforeData: { balance: Number(user.balance) },
                afterData: {
                    username,
                    amount: numericAmount,
                    balance: Number(user.balance) - numericAmount,
                    description,
                },
            });
            res.json({ message: `Saldo akun ${username} berhasil dikurangi sebesar ${numericAmount}.` });
        } catch (error) {
            if (inTx) await client.query('ROLLBACK').catch(() => {});
            logSafeError('Error reducing balance manually:', error);
            res.status(500).json({ message: 'Gagal mengurangi saldo.' });
        } finally {
            client.release();
        }
    });

    router.get('/api/admin/users/lookup', protectAdmin, async (req, res) => {
        try {
            const result = await lookupUserByIdentifier({ pool, identifier: req.query ? req.query.q : '' });
            if (result.error) return res.status(result.statusCode).json({ message: result.error });
            return res.json({ user: result.user });
        } catch (error) {
            logSafeError('Error looking up user:', error);
            return res.status(500).json({ message: 'Gagal mencari data pengguna.' });
        }
    });

    router.put('/api/admin/users/role', protectAdmin, async (req, res) => {
        const bodyRes = getBodyObject(req);
        if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
        const body = bodyRes.value;

        const idRes = extractTargetIdentifier(body);
        if (idRes.error) return res.status(400).json({ message: idRes.error });

        try {
            const result = await updateUserRoleAtomic({
                pool,
                req,
                identifier: idRes.value,
                targetRole: body.role,
                channel: 'admin',
                recordAdminAuditLog,
                createNotification,
            });
            if (result.error) return res.status(result.statusCode).json({ message: result.error });
            return res.json({
                message: `Role akun ${result.user.username} berhasil diubah menjadi ${result.user.role}.`,
                user: result.user,
            });
        } catch (error) {
            logSafeError('Error updating user role:', error);
            return res.status(500).json({ message: 'Gagal mengubah role pengguna.' });
        }
    });

    return router;
};
