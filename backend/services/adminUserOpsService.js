const { formatRupiahBot } = require('../utils/strings');
const { requireString } = require('../utils/schemaValidators');

const ASSIGNABLE_USER_ROLES = ['BRONZE', 'SILVER', 'GOLD', 'PARTNER'];
const PROTECTED_PRIVILEGED_ROLES = new Set(['ADMIN', 'OWNER']);

/**
 * Ekstrak identifier user dari field identifier, username, atau email pada payload.
 */
function extractTargetIdentifier(body) {
    const src = body && typeof body === 'object' ? body : {};
    const raw = src.identifier !== undefined && src.identifier !== null && String(src.identifier).trim() !== ''
        ? src.identifier
        : (src.username !== undefined && src.username !== null && String(src.username).trim() !== ''
            ? src.username
            : src.email);
    return requireString(raw, 'Username atau email pengguna', { min: 1, max: 255 });
}

/**
 * Cari profil ringkas user secara aman berdasarkan username atau email (case-insensitive).
 */
async function lookupUserByIdentifier({ pool, identifier }) {
    const cleanRes = requireString(identifier, 'Username atau email pengguna', { min: 1, max: 255 });
    if (cleanRes.error) {
        return { error: cleanRes.error, statusCode: 400 };
    }
    const clean = cleanRes.value;
    const { rows } = await pool.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.balance,
                r.id AS role_id, r.name AS role_name
         FROM users u
         JOIN roles r ON u.role_id = r.id
         WHERE LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($2)
         LIMIT 1`,
        [clean, clean]
    );
    if (!rows || rows.length === 0) {
        return { error: 'Pengguna tidak ditemukan.', statusCode: 404 };
    }
    const row = rows[0];
    return {
        user: {
            id: row.id,
            username: row.username,
            email: row.email || null,
            full_name: row.full_name || null,
            balance: Number(row.balance) || 0,
            role_id: row.role_id,
            role: row.role_name,
        },
    };
}

/**
 * Tambah atau kurangi saldo user secara atomik (FOR UPDATE) beserta ledger, audit log, & notifikasi.
 */
async function adjustUserBalanceAtomic({
    pool,
    req,
    direction,
    identifier,
    amount,
    description,
    channel = 'admin',
    recordAdminAuditLog,
    createNotification,
}) {
    const isAdd = direction === 'add';
    const cleanIdRes = requireString(identifier, 'Username atau email pengguna', { min: 1, max: 255 });
    if (cleanIdRes.error) return { statusCode: 400, error: cleanIdRes.error };
    const cleanId = cleanIdRes.value;

    const client = await pool.connect();
    let inTx = false;
    try {
        await client.query('BEGIN');
        inTx = true;

        const { rows } = await client.query(
            'SELECT id, username, email, balance FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) FOR UPDATE',
            [cleanId, cleanId]
        );
        if (!rows || rows.length === 0) {
            await client.query('ROLLBACK');
            inTx = false;
            return { statusCode: 404, error: 'Pengguna tidak ditemukan.' };
        }
        const user = rows[0];
        const balanceBefore = Number(user.balance) || 0;

        if (!isAdd && balanceBefore < amount) {
            await client.query('ROLLBACK');
            inTx = false;
            return { statusCode: 400, error: 'Saldo pengguna tidak mencukupi untuk dikurangi.' };
        }

        const updateSql = isAdd
            ? 'UPDATE users SET balance = balance + $1 WHERE id = $2'
            : 'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1';
        const updRes = await client.query(updateSql, [amount, user.id]);
        if (!isAdd && updRes && typeof updRes.rowCount === 'number' && updRes.rowCount === 0) {
            await client.query('ROLLBACK');
            inTx = false;
            return { statusCode: 400, error: 'Saldo pengguna tidak mencukupi untuk dikurangi.' };
        }

        const historyType = isAdd ? 'Deposit' : 'Refund';
        const deltaAmount = isAdd ? amount : -amount;
        const refPrefix = channel === 'wa_bot'
            ? (isAdd ? 'WABOT_ADD' : 'WABOT_REDUCE')
            : (isAdd ? 'ADMIN_ADD' : 'ADMIN_REDUCE');
        await client.query(
            'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
            [user.id, deltaAmount, historyType, description, `${refPrefix}-${Date.now()}`]
        );

        await client.query('COMMIT');
        inTx = false;

        const balanceAfter = isAdd ? balanceBefore + amount : balanceBefore - amount;
        if (typeof recordAdminAuditLog === 'function') {
            await recordAdminAuditLog(pool, {
                req,
                action: `${channel === 'wa_bot' ? 'wabot' : 'admin'}.balance.${isAdd ? 'add' : 'reduce'}`,
                targetType: 'user_balance',
                targetId: String(user.id),
                beforeData: { balance: balanceBefore },
                afterData: {
                    identifier: cleanId,
                    username: user.username,
                    amount,
                    balance: balanceAfter,
                    description,
                    channel,
                },
            });
        }
        if (typeof createNotification === 'function') {
            const notifMsg = isAdd
                ? `Saldo akun Anda ditambah sebesar ${formatRupiahBot(amount)} (${description}).`
                : `Saldo akun Anda dikurangi sebesar ${formatRupiahBot(amount)} (${description}).`;
            Promise.resolve(createNotification(user.id, notifMsg)).catch(() => {});
        }

        return {
            statusCode: 200,
            user: {
                id: user.id,
                username: user.username,
                email: user.email || null,
                balance_before: balanceBefore,
                balance_after: balanceAfter,
            },
            amount,
            description,
        };
    } catch (error) {
        if (inTx) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Ubah role tier reseller user (BRONZE/SILVER/GOLD/PARTNER) secara atomik dan fail-closed
 * terhadap promosi ke Admin/Owner maupun modifikasi akun Admin/Owner.
 */
async function updateUserRoleAtomic({
    pool,
    req,
    identifier,
    targetRole,
    channel = 'admin',
    recordAdminAuditLog,
    createNotification,
}) {
    const cleanIdRes = requireString(identifier, 'Username atau email pengguna', { min: 1, max: 255 });
    if (cleanIdRes.error) return { statusCode: 400, error: cleanIdRes.error };
    const cleanId = cleanIdRes.value;

    const roleRes = requireString(targetRole, 'Role tujuan', { min: 2, max: 50, uppercase: true });
    if (roleRes.error) return { statusCode: 400, error: roleRes.error };
    const normalizedRole = roleRes.value;

    if (PROTECTED_PRIVILEGED_ROLES.has(normalizedRole)) {
        return { statusCode: 403, error: 'Promosi ke role Admin/Owner tidak diizinkan melalui web atau bot.' };
    }
    if (!ASSIGNABLE_USER_ROLES.includes(normalizedRole)) {
        return {
            statusCode: 400,
            error: `Role tidak valid. Pilih salah satu: ${ASSIGNABLE_USER_ROLES.join(', ')}.`,
        };
    }

    const client = await pool.connect();
    let inTx = false;
    try {
        await client.query('BEGIN');
        inTx = true;

        const { rows: userRows } = await client.query(
            `SELECT u.id, u.username, u.email, u.role_id, r.name AS role_name
             FROM users u
             JOIN roles r ON u.role_id = r.id
             WHERE LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($2)
             FOR UPDATE OF u`,
            [cleanId, cleanId]
        );
        if (!userRows || userRows.length === 0) {
            await client.query('ROLLBACK');
            inTx = false;
            return { statusCode: 404, error: 'Pengguna tidak ditemukan.' };
        }
        const user = userRows[0];
        if (PROTECTED_PRIVILEGED_ROLES.has(String(user.role_name || '').trim().toUpperCase())) {
            await client.query('ROLLBACK');
            inTx = false;
            return { statusCode: 403, error: 'Role akun Admin/Owner tidak dapat diubah melalui web atau bot.' };
        }

        const { rows: roleRows } = await client.query(
            'SELECT id, name FROM roles WHERE UPPER(name) = $1 LIMIT 1',
            [normalizedRole]
        );
        if (!roleRows || roleRows.length === 0) {
            await client.query('ROLLBACK');
            inTx = false;
            return { statusCode: 400, error: 'Role tujuan belum tersedia di database.' };
        }
        const newRole = roleRows[0];

        await client.query(
            'UPDATE users SET role_id = $1, token_version = COALESCE(token_version, 1) + 1, updated_at = NOW() WHERE id = $2',
            [newRole.id, user.id]
        );

        await client.query('COMMIT');
        inTx = false;

        if (typeof recordAdminAuditLog === 'function') {
            await recordAdminAuditLog(pool, {
                req,
                action: `${channel === 'wa_bot' ? 'wabot' : 'admin'}.user.role_update`,
                targetType: 'user_role',
                targetId: String(user.id),
                beforeData: { role_id: user.role_id, role: user.role_name },
                afterData: {
                    username: user.username,
                    role_id: newRole.id,
                    role: newRole.name,
                    channel,
                },
            });
        }
        if (typeof createNotification === 'function') {
            Promise.resolve(
                createNotification(user.id, `Role akun Anda diubah dari ${user.role_name} menjadi ${newRole.name}.`)
            ).catch(() => {});
        }

        return {
            statusCode: 200,
            user: {
                id: user.id,
                username: user.username,
                email: user.email || null,
                previous_role: user.role_name,
                role: newRole.name,
            },
        };
    } catch (error) {
        if (inTx) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    ASSIGNABLE_USER_ROLES,
    PROTECTED_PRIVILEGED_ROLES,
    extractTargetIdentifier,
    lookupUserByIdentifier,
    adjustUserBalanceAtomic,
    updateUserRoleAtomic,
};
