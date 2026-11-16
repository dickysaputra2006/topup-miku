const express = require('express');
const { ALLOWED_PAYMENT_METHOD_TYPES } = require('../../config/constants');
const {
    isSafeAssetUrl,
    parseOptionalBoolean,
    parseOptionalText,
} = require('../../utils/validation');
const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

function normalizePaymentMethodPayload(body, existing = null) {
    const src = body && typeof body === 'object' ? body : {};
    const hasProp = (k) => Object.prototype.hasOwnProperty.call(src, k);

    const rawName = hasProp('name') ? src.name : existing?.name;
    if (typeof rawName !== 'string' || !rawName.trim()) {
        return { error: 'Nama metode pembayaran wajib diisi.' };
    }
    const name = rawName.trim();
    if (name.length > 100) {
        return { error: 'Nama metode pembayaran maksimal 100 karakter.' };
    }

    const rawCode = hasProp('code') ? src.code : existing?.code;
    if (typeof rawCode !== 'string' || !rawCode.trim()) {
        return { error: 'Kode metode pembayaran wajib diisi.' };
    }
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,50}$/.test(code)) {
        return { error: 'Kode metode harus 2-50 karakter (huruf, angka, _ atau -).' };
    }

    const rawType = hasProp('type') ? src.type : (existing?.type ?? 'ewallet');
    const type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
    if (!ALLOWED_PAYMENT_METHOD_TYPES.includes(type)) {
        return { error: `Tipe metode harus salah satu dari: ${ALLOWED_PAYMENT_METHOD_TYPES.join(', ')}.` };
    }

    const acctNumRes = parseOptionalText(src, 'account_number', existing?.account_number ?? null, 100);
    if (acctNumRes.error) return { error: 'Nomor rekening/HP ' + acctNumRes.error };

    const acctNameRes = parseOptionalText(src, 'account_name', existing?.account_name ?? null, 150);
    if (acctNameRes.error) return { error: 'Atas nama ' + acctNameRes.error };

    const qrisUrlRes = parseOptionalText(src, 'qris_image_url', existing?.qris_image_url ?? null, 1000);
    if (qrisUrlRes.error) return { error: 'URL gambar QRIS ' + qrisUrlRes.error };
    if (qrisUrlRes.value && !isSafeAssetUrl(qrisUrlRes.value)) {
        return { error: 'URL gambar QRIS tidak valid. Gunakan URL http(s):// atau path /...' };
    }

    const instrRes = parseOptionalText(src, 'instructions', existing?.instructions ?? null, 1000);
    if (instrRes.error) return { error: 'Instruksi ' + instrRes.error };

    const rawMin = hasProp('min_amount') && src.min_amount !== '' && src.min_amount !== null
        ? src.min_amount
        : (existing?.min_amount ?? 10000);
    const minAmount = Number(rawMin);
    if (!Number.isFinite(minAmount) || minAmount < 10000 || minAmount > 100000000) {
        return { error: 'Minimal deposit harus antara Rp 10.000 hingga Rp 100.000.000.' };
    }

    const rawSort = hasProp('sort_order') && src.sort_order !== '' && src.sort_order !== null
        ? src.sort_order
        : (existing?.sort_order ?? 0);
    const sortOrder = Number(rawSort);
    if (!Number.isInteger(sortOrder) || sortOrder < -9999 || sortOrder > 9999) {
        return { error: 'Urutan tampil harus berupa bilangan bulat (-9999 sampai 9999).' };
    }

    const parsedActive = hasProp('is_active')
        ? parseOptionalBoolean(src.is_active, null)
        : (existing ? Boolean(existing.is_active) : true);
    if (parsedActive === null) {
        return { error: 'Status aktif (is_active) tidak valid.' };
    }

    let isQris;
    if (type === 'qris') {
        isQris = true;
    } else if (hasProp('is_qris')) {
        const parsedQris = parseOptionalBoolean(src.is_qris, null);
        if (parsedQris === null) return { error: 'Flag is_qris tidak valid.' };
        isQris = parsedQris;
    } else if (hasProp('type')) {
        isQris = false;
    } else {
        isQris = existing ? Boolean(existing.is_qris) : false;
    }

    return {
        data: {
            code,
            name,
            type,
            account_number: acctNumRes.value,
            account_name: acctNameRes.value,
            qris_image_url: qrisUrlRes.value,
            instructions: instrRes.value,
            is_qris: isQris,
            min_amount: minAmount,
            is_active: parsedActive,
            sort_order: sortOrder
        }
    };
}

/**
 * Daftarkan route admin untuk manajemen metode pembayaran (CRUD).
 */
