const { DUPLICATE_ORDER_WINDOW_SECONDS } = require('../config/constants');
const {
    generateInvoiceId,
    generateProviderTrxId,
} = require('../utils/crypto');

async function findTransactionByRefId(queryable, userId, refId) {
    const { rows } = await queryable.query(
        `SELECT t.id, t.invoice_id, t.user_id, t.product_id, t.target_game_id, t.price, t.status, t.ref_id,
                p.name AS product_name, g.needs_server_id
         FROM transactions t
         LEFT JOIN products p ON t.product_id = p.id
         LEFT JOIN games g ON p.game_id = g.id
         WHERE t.user_id = $1 AND t.ref_id = $2
         LIMIT 1`,
        [userId, refId]
    );
    return rows && rows[0] ? rows[0] : null;
}

function matchesOrderIdempotencyPayload(existingTx, productId, targetGameId, targetServerId) {
    if (!existingTx || Number(existingTx.product_id) !== Number(productId)) {
        return false;
    }
    const expectedTarget = Boolean(existingTx.needs_server_id)
        ? `${targetGameId}|${targetServerId || ''}`
        : targetGameId;
    return existingTx.target_game_id === expectedTarget;
}

function buildIdempotentOrderResponseBody(channel, existingTx) {
    if (channel === 'h2h') {
        return {
            success: true,
            idempotent: true,
            message: 'Transaksi H2H sudah tercatat sebelumnya (idempotent).',
            data: {
                invoiceId: existingTx.invoice_id,
                status: existingTx.status,
                productName: existingTx.product_name,
                target: existingTx.target_game_id,
                price: Number(existingTx.price)
            }
        };
    }
    return {
        idempotent: true,
        message: 'Pesanan sudah tercatat sebelumnya (idempotent).',
        invoiceId: existingTx.invoice_id,
        status: existingTx.status
    };
}

async function resolveExistingIdempotentOrder(queryable, { channel, userId, idempotencyKey, keyLabel, productId, targetGameId, targetServerId }) {
    if (!idempotencyKey) return null;
    const existingTx = await findTransactionByRefId(queryable, userId, idempotencyKey);
    if (!existingTx) return null;

    if (!matchesOrderIdempotencyPayload(existingTx, productId, targetGameId, targetServerId)) {
        const conflictErr = new Error(`${keyLabel} sudah digunakan untuk pesanan dengan payload berbeda.`);
        conflictErr.statusCode = 409;
        throw conflictErr;
    }

    if (channel === 'web' && existingTx.status === 'Failed') {
        return {
            statusCode: 409,
            body: {
                idempotent: true,
                invoiceId: existingTx.invoice_id,
                status: existingTx.status,
                message: 'Pesanan sebelumnya gagal dan saldo telah dikembalikan. Silakan buat pesanan baru.'
            }
        };
    }

    return {
        statusCode: 200,
        body: buildIdempotentOrderResponseBody(channel, existingTx)
    };
}

async function insertTransactionRecord(client, {
    invoiceId,
    userId,
    productId,
    targetForDb,
    finalPrice,
    providerTrxId,
    flashSaleId,
    idempotencyKey
}) {
    const sql = idempotencyKey
        ? 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id, flash_sale_id, ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id'
        : 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id, flash_sale_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id';
    const params = idempotencyKey
        ? [invoiceId, userId, productId, targetForDb, finalPrice, 'Pending', providerTrxId, flashSaleId || null, idempotencyKey]
        : [invoiceId, userId, productId, targetForDb, finalPrice, 'Pending', providerTrxId, flashSaleId || null];
    return client.query(sql, params);
}

async function findRecentPendingDuplicate(client, userId, productId, targetGameId) {
    const { rows } = await client.query(
        `SELECT invoice_id
         FROM transactions
         WHERE user_id = $1
           AND product_id = $2
           AND target_game_id = $3
           AND status = 'Pending'
           AND created_at > NOW() - ($4::int * INTERVAL '1 second')
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, productId, targetGameId, DUPLICATE_ORDER_WINDOW_SECONDS]
    );
    return rows[0] || null;
}

module.exports = {
    generateInvoiceId,
    generateProviderTrxId,
    findTransactionByRefId,
    matchesOrderIdempotencyPayload,
    buildIdempotentOrderResponseBody,
    resolveExistingIdempotentOrder,
    insertTransactionRecord,
    findRecentPendingDuplicate,
};
