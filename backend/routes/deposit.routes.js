const express = require('express');
const { escapeHtml } = require('../utils/strings');
const { parseOptionalIdempotencyKeyHeader } = require('../utils/validation');

async function findDepositByIdempotencyKey(queryable, userId, idempotencyKey) {
    const { rows } = await queryable.query(
        `SELECT id, user_id, amount, unique_code, status, method, note, idempotency_key, created_at
         FROM deposits
         WHERE user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [userId, idempotencyKey]
    );
    return rows && rows[0] ? rows[0] : null;
}

function matchesDepositIdempotencyPayload(existingDeposit, baseAmount, methodRow, trimmedNote) {
    if (!existingDeposit) return false;
    const existingBaseAmount = Math.trunc(Number(existingDeposit.amount) - Number(existingDeposit.unique_code || 0));
    const existingMethod = String(existingDeposit.method || '').trim().toLowerCase();
    const targetMethod = String(methodRow.name || '').trim().toLowerCase();
    const existingNote = existingDeposit.note ? String(existingDeposit.note).trim() : null;
    const targetNote = trimmedNote ? String(trimmedNote).trim() : null;
    return existingBaseAmount === baseAmount && existingMethod === targetMethod && existingNote === targetNote;
}

function buildDepositPaymentInstructions({ depositId, totalAmount, uniqueCode, methodRow }) {
    const useUniqueCode = !Boolean(methodRow.is_qris);
    const amountFormatted = new Intl.NumberFormat('id-ID').format(totalAmount);
    const safeMethodName = escapeHtml(methodRow.name);
    const safeAcctNumber = methodRow.account_number ? escapeHtml(methodRow.account_number) : '';
    const safeAcctName = methodRow.account_name ? escapeHtml(methodRow.account_name) : '';
    const targetLabel = safeAcctNumber
        ? `ke tujuan <strong>${safeAcctNumber}</strong>${safeAcctName ? ` (a.n. <strong>${safeAcctName}</strong>)` : ''}`
        : 'ke tujuan pembayaran resmi MIKU Store';

    let paymentInstructions;
    if (useUniqueCode) {
        paymentInstructions = `Transfer sejumlah <strong>Rp ${amountFormatted}</strong> (termasuk kode unik <strong>${uniqueCode}</strong>) via <strong>${safeMethodName}</strong> ${targetLabel}. Sertakan nomor deposit <strong>#${depositId}</strong> di keterangan transfer.`;
    } else {
        paymentInstructions = `Transfer tepat sejumlah <strong>Rp ${amountFormatted}</strong> via <strong>${safeMethodName}</strong> (tanpa kode unik 3 digit)${safeAcctName ? ` a.n. <strong>${safeAcctName}</strong>` : ''}. Cantumkan nomor deposit <strong>#${depositId}</strong> saat konfirmasi pembayaran.`;
    }
    if (methodRow.instructions) {
        paymentInstructions += ` <br><small>${escapeHtml(methodRow.instructions)}</small>`;
    }
    return paymentInstructions;
}

function buildDepositResponsePayload(depositRow, methodRow, idempotent = false) {
    const totalAmount = Number(depositRow.amount);
    const uniqueCode = Number(depositRow.unique_code || 0);
    const body = {
        message: idempotent
            ? 'Permintaan deposit sudah tercatat sebelumnya (idempotent).'
            : 'Permintaan deposit berhasil dibuat. Saldo akan masuk setelah admin memverifikasi pembayaran.',
        deposit: {
            id: depositRow.id,
            amount: totalAmount,
            unique_code: uniqueCode,
            method: methodRow.name,
            is_qris: Boolean(methodRow.is_qris),
            status: depositRow.status || 'Pending',
            created_at: depositRow.created_at,
            paymentInstructions: buildDepositPaymentInstructions({
                depositId: depositRow.id,
                totalAmount,
                uniqueCode,
                methodRow
            })
        }
    };
    if (idempotent) {
        body.idempotent = true;
    }
    return body;
}

/**
 * Daftarkan route deposit pengguna dan daftar metode pembayaran aktif.
 */
