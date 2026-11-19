const express = require('express');
const axios = require('axios');
const { logSafeError } = require('../../utils/logger');
const { isSafeAssetUrl } = require('../../utils/validation');
const {
    getBodyObject,
    requirePlainObject,
    requireString,
    requirePositiveInt,
    requireBoundedNumber,
    requireBoolean,
    requireEnum,
} = require('../../utils/schemaValidators');
const {
    recordAdminAuditLog: defaultRecordAdminAuditLog,
} = require('../../services/auditLogService');

/**
 * Daftarkan route admin untuk manajemen game, role margin global, tes endpoint, dan preview layanan validasi PGS.
 */
module.exports = function createAdminGamesRoutes(deps) {
    const {
        pool,
        protectAdmin,
        recordAdminAuditLog = defaultRecordAdminAuditLog,
    } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAdminGamesRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminGamesRoutes requires a protectAdmin middleware');
    }
    if (typeof recordAdminAuditLog !== 'function') {
        throw new TypeError('createAdminGamesRoutes requires a recordAdminAuditLog function');
    }

    const router = express.Router();

    router.get('/api/admin/roles', protectAdmin, async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM roles ORDER BY id ASC');
            res.json(rows);
        } catch (error) {
            logSafeError('Error fetching roles:', error);
            res.status(500).json({ message: 'Gagal mengambil data roles.' });
        }
    });

    router.put('/api/admin/roles', protectAdmin, async (req, res) => {
        if (!Array.isArray(req.body) || req.body.length > 50) {
            return res.status(400).json({ message: 'Format data role margin tidak valid.' });
        }
        const safeMargins = [];
        for (const item of req.body) {
            const objRes = requirePlainObject(item, 'Item role');
            if (objRes.error) return res.status(400).json({ message: objRes.error });

            const idRes = requirePositiveInt(item.id, 'ID role');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            const marginRes = requireBoundedNumber(item.margin, 'Margin role', { min: 0, max: 500 });
            if (marginRes.error) return res.status(400).json({ message: marginRes.error });

            safeMargins.push({ id: idRes.value, margin: marginRes.value });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (safeMargins.length > 0) {
                await client.query(`
                    UPDATE roles AS r
                    SET margin_percent = d.margin::numeric
                    FROM jsonb_to_recordset($1::jsonb) AS d(id int, margin numeric)
                    WHERE r.id = d.id
                `, [JSON.stringify(safeMargins)]);
            }
            await client.query('COMMIT');
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.roles.update',
                targetType: 'roles',
                targetId: 'global',
                beforeData: null,
                afterData: { margins: safeMargins },
            });
            res.json({ message: 'Margin berhasil diperbarui.' });
        } catch (error) {
            await client.query('ROLLBACK');
            logSafeError('Error updating roles margin:', error);
            res.status(500).json({ message: 'Gagal memperbarui margin.' });
        } finally {
            client.release();
        }
    });

    router.get('/api/admin/games', protectAdmin, async (req, res) => {
        try {
            const sql = "SELECT * FROM games ORDER BY name ASC";
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            logSafeError('Error fetching admin games:', error);
            res.status(500).json({ message: 'Server error saat mengambil data game.' });
        }
    });

    router.post('/api/admin/games', protectAdmin, async (req, res) => {
        try {
            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });
            const body = bodyRes.value;

            const nameRes = requireString(body.name, 'Nama game', { min: 1, max: 120 });
            if (nameRes.error) return res.status(400).json({ message: nameRes.error });

            const categoryRes = requireString(body.category, 'Kategori game', { min: 1, max: 80 });
            if (categoryRes.error) return res.status(400).json({ message: categoryRes.error });

            const imageUrlRes = requireString(body.imageUrl, 'URL gambar game', { min: 1, max: 1000 });
            if (imageUrlRes.error) return res.status(400).json({ message: imageUrlRes.error });

            const name = nameRes.value;
            const category = categoryRes.value;
            const imageUrl = imageUrlRes.value;

            if (!isSafeAssetUrl(imageUrl, { allowEmpty: false })) {
                return res.status(400).json({
                    message: 'URL gambar game tidak valid. Gunakan URL HTTPS publik yang aman atau path /...'
                });
            }
            const sql = 'INSERT INTO games (name, category, image_url, status, needs_server_id) VALUES ($1, $2, $3, $4, $5)'; // Tambah status & needs_server_id
            await pool.query(sql, [name, category, imageUrl, 'Active', false]); // Default nilai
            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.game.create',
                targetType: 'game',
                targetId: String(name),
                beforeData: null,
                afterData: { name, category, imageUrl, status: 'Active', needs_server_id: false },
            });
            res.status(201).json({ message: `Game ${name} berhasil ditambahkan.` });
        } catch (error) {
            logSafeError('Error adding game:', error);
            if (error.code === '23505') return res.status(409).json({ message: 'Game dengan nama ini sudah ada.' });
            res.status(500).json({ message: 'Server error saat menambah game.' });
        }
    });

    router.put('/api/admin/games/:id/status', protectAdmin, async (req, res) => {
        try {
            const idRes = requirePositiveInt(req.params.id, 'ID game');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });

            const statusRes = requireEnum(bodyRes.value.status, 'Status', ['Active', 'Inactive']);
            if (statusRes.error) {
                return res.status(400).json({ message: "Status tidak valid. Gunakan 'Active' atau 'Inactive'." });
            }

            const id = idRes.value;
            const status = statusRes.value;

            const prevRes = await pool.query('SELECT status FROM games WHERE id = $1 LIMIT 1', [id]).catch(() => ({ rows: [] }));
            const { rowCount } = await pool.query(
                'UPDATE games SET status = $1 WHERE id = $2',
                [status, id]
            );

            if (rowCount === 0) {
                return res.status(404).json({ message: 'Game tidak ditemukan.' });
            }

            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.game.status',
                targetType: 'game',
                targetId: String(id),
                beforeData: prevRes && prevRes.rows && prevRes.rows[0] ? { status: prevRes.rows[0].status } : null,
                afterData: { status },
            });

            res.json({ message: `Status game berhasil diubah menjadi ${status}.` });

        } catch (error) {
            logSafeError('Error updating game status:', error);
            res.status(500).json({ message: 'Gagal memperbarui status game.' });
        }
    });

    router.put('/api/admin/games/:id/needs-server', protectAdmin, async (req, res) => {
        try {
            const idRes = requirePositiveInt(req.params.id, 'ID game');
            if (idRes.error) return res.status(400).json({ message: idRes.error });

            const bodyRes = getBodyObject(req);
            if (bodyRes.error) return res.status(400).json({ message: bodyRes.error });

            const needsRes = requireBoolean(bodyRes.value.needsServer, 'needsServer');
            if (needsRes.error) {
                return res.status(400).json({ message: "Nilai 'needsServer' harus boolean." });
            }

            const id = idRes.value;
            const needsServer = needsRes.value;

            const prevRes = await pool.query('SELECT needs_server_id FROM games WHERE id = $1 LIMIT 1', [id]).catch(() => ({ rows: [] }));
            const { rowCount } = await pool.query(
                'UPDATE games SET needs_server_id = $1 WHERE id = $2',
                [needsServer, id]
            );

            if (rowCount === 0) {
                return res.status(404).json({ message: 'Game tidak ditemukan.' });
            }

            await recordAdminAuditLog(pool, {
                req,
                action: 'admin.game.needs_server',
                targetType: 'game',
                targetId: String(id),
                beforeData: prevRes && prevRes.rows && prevRes.rows[0]
                    ? { needs_server_id: prevRes.rows[0].needs_server_id }
                    : null,
                afterData: { needs_server_id: needsServer },
            });

            res.json({ message: `Pengaturan 'Perlu Server' untuk game berhasil diubah.` });

        } catch (error) {
            logSafeError('Error updating game needs_server_id:', error);
            res.status(500).json({ message: 'Gagal memperbarui pengaturan game.' });
        }
    });

    // Preview daftar service PGS terbaru (tidak menulis file)
    router.get('/api/admin/validation-services/pgs-preview', protectAdmin, async (req, res) => {
        const pgsKey = process.env.PGS_KEY;
        const pgsApiKey = process.env.PGS_API_KEY;
        if (!pgsKey || !pgsApiKey) {
            return res.status(503).json({ message: 'PGS API Key belum dikonfigurasi di server.' });
        }
        try {
            const response = await axios.post(
                'https://pgscode.id/api/tools/run',
                { key: pgsKey, api_key: pgsApiKey, action: 'get-service' },
                { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
            );
            const rawData = response.data;
            // Jangan forward key/api_key ke frontend — hanya kirim data service
            const services = rawData && rawData.data ? rawData.data : rawData;
            res.json({
                message: 'Preview daftar service PGS berhasil diambil. Data ini hanya untuk referensi, tidak disimpan otomatis.',
                count: Array.isArray(services) ? services.length : null,
                data: services
            });
        } catch (err) {
            logSafeError('[pgs-preview] Gagal mengambil service PGS:', err);
            res.status(502).json({ message: 'Gagal mengambil data dari PGS. Coba lagi nanti.' });
        }
    });

    return router;
};
