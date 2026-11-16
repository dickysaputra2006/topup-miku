// ============================================================
// === HELPER KOMPENSASI TRANSAKSI BERSAMA (SEC-002) ===
// ============================================================
/**
 * Mengembalikan saldo user (idempoten via balance_history), kuota promo
 * (promo_usages + promo_codes.uses_count), dan kuota flash sale
 * (flash_sales.uses_count + transactions.flash_sale_restored).
 *
 * Pemanggil wajib sudah mengunci baris transaksi dengan `FOR UPDATE` dan
 * memastikan status transaksi eligible sebelum memanggil helper ini.
 */
async function rollbackTransactionResources(client, tx, options = {}) {
    const {
        refundDescription = `Pengembalian dana untuk invoice ${tx && tx.invoice_id}`,
        abortIfAlreadyRefunded = false,
        markFailed = true
    } = options;

    if (!tx || !tx.invoice_id) {
        throw new Error('Rollback ditolak: data transaksi tidak valid.');
    }

    const ALLOWED_ROLLBACK_STATUSES = ['Pending', 'Processing', 'Partial Refund'];
    if (tx.status !== undefined && tx.status !== null && !ALLOWED_ROLLBACK_STATUSES.includes(tx.status)) {
        throw new Error(`Rollback ditolak: status transaksi "${tx.status}" tidak dapat direfund atau diubah ke Failed.`);
    }

    const existingRefund = await client.query(
        "SELECT id FROM balance_history WHERE reference_id = $1 AND type = 'Refund' LIMIT 1",
        [tx.invoice_id]
    );
    const alreadyRefunded = Boolean(existingRefund && existingRefund.rows && existingRefund.rows.length > 0);

    if (alreadyRefunded && abortIfAlreadyRefunded) {
        return {
            alreadyRefunded: true,
            balanceRefunded: false,
            promoRolledBackCount: 0,
            flashSaleRestored: false
        };
    }

    if (markFailed) {
        const updateRes = tx.id
            ? await client.query(
                "UPDATE transactions SET status = 'Failed', updated_at = NOW() WHERE id = $1 AND status IN ('Pending', 'Processing', 'Partial Refund')",
                [tx.id]
            )
            : await client.query(
                "UPDATE transactions SET status = 'Failed', updated_at = NOW() WHERE invoice_id = $1 AND status IN ('Pending', 'Processing', 'Partial Refund')",
                [tx.invoice_id]
            );
        if (updateRes && typeof updateRes.rowCount === 'number' && updateRes.rowCount === 0) {
            throw new Error(`Rollback ditolak: transaksi ${tx.invoice_id} tidak lagi berstatus Pending/Processing/Partial Refund.`);
        }
    }

    let balanceRefunded = false;
    if (!alreadyRefunded) {
        await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2',
            [tx.price, tx.user_id]
        );
        await client.query(
            "INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, 'Refund', $3, $4)",
            [tx.user_id, tx.price, refundDescription, tx.invoice_id]
        );
        balanceRefunded = true;
    }

    let promoRolledBackCount = 0;
    if (tx.id) {
        const promoUsageRes = await client.query(
            'DELETE FROM promo_usages WHERE transaction_id = $1 RETURNING promo_code_id',
            [tx.id]
        );
        for (const usage of (promoUsageRes && promoUsageRes.rows ? promoUsageRes.rows : [])) {
            await client.query(
                'UPDATE promo_codes SET uses_count = GREATEST(0, uses_count - 1), updated_at = NOW() WHERE id = $1',
                [usage.promo_code_id]
            );
            promoRolledBackCount += 1;
        }
    }

    let flashSaleRestored = false;
    if (tx.flash_sale_id && !alreadyRefunded && !tx.flash_sale_restored) {
        await client.query(
            'UPDATE flash_sales SET uses_count = GREATEST(0, uses_count - 1), updated_at = NOW() WHERE id = $1',
            [tx.flash_sale_id]
        );
        if (tx.id) {
            await client.query(
                'UPDATE transactions SET flash_sale_restored = TRUE, updated_at = NOW() WHERE id = $1',
                [tx.id]
            );
        } else {
            await client.query(
                'UPDATE transactions SET flash_sale_restored = TRUE, updated_at = NOW() WHERE invoice_id = $1',
                [tx.invoice_id]
            );
        }
        flashSaleRestored = true;
    }

    return {
        alreadyRefunded,
        balanceRefunded,
        promoRolledBackCount,
        flashSaleRestored
    };
}

module.exports = {
    rollbackTransactionResources,
};