module.exports = function createDepositRoutes(deps) {
    const { pool, protect } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createDepositRoutes requires a valid pool');
    }
    if (typeof protect !== 'function') {
        throw new TypeError('createDepositRoutes requires a protect middleware');
    }

    const router = express.Router();

    router.get('/api/payment-methods', protect, async (req, res) => {
        try {
            const sql = `SELECT id, code, name, type, account_number, account_name,
                                qris_image_url, instructions, is_qris, min_amount, sort_order
                         FROM payment_methods
                         WHERE is_active = true
                         ORDER BY sort_order ASC, id ASC`;
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            console.error('Error fetching active payment methods:', error);
            res.status(500).json({ message: 'Gagal memuat metode pembayaran.' });
        }
    });

    router.post('/api/deposit/request', protect, async (req, res) => {
        let idempotencyKey = null;
        try {
            idempotencyKey = parseOptionalIdempotencyKeyHeader(req);
        } catch (keyErr) {
            return res.status(keyErr.statusCode || 400).json({ message: keyErr.message });
        }

        const { amount, method, note } = req.body;
        const userId = req.user.id;
        const parsedAmount = Number(amount);

        // Validasi amount global
        if (!Number.isFinite(parsedAmount) || parsedAmount < 10000 || parsedAmount > 100000000) {
            return res.status(400).json({ message: 'Jumlah deposit tidak valid. Minimum Rp 10.000, maksimum Rp 100.000.000.' });
        }

        // Validasi method — wajib dan aktif di tabel payment_methods
        const trimmedMethod = typeof method === 'string' ? method.trim() : '';
        if (!trimmedMethod) {
            return res.status(400).json({ message: 'Metode pembayaran wajib dipilih.' });
        }

        // Validasi note — opsional, max 200 karakter
        const trimmedNote = typeof note === 'string' ? note.trim() : '';
        if (trimmedNote.length > 200) {
            return res.status(400).json({ message: 'Catatan terlalu panjang. Maksimum 200 karakter.' });
        }

        let methodRow;
        try {
            const methodRes = await pool.query(
                `SELECT id, code, name, type, account_number, account_name,
                        qris_image_url, instructions, is_qris, min_amount
                 FROM payment_methods
                 WHERE (LOWER(code) = LOWER($1) OR LOWER(name) = LOWER($1))
                   AND is_active = true
                 LIMIT 1`,
                [trimmedMethod]
            );
            if (!methodRes || !methodRes.rows || methodRes.rows.length === 0) {
                return res.status(400).json({ message: 'Metode pembayaran tidak valid atau sedang tidak aktif.' });
            }
            methodRow = methodRes.rows[0];
        } catch (error) {
            console.error('Error validating deposit payment method:', error);
            return res.status(500).json({ message: 'Terjadi kesalahan pada server saat memvalidasi metode pembayaran.' });
        }

        const baseAmount = Math.trunc(parsedAmount);
        const methodMinAmount = Number(methodRow.min_amount) || 10000;
        if (baseAmount < methodMinAmount) {
            const minFormatted = new Intl.NumberFormat('id-ID').format(methodMinAmount);
            return res.status(400).json({
                message: `Minimum deposit untuk metode ${methodRow.name} adalah Rp ${minFormatted}.`
            });
        }

        // Pre-check idempotency (sebelum pendingCount >= 2 agar retry deposit yang baru dibuat tidak terkena 429)
        if (idempotencyKey) {
            try {
                const existingDeposit = await findDepositByIdempotencyKey(pool, userId, idempotencyKey);
                if (existingDeposit) {
                    if (!matchesDepositIdempotencyPayload(existingDeposit, baseAmount, methodRow, trimmedNote)) {
                        return res.status(409).json({
                            message: 'Idempotency-Key sudah digunakan untuk deposit dengan payload berbeda.'
                        });
                    }
                    return res.status(200).json(buildDepositResponsePayload(existingDeposit, methodRow, true));
                }
            } catch (idempErr) {
                console.error('Error checking deposit idempotency:', idempErr);
                return res.status(500).json({ message: 'Terjadi kesalahan pada server saat memvalidasi idempotency deposit.' });
            }
        }

        const useUniqueCode = !Boolean(methodRow.is_qris);
        const client = await pool.connect();
        let inTransaction = false;
        try {
            await client.query('BEGIN');
            inTransaction = true;
            const pendingCheck = await client.query(
                "SELECT COUNT(*) AS count FROM deposits WHERE user_id = $1 AND status = 'Pending'",
                [userId]
            );
            const pendingCount = (pendingCheck && pendingCheck.rows && pendingCheck.rows[0] && pendingCheck.rows[0].count !== undefined)
                ? parseInt(pendingCheck.rows[0].count, 10)
                : 0;
            if (pendingCount >= 2) {
                await client.query('ROLLBACK');
                inTransaction = false;
                return res.status(429).json({
                    message: 'Anda masih memiliki maksimal 2 permintaan deposit Pending. Selesaikan atau tunggu verifikasi terlebih dahulu.'
                });
            }

            let uniqueCode = 0;
            let totalAmount = baseAmount;
            if (useUniqueCode) {
                for (let attempt = 0; attempt < 10; attempt++) {
                    const candidateCode = Math.floor(Math.random() * 900) + 100;
                    const candidateTotal = baseAmount + candidateCode;
                    const collisionRes = await client.query(
                        "SELECT 1 FROM deposits WHERE status = 'Pending' AND amount = $1 LIMIT 1",
                        [candidateTotal]
                    );
                    if (!collisionRes || !collisionRes.rows || collisionRes.rows.length === 0) {
                        uniqueCode = candidateCode;
                        totalAmount = candidateTotal;
                        break;
                    }
                }
                if (uniqueCode === 0) {
                    uniqueCode = Math.floor(Math.random() * 900) + 100;
                    totalAmount = baseAmount + uniqueCode;
                }
            }

            const insertSql = idempotencyKey
                ? 'INSERT INTO deposits (user_id, amount, unique_code, status, method, note, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at'
                : 'INSERT INTO deposits (user_id, amount, unique_code, status, method, note) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at';
            const insertParams = idempotencyKey
                ? [userId, totalAmount, uniqueCode, 'Pending', methodRow.name, trimmedNote || null, idempotencyKey]
                : [userId, totalAmount, uniqueCode, 'Pending', methodRow.name, trimmedNote || null];

            const { rows } = await client.query(insertSql, insertParams);
            const depositId = rows[0].id;
            const createdAt = rows[0].created_at;
            await client.query('COMMIT');
            inTransaction = false;

            return res.status(201).json(buildDepositResponsePayload({
                id: depositId,
                amount: totalAmount,
                unique_code: uniqueCode,
                status: 'Pending',
                created_at: createdAt
            }, methodRow, false));
        } catch (error) {
            if (inTransaction) {
                await client.query('ROLLBACK').catch(() => {});
                inTransaction = false;
            }
            if (error && error.code === '23505' && idempotencyKey) {
                try {
                    const existingAfterRace = await findDepositByIdempotencyKey(client, userId, idempotencyKey);
                    if (existingAfterRace) {
                        if (!matchesDepositIdempotencyPayload(existingAfterRace, baseAmount, methodRow, trimmedNote)) {
                            return res.status(409).json({
                                message: 'Idempotency-Key sudah digunakan untuk deposit dengan payload berbeda.'
                            });
                        }
                        return res.status(200).json(buildDepositResponsePayload(existingAfterRace, methodRow, true));
                    }
                } catch (rereadErr) {
                    console.error('Error re-reading deposit after 23505 race:', rereadErr);
                }
            }
            console.error('Error creating deposit request:', error);
            res.status(500).json({ message: 'Terjadi kesalahan pada server saat membuat permintaan deposit.' });
        } finally {
            client.release();
        }
    });

    // GET riwayat deposit user sendiri (max 20 terbaru)
    router.get('/api/user/deposits', protect, async (req, res) => {
        try {
            const userId = req.user.id;
            const sql = `SELECT id, amount, unique_code, status, method, note, created_at
                         FROM deposits
                         WHERE user_id = $1
                         ORDER BY created_at DESC
                         LIMIT 20`;
            const { rows } = await pool.query(sql, [userId]);
            res.json(rows);
        } catch (error) {
            console.error('Error fetching user deposits:', error);
            res.status(500).json({ message: 'Gagal mengambil riwayat deposit.' });
        }
    });

    return router;
};
