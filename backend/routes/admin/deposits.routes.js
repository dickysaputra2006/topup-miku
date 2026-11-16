const express = require('express');
const { logSafeError } = require('../../utils/logger');
const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

/**
 * Daftarkan route admin untuk daftar, approve, dan reject deposit.
 */
module.exports = function createAdminDepositsRoutes(deps) {
    const {
        pool,
        protectAdmin,
        createNotification,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a protectAdmin middleware');
    }
    if (typeof createNotification !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a createNotification function');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    // GET /api/admin/deposits — list semua deposit, optional ?status=Pending
    router.get('/api/admin/deposits', protectAdmin, async (req, res) => {
        try {
            const statusFilter = req.query.status;
            const ALLOWED_STATUSES = ['Pending', 'Approved', 'Rejected'];
            let sql;
            let params = [];
            if (statusFilter && ALLOWED_STATUSES.includes(statusFilter)) {
                sql = `SELECT d.id, d.user_id, u.username, u.email, u.nomor_wa,
                              d.amount, d.unique_code, d.status, d.method, d.note,
                              d.created_at, d.updated_at
                       FROM deposits d
                       JOIN users u ON d.user_id = u.id
                       WHERE d.status = $1
                       ORDER BY d.created_at DESC
                       LIMIT 50`;
                params = [statusFilter];
            } else {
                sql = `SELECT d.id, d.user_id, u.username, u.email, u.nomor_wa,
                              d.amount, d.unique_code, d.status, d.method, d.note,
                              d.created_at, d.updated_at
                       FROM deposits d
                       JOIN users u ON d.user_id = u.id
                       ORDER BY d.created_at DESC
                       LIMIT 50`;
            }
            const { rows } = await pool.query(sql, params);
            res.json(rows);
        } catch (error) {
            logSafeError('Error fetching deposits (admin):', error);
            res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
        }
    });

    // Backward-compat alias: /api/admin/deposits/pending masih bisa dipanggil
    router.get('/api/admin/deposits/pending', protectAdmin, async (req, res) => {
        try {
            const sql = `SELECT d.id, d.user_id, u.username, u.email, u.nomor_wa,
                                d.amount, d.unique_code, d.status, d.created_at, d.updated_at
                         FROM deposits d
                         JOIN users u ON d.user_id = u.id
                         WHERE d.status = 'Pending'
                         ORDER BY d.created_at ASC
                         LIMIT 50`;
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            logSafeError('Error fetching pending deposits:', error);
            res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
        }
    });

    // POST /api/admin/deposits/approve — approve deposit Pending
    router.post('/api/admin/deposits/approve', protectAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const depositId = Number(req.body.depositId);
            if (!depositId || !Number.isFinite(depositId) || depositId <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Deposit ID tidak valid.' });
            }
            // Lock baris — cegah double approve (FOR UPDATE)
            const { rows: allRows } = await client.query(
                'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
                [depositId]
            );
            if (allRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Deposit tidak ditemukan.' });
            }
            const deposit = allRows[0];
            // Hanya Pending yang bisa di-approve
            if (deposit.status !== 'Pending') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa approve ulang.`
                });
            }
            // Guard tambahan: cegah double-credit di balance_history (konsisten dengan endpoint bot)
            const referenceId = `DEPOSIT-${deposit.id}`;
            const { rows: existingCredit } = await client.query(
                "SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Deposit' LIMIT 1",
                [referenceId]
            );
            if (existingCredit && existingCredit.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: 'Deposit ini sudah pernah dikreditkan.'
                });
            }
            await client.query(
                "UPDATE deposits SET status = 'Approved', updated_at = NOW() WHERE id = $1",
                [depositId]
            );
            await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                [deposit.amount, deposit.user_id]
            );
            const historyDesc = `Deposit #${deposit.id} disetujui admin`;
            await client.query(
                'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                [deposit.user_id, deposit.amount, 'Deposit', historyDesc, referenceId]
            );
            await client.query('COMMIT');
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.deposit.approve',
                targetType: 'deposit',
                targetId: String(deposit.id),
                beforeData: {
                    status: deposit.status,
                    user_id: deposit.user_id,
                    amount: Number(deposit.amount),
                    method: deposit.method || null,
                },
                afterData: {
                    status: 'Approved',
                    user_id: deposit.user_id,
                    amount: Number(deposit.amount),
                    reference_id: referenceId,
                },
            });
            // Notifikasi async — tidak blok response
            createNotification(
                deposit.user_id,
                `Deposit #${deposit.id} sebesar Rp ${Number(deposit.amount).toLocaleString('id-ID')} telah disetujui dan masuk ke saldo.`
            ).catch(err => logSafeError('Notifikasi approve deposit gagal:', err));
            res.json({ message: `Deposit #${depositId} berhasil disetujui. Saldo user bertambah.` });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('Error approving deposit:', error);
            res.status(500).json({ message: 'Gagal menyetujui deposit.' });
        } finally {
            client.release();
        }
    });

    // POST /api/admin/deposits/reject — reject deposit Pending
    router.post('/api/admin/deposits/reject', protectAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const depositId = Number(req.body.depositId);
            if (!depositId || !Number.isFinite(depositId) || depositId <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Deposit ID tidak valid.' });
            }
            // Lock baris — cegah race condition
            const { rows: allRows } = await client.query(
                'SELECT * FROM deposits WHERE id = $1 FOR UPDATE',
                [depositId]
            );
            if (allRows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Deposit tidak ditemukan.' });
            }
            const deposit = allRows[0];
            // Hanya Pending yang bisa di-reject
            if (deposit.status !== 'Pending') {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: `Deposit ini sudah diproses (status: ${deposit.status}). Tidak bisa reject.`
                });
            }
            await client.query(
                "UPDATE deposits SET status = 'Rejected', updated_at = NOW() WHERE id = $1",
                [depositId]
            );
            // TIDAK ada UPDATE balance, TIDAK ada INSERT balance_history
            await client.query('COMMIT');
            const rejectReason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim())
                ? req.body.reason.trim().slice(0, 200)
                : null;
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.deposit.reject',
                targetType: 'deposit',
                targetId: String(deposit.id),
                beforeData: {
                    status: deposit.status,
                    user_id: deposit.user_id,
                    amount: Number(deposit.amount),
                    method: deposit.method || null,
                },
                afterData: {
                    status: 'Rejected',
                    user_id: deposit.user_id,
                    reason: rejectReason,
                },
            });
            // Notifikasi async — tidak blok response
            createNotification(
                deposit.user_id,
                `Deposit #${deposit.id} sebesar Rp ${Number(deposit.amount).toLocaleString('id-ID')} ditolak. Hubungi admin untuk informasi lebih lanjut.`
            ).catch(err => logSafeError('Notifikasi reject deposit gagal:', err));
            res.json({ message: `Deposit #${depositId} berhasil ditolak.` });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('Error rejecting deposit:', error);
            res.status(500).json({ message: 'Gagal menolak deposit.' });
        } finally {
            client.release();
        }
    });

    return router;
};
