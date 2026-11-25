const express = require('express');
const { logSafeError } = require('../utils/logger');
const { formatRupiahBot } = require('../utils/strings');
const { getBodyObject, optionalTrimmedString, requirePositiveInt } = require('../utils/schemaValidators');
const { requireWaBotAdminToken: defaultRequireWaBotAdminToken } = require('../middleware/waBotAuth');
const { recordAdminAuditLog: defaultRecordAdminAuditLog } = require('../services/auditLogService');
const {
    extractTargetIdentifier,
    adjustUserBalanceAtomic,
    updateUserRoleAtomic,
} = require('../services/adminUserOpsService');

/**
 * Daftarkan route WA Bot admin untuk tambah/kurang saldo dan ubah role pengguna.
 */
module.exports = function createWaBotUsersRoutes(deps) {
    const {
        pool,
        createNotification,
        requireWaBotAdminToken = defaultRequireWaBotAdminToken,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};

    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createWaBotUsersRoutes requires a valid pool');
    }
    if (typeof createNotification !== 'function') {
        throw new TypeError('createWaBotUsersRoutes requires a createNotification function');
    }
    if (typeof requireWaBotAdminToken !== 'function') {
        throw new TypeError('createWaBotUsersRoutes requires a requireWaBotAdminToken middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createWaBotUsersRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    async function handleBotBalanceAdjustment(req, res, direction) {
        const isAdd = direction === 'add';
        const bodyRes = getBodyObject(req);
        if (bodyRes.error) return res.status(400).json({ success: false, message: bodyRes.error });
        const body = bodyRes.value;

        const idRes = extractTargetIdentifier(body);
        if (idRes.error) return res.status(400).json({ success: false, message: idRes.error });

        const amountRes = requirePositiveInt(body.amount, 'Jumlah saldo', { min: 1, max: 100000000 });
        if (amountRes.error) return res.status(400).json({ success: false, message: amountRes.error });

        const rawDesc = body.description !== undefined && body.description !== null && String(body.description).trim() !== ''
            ? body.description
            : body.note;
        const descRes = optionalTrimmedString(rawDesc, 'Deskripsi', {
            max: 255,
            defaultValue: isAdd ? 'Tambah saldo via WA bot' : 'Kurangi saldo via WA bot',
            allowNewlines: false,
        });
        if (descRes.error) return res.status(400).json({ success: false, message: descRes.error });

        try {
            const result = await adjustUserBalanceAtomic({
                pool,
                req,
                direction,
                identifier: idRes.value,
                amount: amountRes.value,
                description: descRes.value,
                channel: 'wa_bot',
                recordAdminAuditLog,
                createNotification,
            });
            if (result.error) {
                return res.status(result.statusCode).json({ success: false, message: result.error });
            }

            const verb = isAdd ? 'ditambahkan' : 'dikurangi';
            const summaryText = isAdd
                ? `✅ Saldo ${result.user.username} berhasil ditambah ${formatRupiahBot(result.amount)}. Saldo sekarang: ${formatRupiahBot(result.user.balance_after)}.`
                : `✅ Saldo ${result.user.username} berhasil dikurangi ${formatRupiahBot(result.amount)}. Saldo sekarang: ${formatRupiahBot(result.user.balance_after)}.`;

            return res.json({
                success: true,
                message: `Saldo akun ${result.user.username} berhasil ${verb} sebesar ${result.amount}.`,
                user: result.user,
                amount: result.amount,
                summary_text: summaryText,
            });
        } catch (error) {
            logSafeError(`[bot/admin/balance/${direction}] Error:`, error);
            return res.status(500).json({
                success: false,
                message: isAdd ? 'Gagal menambah saldo pengguna.' : 'Gagal mengurangi saldo pengguna.',
            });
        }
    }

    router.post('/api/bot/admin/balance/add', requireWaBotAdminToken, (req, res) => {
        return handleBotBalanceAdjustment(req, res, 'add');
    });

    router.post('/api/bot/admin/balance/reduce', requireWaBotAdminToken, (req, res) => {
        return handleBotBalanceAdjustment(req, res, 'reduce');
    });

    router.post('/api/bot/admin/users/role', requireWaBotAdminToken, async (req, res) => {
        const bodyRes = getBodyObject(req);
        if (bodyRes.error) return res.status(400).json({ success: false, message: bodyRes.error });
        const body = bodyRes.value;

        const idRes = extractTargetIdentifier(body);
        if (idRes.error) return res.status(400).json({ success: false, message: idRes.error });

        try {
            const result = await updateUserRoleAtomic({
                pool,
                req,
                identifier: idRes.value,
                targetRole: body.role,
                channel: 'wa_bot',
                recordAdminAuditLog,
                createNotification,
            });
            if (result.error) {
                return res.status(result.statusCode).json({ success: false, message: result.error });
            }

            const summaryText = `✅ Role akun ${result.user.username} berhasil diubah dari ${result.user.previous_role} menjadi ${result.user.role}.`;
            return res.json({
                success: true,
                message: `Role akun ${result.user.username} berhasil diubah menjadi ${result.user.role}.`,
                user: result.user,
                summary_text: summaryText,
            });
        } catch (error) {
            logSafeError('[bot/admin/users/role] Error:', error);
            return res.status(500).json({ success: false, message: 'Gagal mengubah role pengguna.' });
        }
    });

    return router;
};
