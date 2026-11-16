const express = require('express');
const { normalizeString } = require('../../utils/strings');
const { logSafeError } = require('../../utils/logger');
const {
    rollbackTransactionResources: defaultRollbackTransactionResources,
} = require('../../services/refundService');

/**
 * Daftarkan route admin untuk daftar riwayat dan resolve manual transaksi.
 */
module.exports = function createAdminTransactionsRoutes(deps) {
    const {
        pool,
        protectAdmin,
        createNotification,
        rollbackTransactionResources = defaultRollbackTransactionResources,
    } = deps || {};

    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAdminTransactionsRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminTransactionsRoutes requires a protectAdmin middleware');
    }
    if (typeof createNotification !== 'function') {
        throw new TypeError('createAdminTransactionsRoutes requires a createNotification function');
    }
    if (typeof rollbackTransactionResources !== 'function') {
        throw new TypeError('createAdminTransactionsRoutes requires a rollbackTransactionResources function');
    }

    const router = express.Router();

    router.get('/api/admin/transactions', protectAdmin, async (req, res) => {
        try {
            const sql = `
            SELECT t.invoice_id, t.user_id, t.target_game_id, t.price, t.status, t.created_at, p.name as product_name, u.username as user_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
        `;
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            console.error("Gagal mengambil riwayat transaksi admin:", error);
            res.status(500).json({ message: 'Server error saat mengambil riwayat transaksi.' });
        }
    });

    // Admin manual resolve: mark berhasil, refund/gagalkan, atau keep_review
    router.put('/api/admin/transactions/:invoiceId/resolve', protectAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const invoiceId = normalizeString(req.params.invoiceId, 100);
            const action = normalizeString(req.body.action || '', 20);

            if (!['success', 'refund', 'keep_review'].includes(action)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Aksi tidak valid. Gunakan: success, refund, keep_review.' });
            }

            // Lock baris untuk hindari race condition
            const { rows } = await client.query(
                'SELECT * FROM transactions WHERE invoice_id = $1 FOR UPDATE',
                [invoiceId]
            );
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
            }
            const tx = rows[0];

            // Hanya boleh resolve dari status non-final
            if (!['Pending', 'Partial Refund'].includes(tx.status)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `Transaksi sudah berstatus "${tx.status}". Tidak bisa diubah lagi.`
                });
            }

            // action success/refund hanya boleh dari Partial Refund (bukan dari Pending biasa)
            if ((action === 'success' || action === 'refund') && tx.status !== 'Partial Refund') {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `Aksi "${action}" hanya diizinkan untuk transaksi berstatus "Partial Refund". Status saat ini: "${tx.status}".`
                });
            }

            if (action === 'success') {
                await client.query(
                    "UPDATE transactions SET status = 'Success', updated_at = NOW() WHERE id = $1",
                    [tx.id]
                );
                await createNotification(
                    tx.user_id,
                    `Pesanan ${tx.invoice_id} telah dikonfirmasi berhasil oleh admin.`,
                    `/invoice.html?id=${tx.invoice_id}`
                );
                await client.query('COMMIT');
                return res.json({ message: `Transaksi ${invoiceId} berhasil ditandai Berhasil.` });


            } else if (action === 'refund') {
                const histDesc = `Refund admin untuk invoice ${tx.invoice_id}`;
                const rollbackResult = await rollbackTransactionResources(client, tx, {
                    refundDescription: histDesc,
                    abortIfAlreadyRefunded: true
                });
                if (rollbackResult.alreadyRefunded) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ message: 'Saldo untuk transaksi ini sudah pernah direfund sebelumnya.' });
                }
                await createNotification(
                    tx.user_id,
                    `Pesanan ${tx.invoice_id} gagal. Saldo Rp ${Number(tx.price).toLocaleString('id-ID')} telah dikembalikan.`,
                    `/invoice.html?id=${tx.invoice_id}`
                );
                await client.query('COMMIT');
                return res.json({ message: `Transaksi ${invoiceId} berhasil di-refund dan ditandai Gagal.` });

            } else if (action === 'keep_review') {
                // Jika masih Pending, jadikan Partial Refund; jika sudah Partial Refund, no-op (update updated_at)
                if (tx.status === 'Pending') {
                    await client.query(
                        "UPDATE transactions SET status = 'Partial Refund', updated_at = NOW() WHERE id = $1",
                        [tx.id]
                    );
                } else {
                    // Sudah Partial Refund — update updated_at saja sebagai tanda admin sudah lihat
                    await client.query(
                        'UPDATE transactions SET updated_at = NOW() WHERE id = $1',
                        [tx.id]
                    );
                }
                await client.query('COMMIT');
                return res.json({ message: `Transaksi ${invoiceId} tetap dalam status Review Admin.` });
            }

            // Seharusnya tidak sampai sini
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Aksi tidak valid.' });

        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('Admin resolve error:', error);
            res.status(500).json({ message: 'Gagal memproses aksi admin.' });
        } finally {
            client.release();
        }
    });

    return router;
};
