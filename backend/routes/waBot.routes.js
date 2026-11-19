const express = require('express');
const { logSafeError } = require('../utils/logger');
const { formatRupiahBot } = require('../utils/strings');
const { requireWaBotAdminToken: defaultRequireWaBotAdminToken } = require('../middleware/waBotAuth');
const { recordAdminAuditLog: defaultRecordAdminAuditLog } = require('../services/auditLogService');

/**
 * Daftarkan route admin WA bot untuk pembacaan serta approve/reject deposit.
 */
module.exports = function createWaBotRoutes(deps) {
    const {
        pool,
        createNotification,
        requireWaBotAdminToken = defaultRequireWaBotAdminToken,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};

    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createWaBotRoutes requires a valid pool');
    }
    if (typeof createNotification !== 'function') {
        throw new TypeError('createWaBotRoutes requires a createNotification function');
    }
    if (typeof requireWaBotAdminToken !== 'function') {
        throw new TypeError('createWaBotRoutes requires a requireWaBotAdminToken middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createWaBotRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    // GET /api/bot/admin/deposits/pending — daftar deposit Pending (read-only)
    // Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
    // Query: ?limit=10 (default 10, max 50)
    router.get('/api/bot/admin/deposits/pending', requireWaBotAdminToken, async (req, res) => {
        try {
            // Limit: default 10, max 50
            const rawLimit = parseInt(req.query.limit, 10);
            const limit = (Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 50) ? rawLimit : 10;

            // READ-ONLY: hanya SELECT, tidak ada UPDATE/INSERT/DELETE
            const sql = `
                SELECT
                    d.id,
                    u.username,
                    d.amount,
                    d.unique_code,
                    d.method,
                    d.note,
                    d.status,
                    d.created_at
                FROM deposits d
                JOIN users u ON d.user_id = u.id
                WHERE d.status = 'Pending'
                ORDER BY d.created_at ASC
                LIMIT $1
            `;
            const { rows } = await pool.query(sql, [limit]);

            const deposits = rows.map(d => {
                const amountNum = Number(d.amount) || 0;
                const summaryText = `Deposit #${d.id} dari ${d.username} sebesar ${formatRupiahBot(amountNum)} via ${d.method || '-'}. Status: Pending.`;
                return {
                    id:           d.id,
                    username:     d.username,
                    amount:       amountNum,
                    unique_code:  d.unique_code,
                    method:       d.method   || null,
                    note:         d.note     || null,
                    status:       d.status,
                    created_at:   d.created_at,
                    summary_text: summaryText
                };
            });

            return res.json({
                deposits,
                count:        deposits.length,
                generated_at: new Date().toISOString()
            });
        } catch (error) {
            logSafeError('[bot/admin/deposits/pending] Error:', error);
            res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data deposit.' });
        }
    });

    // GET /api/bot/admin/deposits/:id — detail satu deposit (read-only)
    // Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
    router.get('/api/bot/admin/deposits/:id', requireWaBotAdminToken, async (req, res) => {
        try {
            const depositId = parseInt(req.params.id, 10);
            if (!Number.isFinite(depositId) || depositId <= 0) {
                return res.status(400).json({ message: 'ID deposit tidak valid.' });
            }

            // READ-ONLY: hanya SELECT, tidak ada UPDATE/INSERT/DELETE
            const sql = `
                SELECT
                    d.id,
                    u.username,
                    d.amount,
                    d.unique_code,
                    d.method,
                    d.note,
                    d.status,
                    d.created_at,
                    d.updated_at
                FROM deposits d
                JOIN users u ON d.user_id = u.id
                WHERE d.id = $1
                LIMIT 1
            `;
            const { rows } = await pool.query(sql, [depositId]);

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Deposit tidak ditemukan.' });
            }

            const d = rows[0];
            const amountNum = Number(d.amount) || 0;
            const summaryText = `Deposit #${d.id} dari ${d.username} sebesar ${formatRupiahBot(amountNum)} via ${d.method || '-'}. Status: ${d.status}.`;

            return res.json({
                id:           d.id,
                username:     d.username,
                amount:       amountNum,
                unique_code:  d.unique_code,
                method:       d.method   || null,
                note:         d.note     || null,
                status:       d.status,
                created_at:   d.created_at,
                updated_at:   d.updated_at || null,
                summary_text: summaryText
            });
        } catch (error) {
            logSafeError('[bot/admin/deposits/:id] Error:', error);
            res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data deposit.' });
        }
    });

    // === PHASE 7B: WA BOT ADMIN DEPOSIT APPROVE/REJECT API ===

    // POST /api/bot/admin/deposits/:id/approve — approve deposit Pending via WA bot
    // Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
    // Body (optional): { "note": "catatan admin" }
    router.post('/api/bot/admin/deposits/:id/approve', requireWaBotAdminToken, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const depositId = parseInt(req.params.id, 10);
            if (!Number.isFinite(depositId) || depositId <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: 'ID deposit tidak valid.' });
            }

            // Lock baris — cegah double approve (FOR UPDATE)
            const { rows: allRows } = await client.query(
                `SELECT d.id, d.user_id, d.amount, d.unique_code, d.method, d.note, d.status, d.created_at,
                        u.username
                 FROM deposits d
                 JOIN users u ON d.user_id = u.id
                 WHERE d.id = $1
                 FOR UPDATE OF d`,
                [depositId]
            );

            if (allRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Deposit tidak ditemukan.' });
            }

            const deposit = allRows[0];

            // Hanya Pending yang bisa di-approve
            if (deposit.status !== 'Pending') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa approve ulang.`
                });
            }

            // Guard tambahan: cek apakah balance_history sudah pernah dikreditkan
            const referenceId = `DEPOSIT-${deposit.id}`;
            const { rows: existingCredit } = await client.query(
                "SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Deposit' LIMIT 1",
                [referenceId]
            );
            if (existingCredit.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    message: 'Deposit ini sudah pernah dikreditkan.'
                });
            }

            // Update status deposit
            await client.query(
                "UPDATE deposits SET status = 'Approved', updated_at = NOW() WHERE id = $1",
                [depositId]
            );

            // Tambah saldo user
            await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                [deposit.amount, deposit.user_id]
            );

            // Insert balance_history (simpan req.body.note jika ada)
            const adminNote = (req.body && typeof req.body.note === 'string') ? req.body.note.trim().slice(0, 200) : '';
            const historyDesc = adminNote
                ? `Deposit #${deposit.id} disetujui via WA bot (${adminNote})`
                : `Deposit #${deposit.id} disetujui via WA bot`;
            await client.query(
                'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                [deposit.user_id, deposit.amount, 'Deposit', historyDesc, referenceId]
            );

            await client.query('COMMIT');
            await recordAdminAuditLog(client, {
                req,
                action: 'wabot.deposit.approve',
                targetType: 'deposit',
                targetId: String(deposit.id),
                beforeData: { status: 'Pending', amount: Number(deposit.amount) },
                afterData: { status: 'Approved', user_id: deposit.user_id, channel: 'wa_bot', note: adminNote || null },
            });

            // Notifikasi async — tidak blok response
            const amountNum = Number(deposit.amount) || 0;
            createNotification(
                deposit.user_id,
                `Deposit #${deposit.id} sebesar ${formatRupiahBot(amountNum)} telah disetujui dan masuk ke saldo.`
            ).catch(err => console.error('Notifikasi bot approve deposit gagal:', err));

            const summaryText = `✅ Deposit #${deposit.id} dari ${deposit.username} sebesar ${formatRupiahBot(amountNum)} via ${deposit.method || '-'} berhasil di-approve. Saldo user sudah ditambahkan.`;

            return res.json({
                success: true,
                message: `Deposit #${deposit.id} berhasil di-approve.`,
                deposit: {
                    id:       deposit.id,
                    username: deposit.username,
                    amount:   amountNum,
                    method:   deposit.method || null,
                    status:   'Approved'
                },
                summary_text: summaryText
            });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('[bot/admin/deposits/:id/approve] Error:', error);
            res.status(500).json({ success: false, message: 'Gagal menyetujui deposit.' });
        } finally {
            client.release();
        }
    });

    // POST /api/bot/admin/deposits/:id/reject — reject deposit Pending via WA bot
    // Auth: Authorization: Bearer <WA_BOT_ADMIN_TOKEN>
    // Body (optional): { "reason": "alasan reject" }
    router.post('/api/bot/admin/deposits/:id/reject', requireWaBotAdminToken, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const depositId = parseInt(req.params.id, 10);
            if (!Number.isFinite(depositId) || depositId <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: 'ID deposit tidak valid.' });
            }

            // Lock baris — cegah race condition
            const { rows: allRows } = await client.query(
                `SELECT d.id, d.user_id, d.amount, d.unique_code, d.method, d.note, d.status, d.created_at,
                        u.username
                 FROM deposits d
                 JOIN users u ON d.user_id = u.id
                 WHERE d.id = $1
                 FOR UPDATE OF d`,
                [depositId]
            );

            if (allRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Deposit tidak ditemukan.' });
            }

            const deposit = allRows[0];

            // Hanya Pending yang bisa di-reject
            if (deposit.status !== 'Pending') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa reject.`
                });
            }

            // Update status deposit — TIDAK update balance, TIDAK insert balance_history
            await client.query(
                "UPDATE deposits SET status = 'Rejected', updated_at = NOW() WHERE id = $1",
                [depositId]
            );

            await client.query('COMMIT');
            const amountNum = Number(deposit.amount) || 0;
            const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 200) : '';
            await recordAdminAuditLog(client, {
                req,
                action: 'wabot.deposit.reject',
                targetType: 'deposit',
                targetId: String(deposit.id),
                beforeData: { status: 'Pending', amount: amountNum },
                afterData: { status: 'Rejected', user_id: deposit.user_id, channel: 'wa_bot', reason: reason || null },
            });

            // Notifikasi async — tidak blok response
            const notifMessage = reason
                ? `Deposit #${deposit.id} sebesar ${formatRupiahBot(amountNum)} ditolak. Alasan: ${reason}`
                : `Deposit #${deposit.id} sebesar ${formatRupiahBot(amountNum)} ditolak. Hubungi admin untuk informasi lebih lanjut.`;
            createNotification(deposit.user_id, notifMessage)
                .catch(err => console.error('Notifikasi bot reject deposit gagal:', err));

            const summaryText = `❌ Deposit #${deposit.id} dari ${deposit.username} sebesar ${formatRupiahBot(amountNum)} via ${deposit.method || '-'} ditolak.`;

            return res.json({
                success: true,
                message: `Deposit #${deposit.id} berhasil ditolak.`,
                deposit: {
                    id:       deposit.id,
                    username: deposit.username,
                    amount:   amountNum,
                    method:   deposit.method || null,
                    status:   'Rejected'
                },
                summary_text: summaryText
            });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('[bot/admin/deposits/:id/reject] Error:', error);
            res.status(500).json({ success: false, message: 'Gagal menolak deposit.' });
        } finally {
            client.release();
        }
    });

    return router;
};
