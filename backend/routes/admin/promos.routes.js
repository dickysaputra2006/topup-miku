const express = require('express');
const { logSafeError } = require('../../utils/logger');
const {
    getBodyObject,
    requireString,
    optionalTrimmedString,
    requirePositiveInt,
    optionalPositiveInt,
    requireBoundedNumber,
    requireBoolean,
    requireEnum,
    requireValidDate,
    validatePromoRulesObject,
} = require('../../utils/schemaValidators');

const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

/**
 * Daftarkan route admin untuk manajemen kode promo.
 */
module.exports = function createAdminPromosRoutes(deps) {
    const {
        pool,
        protectAdmin,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createAdminPromosRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminPromosRoutes requires a protectAdmin middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminPromosRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    router.post('/api/admin/promos', protectAdmin, async (req, res) => {
        try {
            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const codeRes = requireString(body.code, 'Kode promo', {
                min: 2,
                max: 50,
                uppercase: true,
                pattern: /^[A-Z0-9_-]{2,50}$/,
                patternMessage: 'Kode promo hanya boleh berisi huruf, angka, _ atau - (2-50 karakter).',
            });
            if (codeRes.error) return res.status(400).json({ message: codeRes.error });

            const descRes = optionalTrimmedString(body.description, 'Deskripsi promo', { max: 500 });
            if (descRes.error) return res.status(400).json({ message: descRes.error });

            const typeRes = requireEnum(body.type, 'Tipe promo', ['percentage', 'fixed']);
            if (typeRes.error) return res.status(400).json({ message: typeRes.error });

            const valueBounds = typeRes.value === 'percentage'
                ? { min: 0.01, max: 100 }
                : { min: 1, max: 100000000 };
            const valueRes = requireBoundedNumber(body.value, 'Nilai diskon promo', valueBounds);
            if (valueRes.error) return res.status(400).json({ message: valueRes.error });

            let expiresAt = null;
            if (body.expires_at !== undefined && body.expires_at !== null && String(body.expires_at).trim() !== '') {
                const expRes = requireValidDate(body.expires_at, 'Tanggal kedaluwarsa promo');
                if (expRes.error) return res.status(400).json({ message: expRes.error });
                expiresAt = expRes.value;
            }

            const maxUsesRes = optionalPositiveInt(body.max_uses, 'Maksimal penggunaan promo', { min: 1, max: 1000000 });
            if (maxUsesRes.error) return res.status(400).json({ message: maxUsesRes.error });

            const rulesRes = validatePromoRulesObject(body.rules);
            if (rulesRes.error) return res.status(400).json({ message: rulesRes.error });

            const sql = `INSERT INTO promo_codes (code, description, type, value, expires_at, rules, max_uses) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
            const { rows } = await pool.query(sql, [
                codeRes.value,
                descRes.value,
                typeRes.value,
                valueRes.value,
                expiresAt,
                rulesRes.value,
                maxUsesRes.value,
            ]);
            const createdPromo = rows[0];
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.promo.create',
                targetType: 'promo',
                targetId: createdPromo && createdPromo.id != null ? String(createdPromo.id) : codeRes.value,
                afterData: {
                    code: codeRes.value,
                    type: typeRes.value,
                    value: valueRes.value,
                    max_uses: maxUsesRes.value,
                    expires_at: expiresAt,
                    rules: rulesRes.value,
                },
            });
            res.status(201).json(createdPromo);
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ message: 'Kode promo sudah ada.' });
            logSafeError('Gagal membuat kode promo:', error);
            res.status(500).json({ message: 'Gagal membuat kode promo.' });
        }
    });

    // Endpoint untuk melihat semua kode promo
    router.get('/api/admin/promos', protectAdmin, async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
            res.json(rows);
        } catch (error) {
            logSafeError('Gagal mengambil data promo:', error);
            res.status(500).json({ message: 'Gagal mengambil data promo.' });
        }
    });

    // Endpoint untuk menonaktifkan/mengaktifkan promo
    router.put('/api/admin/promos/:id/toggle', protectAdmin, async (req, res) => {
        try {
            const idRes = requirePositiveInt(req.params.id, 'ID promo');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });

            const activeRes = requireBoolean(bodyRes.value.is_active, 'is_active');
            if (activeRes.error) return res.status(400).json({ message: activeRes.error });

            const sql = 'UPDATE promo_codes SET is_active = $1 WHERE id = $2 RETURNING *';
            const { rows } = await pool.query(sql, [activeRes.value, idRes.value]);
            if (rows.length === 0) return res.status(404).json({ message: 'Kode promo tidak ditemukan.' });
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.promo.toggle',
                targetType: 'promo',
                targetId: String(idRes.value),
                beforeData: { is_active: !activeRes.value },
                afterData: { code: rows[0].code, is_active: activeRes.value },
            });
            res.json(rows[0]);
        } catch (error) {
            logSafeError('Gagal mengubah status promo:', error);
            res.status(500).json({ message: 'Gagal mengubah status promo.' });
        }
    });

    return router;
};
