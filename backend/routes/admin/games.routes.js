const express = require('express');
const axios = require('axios');

/**
 * Daftarkan route admin untuk manajemen game, role margin global, tes endpoint, dan preview layanan validasi PGS.
 */
module.exports = function createAdminGamesRoutes(deps) {
    const { pool, protectAdmin } = deps || {};
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('createAdminGamesRoutes requires a valid pool');
    }
    if (typeof protectAdmin !== 'function') {
        throw new TypeError('createAdminGamesRoutes requires a protectAdmin middleware');
    }

    const router = express.Router();

    router.get('/api/admin/roles', protectAdmin, async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM roles ORDER BY id ASC');
            res.json(rows);
        } catch (error) {
            console.error('Error fetching roles:', error);
            res.status(500).json({ message: 'Gagal mengambil data roles.' });
        }
    });

    router.put('/api/admin/roles', protectAdmin, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const margins = req.body;
            if (!Array.isArray(margins)) throw new Error('Format data tidak valid.');
            if (margins.length > 0) {
                await client.query(`
                    UPDATE roles AS r
                    SET margin_percent = d.margin::numeric
                    FROM jsonb_to_recordset($1::jsonb) AS d(id int, margin numeric)
                    WHERE r.id = d.id
                `, [JSON.stringify(margins)]);
            }
            await client.query('COMMIT');
            res.json({ message: 'Margin berhasil diperbarui.' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating roles margin:', error);
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
            console.error('Error fetching admin games:', error);
            res.status(500).json({ message: 'Server error saat mengambil data game.' });
        }
    });

    router.post('/api/admin/games', protectAdmin, async (req, res) => {
        try {
            const { name, category, imageUrl } = req.body;
            if (!name || !category || !imageUrl) return res.status(400).json({ message: 'Semua kolom wajib diisi.' });
            const sql = 'INSERT INTO games (name, category, image_url, status, needs_server_id) VALUES ($1, $2, $3, $4, $5)'; // Tambah status & needs_server_id
            await pool.query(sql, [name, category, imageUrl, 'Active', false]); // Default nilai
            res.status(201).json({ message: `Game ${name} berhasil ditambahkan.` });
        } catch (error) {
            console.error('Error adding game:', error);
            if (error.code === '23505') return res.status(409).json({ message: 'Game dengan nama ini sudah ada.' });
            res.status(500).json({ message: 'Server error saat menambah game.' });
        }
    });

    router.put('/api/admin/games/:id/status', protectAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            if (!status || (status !== 'Active' && status !== 'Inactive')) {
                return res.status(400).json({ message: "Status tidak valid. Gunakan 'Active' atau 'Inactive'." });
            }

            const { rowCount } = await pool.query(
                'UPDATE games SET status = $1 WHERE id = $2',
                [status, id]
            );

            if (rowCount === 0) {
                return res.status(404).json({ message: 'Game tidak ditemukan.' });
            }

            res.json({ message: `Status game berhasil diubah menjadi ${status}.` });

        } catch (error) {
            console.error('Error updating game status:', error);
            res.status(500).json({ message: 'Gagal memperbarui status game.' });
        }
    });

    router.put('/api/admin/games/:id/needs-server', protectAdmin, async (req, res) => {
        try {
            const { id } = req.params;
            const { needsServer } = req.body; // Menerima nilai boolean (true/false)

            if (typeof needsServer !== 'boolean') {
                return res.status(400).json({ message: "Nilai 'needsServer' harus boolean." });
            }

            const { rowCount } = await pool.query(
                'UPDATE games SET needs_server_id = $1 WHERE id = $2',
                [needsServer, id]
            );

            if (rowCount === 0) {
                return res.status(404).json({ message: 'Game tidak ditemukan.' });
            }

            res.json({ message: `Pengaturan 'Perlu Server' untuk game berhasil diubah.` });

        } catch (error) {
            console.error('Error updating game needs_server_id:', error);
            res.status(500).json({ message: 'Gagal memperbarui pengaturan game.' });
        }
    });

    router.post('/api/test', (req, res) => {
        console.log('SUKSES: Rute /api/test diakses dengan metode POST.');
        res.status(200).json({ message: 'Halo! Rute tes POST ini berfungsi!' });
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
            console.warn('[pgs-preview] Gagal mengambil service PGS:', err && err.message);
            res.status(502).json({ message: 'Gagal mengambil data dari PGS. Coba lagi nanti.' });
        }
    });

    return router;
};
