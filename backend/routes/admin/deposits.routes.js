const express = require('express');

/**
 * Daftarkan route admin untuk daftar, approve, dan reject deposit.
 */
module.exports = function createAdminDepositsRoutes(deps) {
    const { pool, protectAdmin, createNotification } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a protectAdmin middleware');
    }
    if (typeof createNotification !== 'function') {
        throw new TypeError('createAdminDepositsRoutes requires a createNotification function');
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
            console.error('Error fetching deposits (admin):', error);
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
            console.error('Error fetching pending deposits:', error);
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
            // Notifikasi async — tidak blok response
            createNotification(
                deposit.user_id,
                `Deposit #${deposit.id} sebesar Rp ${Number(deposit.amount).toLocaleString('id-ID')} telah disetujui dan masuk ke saldo.`
            ).catch(err => console.error('Notifikasi approve deposit gagal:', err));
            res.json({ message: `Deposit #${depositId} berhasil disetujui. Saldo user bertambah.` });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error approving deposit:', error);
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
            // Notifikasi async — tidak blok response
            createNotification(
                deposit.user_id,
                `Deposit #${deposit.id} sebesar Rp ${Number(deposit.amount).toLocaleString('id-ID')} ditolak. Hubungi admin untuk informasi lebih lanjut.`
            ).catch(err => console.error('Notifikasi reject deposit gagal:', err));
            res.json({ message: `Deposit #${depositId} berhasil ditolak.` });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error rejecting deposit:', error);
            res.status(500).json({ message: 'Gagal menolak deposit.' });
        } finally {
            client.release();
        }
    });

    return router;
};