module.exports = function createAdminPaymentMethodsRoutes(deps) {
    const {
        pool,
        protectAdmin,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminPaymentMethodsRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminPaymentMethodsRoutes requires a protectAdmin middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminPaymentMethodsRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    router.get('/api/admin/payment-methods', protectAdmin, async (req, res) => {
        try {
            const sql = `SELECT id, code, name, type, account_number, account_name,
                                qris_image_url, instructions, is_qris, min_amount,
                                is_active, sort_order, created_at, updated_at
                         FROM payment_methods
                         ORDER BY sort_order ASC, id ASC`;
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            console.error('Error fetching admin payment methods:', error);
            res.status(500).json({ message: 'Gagal memuat daftar metode pembayaran.' });
        }
    });

    router.post('/api/admin/payment-methods', protectAdmin, async (req, res) => {
        const validated = normalizePaymentMethodPayload(req.body);
        if (validated.error) {
            return res.status(400).json({ message: validated.error });
        }
        const pm = validated.data;
        try {
            const sql = `INSERT INTO payment_methods (
                             code, name, type, account_number, account_name,
                             qris_image_url, instructions, is_qris, min_amount,
                             is_active, sort_order
                         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                         RETURNING id, code, name, type, account_number, account_name,
                                   qris_image_url, instructions, is_qris, min_amount,
                                   is_active, sort_order, created_at, updated_at`;
            const params = [
                pm.code, pm.name, pm.type, pm.account_number, pm.account_name,
                pm.qris_image_url, pm.instructions, pm.is_qris, pm.min_amount,
                pm.is_active, pm.sort_order
            ];
            const { rows } = await pool.query(sql, params);
            const createdMethod = rows && rows[0] ? rows[0] : pm;
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.payment_method.create',
                targetType: 'payment_method',
                targetId: createdMethod && createdMethod.id ? String(createdMethod.id) : pm.code,
                beforeData: null,
                afterData: createdMethod,
            });
            res.status(201).json({
                message: 'Metode pembayaran berhasil ditambahkan.',
                paymentMethod: rows[0]
            });
        } catch (error) {
            if (error && error.code === '23505') {
                return res.status(409).json({ message: 'Kode metode pembayaran sudah digunakan.' });
            }
            console.error('Error creating payment method:', error);
            res.status(500).json({ message: 'Gagal menambahkan metode pembayaran.' });
        }
    });

    router.put('/api/admin/payment-methods/:id', protectAdmin, async (req, res) => {
        const methodId = parseInt(req.params.id, 10);
        if (!Number.isInteger(methodId) || methodId <= 0) {
            return res.status(400).json({ message: 'ID metode pembayaran tidak valid.' });
        }
        try {
            const existingRes = await pool.query('SELECT * FROM payment_methods WHERE id = $1 LIMIT 1', [methodId]);
            if (!existingRes || !existingRes.rows || existingRes.rows.length === 0) {
                return res.status(404).json({ message: 'Metode pembayaran tidak ditemukan.' });
            }
            const validated = normalizePaymentMethodPayload(req.body, existingRes.rows[0]);
            if (validated.error) {
                return res.status(400).json({ message: validated.error });
            }
            const pm = validated.data;
            const sql = `UPDATE payment_methods
                         SET code = $1,
                             name = $2,
                             type = $3,
                             account_number = $4,
                             account_name = $5,
                             qris_image_url = $6,
                             instructions = $7,
                             is_qris = $8,
                             min_amount = $9,
                             is_active = $10,
                             sort_order = $11,
                             updated_at = NOW()
                         WHERE id = $12
                         RETURNING id, code, name, type, account_number, account_name,
                                   qris_image_url, instructions, is_qris, min_amount,
                                   is_active, sort_order, created_at, updated_at`;
            const params = [
                pm.code, pm.name, pm.type, pm.account_number, pm.account_name,
                pm.qris_image_url, pm.instructions, pm.is_qris, pm.min_amount,
                pm.is_active, pm.sort_order, methodId
            ];
            const { rows } = await pool.query(sql, params);
            const updatedMethod = rows && rows[0] ? rows[0] : pm;
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.payment_method.update',
                targetType: 'payment_method',
                targetId: String(methodId),
                beforeData: existingRes.rows[0],
                afterData: updatedMethod,
            });
            res.json({
                message: 'Metode pembayaran berhasil diperbarui.',
                paymentMethod: rows[0]
            });
        } catch (error) {
            if (error && error.code === '23505') {
                return res.status(409).json({ message: 'Kode metode pembayaran sudah digunakan.' });
            }
            console.error('Error updating payment method:', error);
            res.status(500).json({ message: 'Gagal memperbarui metode pembayaran.' });
        }
    });

    router.delete('/api/admin/payment-methods/:id', protectAdmin, async (req, res) => {
        const methodId = parseInt(req.params.id, 10);
        if (!Number.isInteger(methodId) || methodId <= 0) {
            return res.status(400).json({ message: 'ID metode pembayaran tidak valid.' });
        }
        try {
            const { rows } = await pool.query('DELETE FROM payment_methods WHERE id = $1 RETURNING id, name', [methodId]);
            if (!rows || rows.length === 0) {
                return res.status(404).json({ message: 'Metode pembayaran tidak ditemukan.' });
            }
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.payment_method.delete',
                targetType: 'payment_method',
                targetId: String(methodId),
                beforeData: rows[0],
                afterData: { deleted: true },
            });
            res.json({ message: `Metode pembayaran "${rows[0].name}" berhasil dihapus.` });
        } catch (error) {
            console.error('Error deleting payment method:', error);
            res.status(500).json({ message: 'Gagal menghapus metode pembayaran.' });
        }
    });

    return router;
};
