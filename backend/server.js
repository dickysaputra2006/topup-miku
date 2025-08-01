require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const { syncProductsWithFoxy } = require('./utils/cronUtils.js');
const { validateGameId } = require('./utils/validators/cek-id-game.js');
const { checkAllMobapayPromosML } = require('./utils/validators/stalk-ml-promo.js');
const { cekPromoMcggMobapay } = require('./utils/validators/stalk-mcgg.js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// === KONFIGURASI FOXY API ===
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY;

// Middleware (HARUS DI ATAS SEMUA RUTE)
app.use(cors());
app.use(express.json());
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
};
const pool = new Pool(dbConfig);

// === AUTH ENDPOINTS ===
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, username, email, nomorWa, password } = req.body;
        if (!fullName || !username || !email || !nomorWa || !password) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const { rows: bronzeRole } = await pool.query("SELECT id FROM roles WHERE name = 'BRONZE'");
        let defaultRoleId = 1;
        if (bronzeRole.length > 0) {
            defaultRoleId = bronzeRole[0].id;
        }
        const sql = 'INSERT INTO users (full_name, username, email, nomor_wa, password, role_id) VALUES ($1, $2, $3, $4, $5, $6)';
        await pool.query(sql, [fullName, username, email, nomorWa, hashedPassword, defaultRoleId]);
        res.status(201).json({ message: 'Registrasi berhasil! Silakan login.' });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Username atau Email sudah digunakan.' });
        console.error('Error during registration:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Input tidak boleh kosong.' });
        const sql = 'SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = $1 OR u.email = $2';
        const { rows } = await pool.query(sql, [username, username]);
        if (rows.length === 0) return res.status(401).json({ message: 'Username atau password salah.' });
        const user = rows[0];
        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) return res.status(401).json({ message: 'Username atau password salah.' });
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role_name }, JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ message: 'Login berhasil!', token });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});

// === MIDDLEWARE ===
const protect = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Akses ditolak, tidak ada token.' });
    try {
        const token = authHeader.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        res.status(401).json({ message: 'Token tidak valid.' });
    }
};

const protectAdmin = (req, res, next) => {
    protect(req, res, () => {
        if (req.user && req.user.role === 'Admin') {
            next();
        } else {
            res.status(403).json({ message: 'Akses ditolak: Hanya untuk Admin.' });
        }
    });
};

const softProtect = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const token = authHeader.split(' ')[1];
            req.user = jwt.verify(token, JWT_SECRET);
        } catch (error) {
            req.user = null;
        }
    } else {
        req.user = null;
    }
    next();
};

const protectH2H = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ success: false, message: 'API Key tidak ditemukan di header X-API-Key.' });
    }
    try {
        
        const sql = `
            SELECT u.*, r.name as role_name 
            FROM users u 
            JOIN roles r ON u.role_id = r.id 
            WHERE u.api_key = $1`;
        const { rows } = await pool.query(sql, [apiKey]);

        if (rows.length === 0) {
            return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
        }
        req.user = rows[0];
        next();
    } catch (error) {
        console.error('H2H Auth Error:', error);
        res.status(500).json({ success: false, message: 'Server error saat validasi API Key.' });
    }
};

async function createNotification(userId, message, link = null) {
    try {
        const sql = 'INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)';
        await pool.query(sql, [userId, message, link]);
        console.log(`Notifikasi dibuat untuk user ${userId}: "${message}"`);
    } catch (error) {
        console.error(`Gagal membuat notifikasi untuk user ${userId}:`, error);
    }
}

// === USER ENDPOINTS ===
app.get('/api/user/profile', protect, async (req, res) => {
    try {
        const sql = 'SELECT u.id, u.full_name, u.username, u.email, u.nomor_wa, u.balance, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1';
        const { rows } = await pool.query(sql, [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.put('/api/user/profile', protect, async (req, res) => {
    try {
        const { fullName, email, nomorWa } = req.body;
        if (!fullName || !email || !nomorWa) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const sql = 'UPDATE users SET full_name = $1, email = $2, nomor_wa = $3 WHERE id = $4';
        await pool.query(sql, [fullName, email, nomorWa, req.user.id]);
        res.json({ message: 'Profil berhasil diperbarui.' });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Email sudah digunakan oleh akun lain.' });
        console.error('Error updating user profile:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.put('/api/user/password', protect, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const sqlSelect = 'SELECT password FROM users WHERE id = $1';
        const { rows } = await pool.query(sqlSelect, [req.user.id]);
        const user = rows[0];
        const isPasswordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isPasswordMatch) return res.status(401).json({ message: 'Password saat ini salah.' });
        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        const sqlUpdate = 'UPDATE users SET password = $1 WHERE id = $2';
        await pool.query(sqlUpdate, [hashedNewPassword, req.user.id]);
        res.json({ message: 'Password berhasil diubah.' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/api/user/balance-history', protect, async (req, res) => {
    try {
        // PostgreSQL: Menggunakan created_at sebagai timestamp
        const sql = `SELECT amount, type, description, reference_id, created_at FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC`;
        const { rows } = await pool.query(sql, [req.user.id]);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching balance history:', error);
        res.status(500).json({ message: 'Server error saat mengambil riwayat saldo.' });
    }
});
app.post('/api/user/generate-apikey', protect, async (req, res) => {
    try {
        const newApiKey = crypto.randomBytes(24).toString('hex');
        await pool.query('UPDATE users SET api_key = $1 WHERE id = $2', [newApiKey, req.user.id]);
        res.json({ message: 'API Key baru berhasil dibuat! Harap simpan di tempat aman.', apiKey: newApiKey });
    } catch (error) {
        console.error('Error generating API key:', error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/api/user/apikey', protect, async (req, res) => {
    try {
        const sql = 'SELECT api_key FROM users WHERE id = $1';
        const { rows } = await pool.query(sql, [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
        res.json({ apiKey: rows[0].api_key });
    } catch (error) {
        console.error('Error fetching API key:', error);
        res.status(500).json({ message: 'Server error saat mengambil API key.' });
    }
});
app.get('/api/user/transactions', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const sql = `
            SELECT 
                t.invoice_id, 
                t.target_game_id,              t.price, 
                t.status, 
                t.created_at, 
                p.name as product_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            WHERE t.user_id = $1
            ORDER BY t.created_at DESC
        `;
        const { rows } = await pool.query(sql, [userId]);
        res.json(rows);
    } catch (error) {
        console.error("Gagal mengambil riwayat transaksi pengguna:", error);
        res.status(500).json({ message: 'Server error saat mengambil riwayat transaksi pengguna.' });
    }
});
app.get('/api/user/transaction/:invoiceId', protect, async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const userId = req.user.id;

        // Query ini menggabungkan 3 tabel untuk mendapatkan semua detail
        const sql = `
            SELECT
                t.invoice_id,
                t.status,
                t.created_at,
                t.price,
                t.target_game_id,
                t.provider_sn,
                p.name as product_name,
                g.category as game_category,
                g.name as game_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN games g ON p.game_id = g.id
            WHERE t.invoice_id = $1 AND t.user_id = $2
        `;
        const { rows } = await pool.query(sql, [invoiceId, userId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Transaksi tidak ditemukan atau bukan milik Anda.' });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error("Gagal mengambil detail transaksi:", error);
        res.status(500).json({ message: 'Server error saat mengambil detail transaksi.' });
    }
});
app.get('/api/user/transaction-summary', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const sql = `
            SELECT 
                COALESCE(SUM(CASE WHEN status = 'Success' THEN 1 ELSE 0 END), 0) AS berhasil,
                COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END), 0) AS gagal
            FROM transactions 
            WHERE user_id = $1;
        `;
        const { rows } = await pool.query(sql, [userId]);
        res.json(rows[0]);
    } catch (error) {
        console.error("Gagal mengambil ringkasan transaksi:", error);
        res.status(500).json({ message: 'Server error saat mengambil ringkasan transaksi.' });
    }
});
// Endpoint untuk mengambil notifikasi pengguna
app.get('/api/user/notifications', protect, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', 
            [req.user.id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil notifikasi.' });
    }
});

// Endpoint untuk menghitung notifikasi yang belum dibaca
app.get('/api/user/notifications/unread-count', protect, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false', 
            [req.user.id]
        );
        res.json({ count: parseInt(rows[0].count, 10) });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menghitung notifikasi.' });
    }
});

// Endpoint untuk menandai semua notifikasi sebagai sudah dibaca
app.post('/api/user/notifications/mark-as-read', protect, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
        res.status(200).json({ message: 'Semua notifikasi ditandai terbaca.' });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menandai notifikasi.' });
    }
});

// === DEPOSIT ENDPOINTS ===
app.post('/api/deposit/request', protect, async (req, res) => {
    const client = await pool.connect(); // Menggunakan client dari pool untuk transaksi
    try {
        await client.query('BEGIN'); // Memulai transaksi
        const { amount } = req.body;
        const userId = req.user.id;
        if (!amount || isNaN(amount) || amount <= 0) throw new Error('Jumlah deposit tidak valid.');
        const uniqueCode = Math.floor(Math.random() * 900) + 100;
        const totalAmount = parseInt(amount) + uniqueCode;
        // PostgreSQL: RETURNING id untuk mendapatkan ID yang di-generate
        const sql = 'INSERT INTO deposits (user_id, amount, unique_code, status) VALUES ($1, $2, $3, $4) RETURNING id';
        const { rows } = await client.query(sql, [userId, totalAmount, uniqueCode, 'Pending']);
        const depositId = rows[0].id; // Ambil ID dari hasil RETURNING

        await client.query('COMMIT'); // Commit transaksi
        res.status(201).json({
            message: 'Permintaan deposit berhasil dibuat.',
            deposit: { id: depositId, amount: totalAmount, paymentInstructions: `Silakan transfer sejumlah Rp ${new Intl.NumberFormat('id-ID').format(totalAmount)} ke rekening Bank ABC 123-456-7890 a/n GameStore.` }
        });
    } catch (error) {
        await client.query('ROLLBACK'); // Rollback transaksi jika ada error
        console.error('Error creating deposit request:', error);
        res.status(500).json({ message: error.message || 'Terjadi kesalahan pada server saat membuat permintaan deposit.' });
    } finally {
        client.release(); // Pastikan koneksi dikembalikan ke pool
    }
});

// === ADMIN ENDPOINTS ===
app.get('/api/admin/deposits/pending', protectAdmin, async (req, res) => {
    try {
        const sql = `SELECT d.id, u.username, d.amount, d.created_at FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'Pending' ORDER BY d.created_at ASC`;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching pending deposits:', error);
        res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
    }
});
app.post('/api/admin/deposits/approve', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { depositId } = req.body;
        if (!depositId) throw new Error('Deposit ID tidak boleh kosong.');
        // PostgreSQL: FOR UPDATE kunci baris yang sedang diproses
        const { rows } = await client.query('SELECT * FROM deposits WHERE id = $1 AND status = \'Pending\' FOR UPDATE', [depositId]);
        if (rows.length === 0) throw new Error('Deposit tidak ditemukan atau sudah diproses.');
        const deposit = rows[0];
        await client.query('UPDATE deposits SET status = \'Success\' WHERE id = $1', [depositId]);
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [deposit.amount, deposit.user_id]);
        const historyDesc = `Deposit #${deposit.id} disetujui`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [deposit.user_id, deposit.amount, 'Deposit', historyDesc, `DEPOSIT-${deposit.id}`]);
        await client.query('COMMIT');
        await createNotification(deposit.user_id, `Deposit sebesar Rp ${deposit.amount.toLocaleString('id-ID')} telah disetujui dan masuk ke saldo.`);
        res.json({ message: `Deposit #${depositId} berhasil disetujui.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving deposit:', error);
        res.status(500).json({ message: error.message || 'Gagal menyetujui deposit.' });
    } finally {
        client.release();
    }
});
app.post('/api/admin/balance/add', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { username, amount, description } = req.body;
        if (!username || !amount || !description || isNaN(amount) || amount <= 0) throw new Error('Input tidak valid.');
        const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
        if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = rows[0];
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [parseInt(amount), user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [user.id, parseInt(amount), 'Deposit', description, `ADMIN_ADD-${Date.now()}`]);
        await client.query('COMMIT');
        res.json({ message: `Saldo sebesar ${amount} berhasil ditambahkan ke akun ${username}.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding balance manually:', error);
        res.status(500).json({ message: error.message || 'Gagal menambah saldo.' });
    } finally {
        client.release();
    }
});
app.post('/api/admin/balance/reduce', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { username, amount, description } = req.body;
        if (!username || !amount || !description || isNaN(amount) || amount <= 0) throw new Error('Input tidak valid.');
        const { rows } = await client.query('SELECT id, balance FROM users WHERE username = $1 OR email = $2 FOR UPDATE', [username, username]);
        if (rows.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = rows[0];
        if (user.balance < amount) throw new Error('Saldo pengguna tidak mencukupi untuk dikurangi.');
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [user.id, -amount, 'Refund', description, `ADMIN_REDUCE-${Date.now()}`]);
        await client.query('COMMIT');
        res.json({ message: `Saldo akun ${username} berhasil dikurangi sebesar ${amount}.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reducing balance manually:', error);
        res.status(500).json({ message: error.message || 'Gagal mengurangi saldo.' });
    } finally {
        client.release();
    }
});
app.get('/api/admin/roles', protectAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM roles ORDER BY id ASC');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching roles:', error);
        res.status(500).json({ message: 'Gagal mengambil data roles.' });
    }
});
app.put('/api/admin/roles', protectAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const margins = req.body;
        if (!Array.isArray(margins)) throw new Error('Format data tidak valid.');
        for (const item of margins) {
            await client.query('UPDATE roles SET margin_percent = $1 WHERE id = $2', [item.margin, item.id]);
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
app.get('/api/admin/games', protectAdmin, async (req, res) => {
    try {
        const sql = "SELECT * FROM games ORDER BY name ASC";
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching admin games:', error);
        res.status(500).json({ message: 'Server error saat mengambil data game.' });
    }
});
app.get('/api/admin/products', protectAdmin, async (req, res) => {
    try {
         const sqlProducts = `SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, p.status, g.name as game_name 
                             FROM products p JOIN games g ON p.game_id = g.id 
                             ORDER BY g.name ASC, p.price ASC, p.name ASC`; 
        const { rows: products } = await pool.query(sqlProducts);

        // Ambil semua margin role
        const sqlRoles = `SELECT id, name, margin_percent FROM roles ORDER BY id ASC`;
        const { rows: roles } = await pool.query(sqlRoles);

        const roleMargins = {};
        roles.forEach(role => {
            roleMargins[role.id] = parseFloat(role.margin_percent);
        });

        const productsWithRolePrices = products.map(product => {
            const productWithPrices = { ...product };
            roles.forEach(role => {
                const margin = roleMargins[role.id] || 0;
                const sellingPrice = product.price * (1 + (margin / 100));
                productWithPrices[`price_${role.name.toLowerCase()}`] = Math.ceil(sellingPrice);
            });
            return productWithPrices;
        });

        res.json(productsWithRolePrices);
    } catch (error) {
        console.error('Error fetching admin products with role prices:', error);
        res.status(500).json({ message: 'Server error saat mengambil data produk dengan harga role.' });
    }
});
app.post('/api/admin/games', protectAdmin, async (req, res) => {
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
app.post('/api/admin/products', protectAdmin, async (req, res) => {
    try {
        const { game_id, name, provider_sku, price, category_id } = req.body;
        if (!game_id || !name || !provider_sku || !price || !category_id) return res.status(400).json({ message: 'Semua kolom wajib diisi.' });
        // PostgreSQL: Menggunakan ON CONFLICT DO UPDATE
        const sql = 'INSERT INTO products (game_id, category_id, name, provider_sku, price, status) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_sku) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, game_id = EXCLUDED.game_id, category_id = EXCLUDED.category_id, status = EXCLUDED.status';
        await pool.query(sql, [game_id, category_id, name, provider_sku, price, 'Active']); // Default status
        res.status(201).json({ message: `Produk ${name} berhasil ditambahkan.` });
    } catch (error) {
        console.error('Error adding product:', error);
        if (error.code === '23505') return res.status(409).json({ message: 'SKU Provider sudah ada.' });
        res.status(500).json({ message: 'Server error saat menambah produk.' });
    }
});
app.post('/api/admin/sync-products', protectAdmin, async (req, res) => {
    try {
        const { margin_percent } = req.body; // Menerima margin dari frontend
        if (margin_percent === undefined || isNaN(margin_percent)) {
            return res.status(400).json({ message: 'Persentase margin tidak valid.' });
        }
        
        // Panggil fungsi sinkronisasi dari utilitas, teruskan margin
        // Catatan: Fungsi syncProductsWithFoxy di utilitas perlu menerima margin_percent
        await syncProductsWithFoxy(margin_percent); 
        
        res.json({ message: `Sinkronisasi produk berhasil dipicu dengan margin ${margin_percent}%.` });
    } catch (error) {
        console.error('Manual sync trigger error:', error);
        res.status(500).json({ message: 'Gagal memicu sinkronisasi manual. Cek log server.' });
    }
});
app.get('/api/admin/transactions', protectAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT t.invoice_id, t.target_game_id, t.price, t.status, t.created_at, p.name as product_name, u.username as user_name
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
app.put('/api/admin/products/:id/status', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params; // Ambil ID produk dari URL
        const { status } = req.body; // Ambil status baru dari body request ('Active' atau 'Inactive')

        if (!status || (status !== 'Active' && status !== 'Inactive')) {
            return res.status(400).json({ message: "Status tidak valid. Gunakan 'Active' atau 'Inactive'." });
        }

        const { rowCount } = await pool.query(
            'UPDATE products SET status = $1 WHERE id = $2',
            [status, id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ message: 'Produk tidak ditemukan.' });
        }

        res.json({ message: `Status produk berhasil diubah menjadi ${status}.` });

    } catch (error) {
        console.error('Error updating product status:', error);
        res.status(500).json({ message: 'Gagal memperbarui status produk.' });
    }
});
app.put('/api/admin/games/:id/status', protectAdmin, async (req, res) => {
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
app.put('/api/admin/games/:id/needs-server', protectAdmin, async (req, res) => {
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
app.put('/api/admin/products/:id/validation', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { validation_config } = req.body;
        const { rowCount } = await pool.query('UPDATE products SET validation_config = $1 WHERE id = $2', [validation_config, id]);
        if (rowCount === 0) return res.status(404).json({ message: 'Produk tidak ditemukan.' });
        res.json({ message: 'Pengaturan validasi produk berhasil diperbarui.' });
    } catch (error) {
        console.error('Error updating product validation:', error);
        res.status(500).json({ message: 'Gagal memperbarui pengaturan validasi.' });
    }
});
app.put('/api/admin/products/bulk-validation', protectAdmin, async (req, res) => {
    try {
        const { productIds, validation_config } = req.body;

        if (!Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ message: 'productIds harus berupa array dan tidak boleh kosong.' });
        }

        // Menggunakan query builder dari 'pg' untuk menangani array
        const { rowCount } = await pool.query(
            'UPDATE products SET validation_config = $1 WHERE id = ANY($2::int[])',
            [validation_config, productIds]
        );

        res.json({ message: `Pengaturan validasi berhasil diperbarui untuk ${rowCount} produk.` });
    } catch (error) {
        console.error('Error updating bulk product validation:', error);
        res.status(500).json({ message: 'Gagal memperbarui pengaturan validasi massal.' });
    }
});
app.post('/api/admin/promos', protectAdmin, async (req, res) => {
    // Ambil semua data dari body, termasuk 'rules'
    const { code, description, type, value, expires_at, rules } = req.body;
    try {
        const sql = `INSERT INTO promo_codes (code, description, type, value, expires_at, rules) 
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
        const { rows } = await pool.query(sql, [code.toUpperCase(), description, type, value, expires_at, rules]);
        res.status(201).json(rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Kode promo sudah ada.' });
        console.error("Gagal membuat kode promo:", error);
        res.status(500).json({ message: 'Gagal membuat kode promo.' });
    }
});

// Endpoint untuk melihat semua kode promo
app.get('/api/admin/promos', protectAdmin, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil data promo.' });
    }
});

// Endpoint untuk menonaktifkan/mengaktifkan promo
app.put('/api/admin/promos/:id/toggle', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;
        const sql = 'UPDATE promo_codes SET is_active = $1 WHERE id = $2 RETURNING *';
        const { rows } = await pool.query(sql, [is_active, id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Kode promo tidak ditemukan.' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengubah status promo.' });
    }
});

// Endpoint untuk melihat semua item flash sale di admin panel
app.get('/api/admin/flash-sales', protectAdmin, async (req, res) => {
    try {
        const sql = `
            SELECT 
                fs.*,
                p.name as product_name,
                g.name as game_name
            FROM flash_sales fs
            JOIN products p ON fs.product_id = p.id
            JOIN games g ON p.game_id = g.id
            ORDER BY fs.created_at DESC;
        `;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil data flash sale.' });
    }
});
// Endpoint untuk menambah produk ke flash sale
app.post('/api/admin/flash-sales', protectAdmin, async (req, res) => {
    const { product_id, discount_price, start_at, end_at, max_uses, max_discount_amount } = req.body;
    const rules = max_discount_amount ? { max_discount_amount: parseFloat(max_discount_amount) } : null;

    try {
        const sql = `
            INSERT INTO flash_sales (product_id, discount_price, start_at, end_at, max_uses, rules)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
        `;
        const { rows } = await pool.query(sql, [product_id, discount_price, start_at, end_at, max_uses, rules]);
        res.status(201).json(rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Gagal menambah item flash sale.' });
    }
});
// Endpoint untuk menghapus item dari flash sale
app.delete('/api/admin/flash-sales/:id', protectAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM flash_sales WHERE id = $1', [id]);
        res.status(200).json({ message: 'Item flash sale berhasil dihapus.' });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menghapus item flash sale.' });
    }
});

// === PUBLIC ENDPOINTS ===

app.post('/api/test', (req, res) => {
    console.log('SUKSES: Rute /api/test diakses dengan metode POST.');
    res.status(200).json({ message: 'Halo! Rute tes POST ini berfungsi!' });
});


app.get('/api/games', async (req, res) => {
    try {
        const sql = "SELECT * FROM games WHERE status = 'Active' ORDER BY name ASC";
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching public games:', error);
        res.status(500).json({ message: 'Server error saat mengambil data game.' });
    }
});

app.get('/api/games/validatable', async (req, res) => {
    try {
        // PERBAIKAN FINAL: Membuat path absolut yang pasti benar
        const filePath = path.resolve(__dirname, 'utils', 'validators', 'data_cekid.json');
        const cekIdDataBuffer = await fs.readFile(filePath);
        const cekIdGames = JSON.parse(cekIdDataBuffer.toString());

        const finalResult = cekIdGames.filter(game => game.name).map((game, index) => ({
            id: game.name,
            name: game.name,
            gameCode: game.game,
            hasZoneIdForValidation: game.hasZoneId
        }));

        res.json(finalResult);
    } catch (error) {
        console.error("Error fetching validatable games from JSON:", error);
        res.status(500).json({ message: 'Server error saat mengambil data game dari file.' });
    }
});

// Endpoint baru untuk validasi di halaman produk
app.post('/api/products/:productId/validate', async (req, res) => {
    const { productId } = req.params;
    const { userId, zoneId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID wajib diisi.' });
    try {
        const { rows } = await pool.query('SELECT validation_config FROM products WHERE id = $1', [productId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });
        const config = rows[0].validation_config;
        if (!config || !config.validator) return res.json({ success: true, message: 'Produk ini tidak memerlukan validasi.' });
        const result = await validateGameId(config.validator, userId, zoneId, config.rules || {});
        if (result.success) res.json(result);
        else res.status(400).json({ success: false, message: result.message });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});

// Endpoint baru untuk halaman validasi (yang menampilkan promo)
app.post('/api/full-validate', async (req, res) => {
    const { gameCode, userId, zoneId, rules } = req.body;

    if (!gameCode || !userId) {
        return res.status(400).json({ success: false, message: 'Parameter tidak lengkap.' });
    }

    try {
        let result;

        // --- INI ADALAH LOGIKA YANG SEHARUSNYA ---
        if (gameCode.includes('magic-chess-go-go')) {
            // Logika khusus untuk Magic Chess
            const mcggResult = await cekPromoMcggMobapay(userId, zoneId);
            if (mcggResult.success) {
                result = { 
                    success: true, 
                    data: { 
                        username: mcggResult.nickname, 
                        promo: { doubleDiamond: { items: mcggResult.promoProducts } } 
                    } 
                };
            } else {
                result = mcggResult; // Kembalikan hasil errornya
            }

        } else {
            // Logika untuk semua game lain (termasuk Mobile Legends)
            const pgsResult = await validateGameId(gameCode, userId, zoneId, rules || {});
            if (!pgsResult.success) {
                return res.status(400).json({ success: false, message: pgsResult.message });
            }
            
            result = pgsResult;

            // Jika ini ML, tambahkan data promo
            if (gameCode.includes('mobile-legends-region')) {
                const mobapayResult = await checkAllMobapayPromosML(userId, zoneId);
                result.data.promo = mobapayResult.data;
            }
        }
        // --- AKHIR DARI LOGIKA YANG SEHARUSNYA ---

        res.json(result);

    } catch (error) {
        console.error(`Error validasi lengkap untuk ${gameCode}:`, error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan internal.' });
    }
});

app.get('/api/games/:gameId/products', softProtect, async (req, res) => {
    try {
        const { gameId } = req.params;
        
        // --- AWAL PERBAIKAN LOGIKA MARGIN ---
        let userRoleId = 1; // Atur default ke role ID 1 (misalnya BRONZE) untuk publik

        if (req.user) {
            // Jika pengguna login, ambil role_id mereka
            const { rows: userRows } = await pool.query('SELECT role_id FROM users WHERE id = $1', [req.user.id]);
            if (userRows.length > 0) {
                userRoleId = userRows[0].role_id;
            }
        }

        // Ambil margin berdasarkan role_id yang sudah ditentukan (baik dari pengguna login atau default)
        const { rows: roleRows } = await pool.query('SELECT margin_percent FROM roles WHERE id = $1', [userRoleId]);
        
        let margin = 0; // Fallback jika role tidak ditemukan
        if (roleRows.length > 0) {
            margin = roleRows[0].margin_percent;
        } else {
            console.warn(`Peringatan: Role dengan ID ${userRoleId} tidak ditemukan. Menggunakan margin 0%.`);
        }
        // --- AKHIR PERBAIKAN LOGIKA MARGIN ---

        const { rows: games } = await pool.query("SELECT name, image_url, needs_server_id, target_id_label FROM games WHERE id = $1 AND status = 'Active'", [gameId]);
        if (games.length === 0) return res.status(404).json({ message: 'Game tidak ditemukan.' });

        const { rows: products } = await pool.query("SELECT id, name, provider_sku, price as base_price FROM products WHERE game_id = $1 AND status = 'Active' ORDER BY price ASC", [gameId]);

        const finalProducts = products.map(p => {
            // Terapkan margin ke harga dasar
            const sellingPrice = p.base_price * (1 + (margin / 100));
            return { 
                id: p.id, 
                name: p.name, 
                provider_sku: p.provider_sku, 
                price: Math.ceil(sellingPrice) // Pembulatan ke atas
            };
        });
        
        res.json({ game: games[0], products: finalProducts });
    } catch (error) {
        console.error("Gagal mengambil produk game (public):", error);
        res.status(500).json({ message: 'Server error saat mengambil data produk.' });
    }
});

app.get('/api/games/:gameId/servers', async (req, res) => {
    try {
        const { gameId } = req.params;
        const sql = "SELECT server_name FROM game_servers WHERE game_id = $1 ORDER BY server_name ASC";
        const { rows } = await pool.query(sql, [gameId]);
        // Kirim array nama server, e.g., ["America", "Asia", "Europe"]
        res.json(rows.map(row => row.server_name));
    } catch (error) {
        console.error('Error fetching game servers:', error);
        res.status(500).json({ message: 'Server error saat mengambil data server game.' });
    }
});

app.get('/api/public/compare-prices', async (req, res) => {
    try {
        const sqlProducts = `SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, p.status, g.name as game_name 
                             FROM products p JOIN games g ON p.game_id = g.id 
                             WHERE p.status = 'Active' 
                             ORDER BY g.name ASC, p.price ASC, p.name ASC`; // Urutan produk
        const { rows: products } = await pool.query(sqlProducts);

        const sqlRoles = `SELECT id, name, margin_percent FROM roles ORDER BY id ASC`;
        const { rows: roles } = await pool.query(sqlRoles);

        // Ambil daftar game juga
        const sqlGames = "SELECT id, name FROM games WHERE status = 'Active' ORDER BY name ASC";
        const { rows: games } = await pool.query(sqlGames);

        const roleMargins = {};
        roles.forEach(role => {
            roleMargins[role.id] = parseFloat(role.margin_percent);
        });

        const productsWithRolePrices = products.map(product => {
            const productWithPrices = { 
                id: product.id,
                game_name: product.game_name,
                product_name: product.name,
                provider_sku: product.provider_sku,
                base_price: product.price 
            }; 
            roles.forEach(role => {
                const margin = roleMargins[role.id] || 0;
                const sellingPrice = product.price * (1 + (margin / 100));
                productWithPrices[`price_${role.name.toLowerCase()}`] = Math.ceil(sellingPrice);
            });
            return productWithPrices;
        });

        res.json({ products: productsWithRolePrices, roles: roles, games: games }); // Mengirim products, roles, dan games
    } catch (error) {
        console.error('Error fetching public compare prices:', error);
        res.status(500).json({ message: 'Server error saat mengambil data perbandingan harga.' });
    }
});

app.post('/api/promos/validate', protect, async (req, res) => {
    const { promo_code, product_id, target_game_id } = req.body;
    const client_user_id = req.user.id; // ID pengguna dari sistem kita

    if (!promo_code || !product_id || !target_game_id) {
        return res.status(400).json({ valid: false, message: 'Informasi promo, produk, dan ID game dibutuhkan.' });
    }

    const client = await pool.connect();
    try {
        // 1. Ambil detail promo
        const promoRes = await client.query('SELECT * FROM promo_codes WHERE code = $1 AND is_active = true', [promo_code.toUpperCase()]);
        if (promoRes.rows.length === 0) {
            return res.status(404).json({ valid: false, message: 'Kode promo tidak ditemukan atau tidak aktif.' });
        }
        const promo = promoRes.rows[0];
        const rules = promo.rules || {};

        // 2. Cek tanggal kedaluwarsa & batas penggunaan global
        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
            return res.status(400).json({ valid: false, message: 'Kode promo sudah kedaluwarsa.' });
        }
        if (promo.max_uses && promo.uses_count >= promo.max_uses) {
            return res.status(400).json({ valid: false, message: 'Kuota penggunaan promo ini sudah habis.' });
        }

        // 3. Cek batas penggunaan per ID Game
        if (rules.max_uses_per_user) {
            const usageRes = await client.query(
                'SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND customer_game_id = $2',
                [promo.id, target_game_id]
            );
            const userUsageCount = parseInt(usageRes.rows[0].count, 10);
            if (userUsageCount >= rules.max_uses_per_user) {
                return res.status(400).json({ valid: false, message: `Anda sudah mencapai batas maksimal penggunaan kode ini (${rules.max_uses_per_user}x).` });
            }
        }
        
        // 4. Ambil detail produk & game yang akan dibeli
        const productRes = await client.query('SELECT p.*, g.id as game_id FROM products p JOIN games g ON p.game_id = g.id WHERE p.id = $1', [product_id]);
        if (productRes.rows.length === 0) {
            return res.status(404).json({ valid: false, message: 'Produk tidak ditemukan.' });
        }
        const product = productRes.rows[0];

        // 5. Validasi semua aturan dari JSON
        if (rules.min_price && product.price < rules.min_price) {
            return res.status(400).json({ valid: false, message: `Promo ini hanya berlaku untuk pembelian minimal Rp ${rules.min_price}.` });
        }
        if (rules.allowed_game_ids && !rules.allowed_game_ids.includes(product.game_id)) {
            return res.status(400).json({ valid: false, message: 'Promo ini tidak berlaku untuk game ini.' });
        }
        if (rules.allowed_product_ids && !rules.allowed_product_ids.includes(product.id)) {
            return res.status(400).json({ valid: false, message: 'Promo ini tidak berlaku untuk produk ini.' });
        }

        // 6. Jika semua validasi lolos, hitung diskonnya
        let discount = 0;
        if (promo.type === 'percentage') {
            discount = (product.price * promo.value) / 100;
        } else if (promo.type === 'fixed') {
            discount = promo.value;
        }
        const finalPrice = Math.max(0, product.price - discount);

        res.json({
            valid: true,
            message: 'Kode promo berhasil digunakan!',
            discount: parseFloat(discount),
            original_price: parseFloat(product.price),
            final_price: parseFloat(finalPrice)
        });

    } catch (error) {
        console.error('Error saat validasi promo:', error);
        res.status(500).json({ valid: false, message: 'Terjadi kesalahan di server.' });
    } finally {
        client.release();
    }
});

// Endpoint untuk mengambil produk flash sale yang aktif
app.get('/api/public/flash-sales', async (req, res) => {
    try {
        const sql = `
            SELECT 
                fs.id as flash_sale_id,
                fs.discount_price,
                p.id as product_id,
                p.name as product_name,
                -- Menghitung harga jual asli berdasarkan margin role BRONZE (ID=1)
                CEIL(p.price * (1 + r.margin_percent / 100)) as original_price,
                g.name as game_name,
                g.image_url as game_image_url
            FROM flash_sales fs
            JOIN products p ON fs.product_id = p.id
            JOIN games g ON p.game_id = g.id
            -- Bergabung dengan tabel roles untuk mendapatkan margin BRONZE
            JOIN roles r ON r.id = 1 
            WHERE 
                fs.is_active = true AND
                NOW() BETWEEN fs.start_at AND fs.end_at AND
                (fs.max_uses IS NULL OR fs.uses_count < fs.max_uses)
            ORDER BY fs.end_at ASC;
        `;
        const { rows } = await pool.query(sql);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching flash sales:", error);
        res.status(500).json({ message: 'Gagal mengambil data flash sale.' });
    }
});



// === ORDER & H2H ENDPOINTS ===
app.post('/api/order', protect, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { productId, targetGameId, targetServerId, promoCode } = req.body;
        const userId = req.user.id;

        if (!productId || !targetGameId) throw new Error('Produk dan ID Game wajib diisi.');

        const { rows: products } = await client.query('SELECT p.*, g.id as game_id, g.needs_server_id FROM products p JOIN games g ON p.game_id = g.id WHERE p.id = $1 AND p.status = \'Active\' FOR UPDATE', [productId]);
        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        const product = products[0];

        if (product.needs_server_id && !targetServerId) throw new Error('Server ID wajib diisi untuk game ini.');
        
        const { rows: users } = await client.query('SELECT balance, role_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1 FOR UPDATE', [userId]);
        const user = users[0];

        const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [user.role_id]);
        const margin = roleRows[0].margin_percent;
        const normalPrice = Math.ceil(product.price * (1 + (margin / 100)));

        let finalPrice = normalPrice;
        let promoIdToLog = null;
        let flashSaleIdToLog = null;
        
        const fsRes = await client.query(
            `SELECT * FROM flash_sales WHERE product_id = $1 AND is_active = true AND NOW() BETWEEN start_at AND end_at AND (max_uses IS NULL OR uses_count < max_uses)`,
            [productId]
        );

        // --- INI ADALAH LOGIKA UTAMANYA ---
        if (fsRes.rows.length > 0) {
            const flashSale = fsRes.rows[0];
            flashSaleIdToLog = flashSale.id;
            
            // JIKA PENGGUNA BUKAN ADMIN ATAU OWNER, PAKSA GUNAKAN HARGA FLASH SALE
            if (user.role_name !== 'Admin' && user.role_name !== 'Owner') {
                finalPrice = flashSale.discount_price;
                console.log(`User role (${user.role_name}) terdeteksi. Menerapkan harga Flash Sale: Rp ${finalPrice}`);

                // Aturan Bisnis: Jika produk dalam flash sale, promo tidak bisa digunakan
                if (promoCode) {
                    throw new Error('Kode promo tidak dapat digunakan untuk produk yang sedang dalam flash sale.');
                }
            } else {
                console.log(`User adalah ${user.role_name}. Harga Flash Sale diabaikan, menggunakan harga normal.`);
            }
        } 
        else if (promoCode) {
            // Logika kode promo hanya berjalan jika tidak ada Flash Sale
            const promoRes = await client.query('SELECT * FROM promo_codes WHERE code = $1 AND is_active = true', [promoCode.toUpperCase()]);
            if (promoRes.rows.length === 0) throw new Error('Kode promo tidak valid atau tidak aktif.');
            
            const promo = promoRes.rows[0];
            const rules = promo.rules || {};
            appliedPromo = promo; // Simpan data promo untuk digunakan nanti

            // Validasi aturan promo (sama seperti di endpoint validasi)
            if (promo.expires_at && new Date(promo.expires_at) < new Date()) throw new Error('Kode promo sudah kedaluwarsa.');
            if (promo.max_uses && promo.uses_count >= promo.max_uses) throw new Error('Kuota penggunaan promo ini sudah habis.');
            if (rules.max_uses_per_user) {
                const usageRes = await client.query('SELECT COUNT(*) FROM promo_usages WHERE promo_code_id = $1 AND customer_game_id = $2', [promo.id, targetGameId]);
                if (parseInt(usageRes.rows[0].count, 10) >= rules.max_uses_per_user) throw new Error('Anda sudah mencapai batas maksimal penggunaan kode ini.');
            }
            if (rules.min_price && normalPrice < rules.min_price) throw new Error(`Promo hanya berlaku untuk pembelian minimal Rp ${rules.min_price}.`);
            if (rules.allowed_game_ids && !rules.allowed_game_ids.includes(product.game_id)) throw new Error('Promo ini tidak berlaku untuk game ini.');
            if (rules.allowed_product_ids && !rules.allowed_product_ids.includes(product.id)) throw new Error('Promo ini tidak berlaku untuk produk ini.');

            // Jika semua lolos, hitung diskon dari HARGA JUAL NORMAL
            
            let discount = 0;
            if (promo.type === 'percentage') {
                discount = (normalPrice * promo.value) / 100;
                if (rules.max_discount_amount && discount > rules.max_discount_amount) {
                    discount = rules.max_discount_amount;
                }
            } else if (promo.type === 'fixed') {
                discount = promo.value;
            }
            finalPrice = Math.max(0, Math.ceil(normalPrice - discount));
            promoIdToLog = promo.id;
        }
        // --- AKHIR LOGIKA HARGA BARU ---

        if (user.balance < finalPrice) throw new Error('Saldo Anda tidak mencukupi.');

        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [finalPrice, userId]);

        const invoiceId = `TRX-${Date.now()}${userId}`;
        const finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
        const trx_id_provider = `WEB-${Date.now()}`;

        // Masukkan transaksi ke database
        const txSql = 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id';
        const { rows: transactionRows } = await client.query(txSql, [invoiceId, userId, productId, finalTargetForDB, finalPrice, 'Pending', trx_id_provider]);
        const newTransactionId = transactionRows[0].id;

        const historyDesc = `Pembelian produk: ${product.name} (${invoiceId})`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [userId, -finalPrice, 'Purchase', historyDesc, invoiceId]);

        // 5. Masukkan ke tabel `promo_usages` JIKA promo digunakan
        if (promoIdToLog) {
            await client.query(
                'INSERT INTO promo_usages (promo_code_id, customer_game_id, transaction_id) VALUES ($1, $2, $3)',
                [promoIdToLog, targetGameId, newTransactionId]
            );
            await client.query('UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = $1', [promoIdToLog]);
        }
        
        // 6. Teruskan pesanan ke Foxy API (tidak ada perubahan)
        const foxyPayload = {
            product_code: product.provider_sku,
            user_id: targetGameId,
            server_id: targetServerId || '',
            trx_id: trx_id_provider,
            callback_url: 'https://mikutopup.my.id/api/foxy/callback'
        };

        axios.post(`${FOXY_BASE_URL}/v1/order`, foxyPayload, {
            headers: {
                'Authorization': FOXY_API_KEY,
                'Content-Type': 'application/json'
            }
        })
        .then(response => {
            console.log("Foxy API Order Response:", response.data);
        })
        .catch(err => {
            console.error("Foxy API Error on initial order:", err.response ? err.response.data : err.message);
        });

        await client.query('COMMIT');
        res.status(201).json({ message: 'Pesanan Anda sedang diproses oleh provider!', invoiceId: invoiceId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Order error:", error);
        res.status(400).json({ message: error.message || 'Gagal memproses transaksi.' });
    } finally {
        client.release();
    }
});

app.post('/api/foxy/callback', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { trx_id, status, message } = req.body;
        console.log('Callback diterima:', req.body);

        if (!trx_id || !status) {
            return res.status(400).json({ message: 'Parameter tidak lengkap.' });
        }

        const { rows: transactions } = await client.query('SELECT * FROM transactions WHERE provider_trx_id = $1 AND status = \'Pending\' FOR UPDATE', [trx_id]);
        if (transactions.length === 0) {
            console.log(`Callback untuk provider_trx_id ${trx_id} tidak ditemukan atau sudah diproses.`);
            await client.query('ROLLBACK'); // Rollback jika tidak ada transaksi yang cocok
            return res.status(200).json({ message: 'OK' });
        }
        const tx = transactions[0];

        if (status.toUpperCase() === 'SUCCESS') {
            await client.query('UPDATE transactions SET status = \'Success\' WHERE id = $1', [tx.id]);
                 await createNotification(tx.user_id, `Pesanan ${tx.invoice_id} telah berhasil diproses.`, `/invoice.html?id=${tx.invoice_id}`);
        } else if (status.toUpperCase() === 'FAILED' || status.toUpperCase() === 'REFUNDED') {
            await client.query('UPDATE transactions SET status = \'Failed\' WHERE id = $1', [tx.id]);
            await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);

            const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: ${message || 'Transaksi gagal dari provider'}`;
            await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)', [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
                 await createNotification(tx.user_id, `Pesanan ${tx.invoice_id} gagal. Saldo telah dikembalikan.`, `/invoice.html?id=${tx.invoice_id}`);
        } else if (status.toUpperCase() === 'PENDING') {
            console.log(`Transaksi ${trx_id} masih pending dari callback.`);
        }
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Callback berhasil diproses.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Callback error:', error);
        res.status(500).json({ message: 'Gagal memproses callback.' });
    } finally {
        client.release();
    }
});

app.post('/h2h/order', protectH2H, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Terima productId, targetGameId, DAN targetServerId dari body
        const { productId, targetGameId, targetServerId } = req.body;
        const h2hUser = req.user; // User didapat dari middleware protectH2H

        if (!productId || !targetGameId) {
            throw new Error('productId dan targetGameId wajib diisi.');
        }

        // 1. Ambil detail produk & cek apakah butuh server ID
        const { rows: products } = await client.query(
            `SELECT p.price as base_price, p.name, p.provider_sku, g.needs_server_id 
             FROM products p JOIN games g ON p.game_id = g.id 
             WHERE p.id = $1 AND p.status = 'Active' FOR UPDATE`, 
            [productId]
        );
        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        const product = products[0];

        // Validasi Server ID jika game membutuhkannya
        if (product.needs_server_id && !targetServerId) {
            throw new Error('Server ID wajib diisi untuk game ini.');
        }

        // 2. Ambil detail user H2H untuk cek saldo & hitung harga
        const { rows: users } = await client.query('SELECT balance, role_id FROM users WHERE id = $1 FOR UPDATE', [h2hUser.id]);
        const userForTx = users[0];

        const { rows: roleRows } = await client.query('SELECT margin_percent FROM roles WHERE id = $1', [userForTx.role_id]);
        const margin = roleRows[0].margin_percent;
        const finalPrice = Math.ceil(product.base_price * (1 + (margin / 100)));

        if (userForTx.balance < finalPrice) throw new Error('Saldo H2H Anda tidak mencukupi.');
        
        // 3. Potong saldo & catat transaksi sebagai 'Pending'
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [finalPrice, h2hUser.id]);

        const invoiceId = `H2H-${Date.now()}${h2hUser.id}`;
        const finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
        const trx_id_provider = `H2H-PROVIDER-${Date.now()}`; // ID unik untuk provider

        // Status awal adalah 'Pending', bukan 'Success'
        const txSql = 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id) VALUES ($1, $2, $3, $4, $5, $6, $7)';
        await client.query(txSql, [invoiceId, h2hUser.id, productId, finalTargetForDB, finalPrice, 'Pending', trx_id_provider]);

        const historyDesc = `Pembelian H2H: ${product.name} (${invoiceId})`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)';
        await client.query(historySql, [h2hUser.id, -finalPrice, 'Purchase', historyDesc, invoiceId]);

        // 4. Teruskan pesanan ke Foxy API (Sama seperti order biasa)
        const foxyPayload = {
            product_code: product.provider_sku,
            user_id: targetGameId,
            server_id: targetServerId || '',
            trx_id: trx_id_provider,
            callback_url: 'https://mikutopup.my.id/api/foxy/callback'
        };

        axios.post(`${FOXY_BASE_URL}/v1/order`, foxyPayload, {
            headers: {
                'Authorization': FOXY_API_KEY,
                'Content-Type': 'application/json'
            }
        }).catch(err => {
            // Log error jika gagal mengirim ke Foxy, tapi jangan batalkan transaksi di sisi Anda
            console.error("Foxy API Error on H2H order:", err.response ? err.response.data : err.message);
        });

        await client.query('COMMIT');
        
        // 5. Beri respons bahwa pesanan sedang diproses
        res.status(201).json({ 
            success: true,
            message: 'Pesanan H2H Anda sedang diproses!', 
            data: {
                invoiceId: invoiceId,
                status: 'Pending',
                productName: product.name,
                target: finalTargetForDB,
                price: finalPrice
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("H2H Order error:", error);
        res.status(400).json({ success: false, message: error.message || 'Gagal memproses transaksi H2H.' });
    } finally {
        client.release();
    }
});

app.get('/h2h/products', protectH2H, async (req, res) => {
    try {
        // req.user didapatkan dari middleware protectH2H yang memvalidasi API Key
        const h2hPartner = req.user;

        // 1. Ambil data role spesifik milik partner H2H ini
        const { rows: roleRows } = await pool.query('SELECT margin_percent FROM roles WHERE id = $1', [h2hPartner.role_id]);
        if (roleRows.length === 0) {
            throw new Error('Role untuk partner H2H tidak ditemukan.');
        }
        const partnerMargin = roleRows[0].margin_percent;

        // 2. Ambil semua produk yang aktif
        const { rows: allActiveProducts } = await pool.query(
            `SELECT p.id, p.name as product_name, p.provider_sku, p.price as base_price, g.name as game_name 
             FROM products p JOIN games g ON p.game_id = g.id WHERE p.status = 'Active' AND g.status = 'Active'
             ORDER BY g.name, p.price`
        );
        
        // 3. Hitung harga jual untuk partner H2H dan format respons
        const partnerProductList = allActiveProducts.map(product => {
            const partnerCost = Math.ceil(product.base_price * (1 + (partnerMargin / 100)));
            return {
                productId: product.id,
                game_name: product.game_name,
                product_name: product.product_name,
                sku: product.provider_sku,
                price: partnerCost // Ini adalah "harga modal" untuk partner H2H
            };
        });
        
        res.json({
            success: true,
            message: 'Daftar produk berhasil diambil.',
            data: partnerProductList
        });

    } catch (error) {
        console.error('H2H Get Products Error:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar produk H2H.' });
    }
});

async function checkPendingTransactions() {
    console.log('Running checkPendingTransactions job...');
    const client = await pool.connect(); // Dapatkan koneksi dari pool
    try {
        await client.query('BEGIN'); // Mulai transaksi database

        // 1. Ambil semua transaksi dengan status 'Pending' yang belum diupdate oleh callback
        const { rows: pendingTx } = await client.query(
            `SELECT id, invoice_id, user_id, product_id, price, provider_trx_id FROM transactions WHERE status = 'Pending' FOR UPDATE`
        ); // Gunakan FOR UPDATE untuk mengunci baris

        if (pendingTx.length === 0) {
            console.log('No pending transactions found.');
            await client.query('COMMIT');
            return;
        }

        console.log(`Found ${pendingTx.length} pending transactions. Checking status with Foxy API...`);

        for (const tx of pendingTx) {
            try {
                // Panggil Foxy API untuk mendapatkan status transaksi
                // Sesuai dengan modul api foxy Anda, endpoint status adalah /v1/status/{trxId}
                const foxyResponse = await axios.get(`${FOXY_BASE_URL}/v1/status/${tx.provider_trx_id}`, {
                    headers: { 'Authorization': FOXY_API_KEY }
                });

                const foxyStatus = foxyResponse.data.data.status; // Asumsi status ada di response.data.data.status
                const foxyMessage = foxyResponse.data.message || 'No specific message from provider.';

                console.log(`Transaction ${tx.invoice_id} (Provider ID: ${tx.provider_trx_id}) - Foxy Status: ${foxyStatus}`);

                if (foxyStatus === 'SUCCESS') {
                    await client.query('UPDATE transactions SET status = \'Success\', updated_at = NOW() WHERE id = $1', [tx.id]);
                    console.log(`Transaction ${tx.invoice_id} updated to SUCCESS.`);
                } else if (foxyStatus === 'FAILED' || foxyStatus === 'REFUNDED' || foxyStatus === 'PARTIAL SUCCES' || foxyStatus === 'PARTIAL REFFUND') {
                    await client.query('UPDATE transactions SET status = \'Failed\', updated_at = NOW() WHERE id = $1', [tx.id]);
                    // Kembalikan saldo pengguna
                    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [tx.price, tx.user_id]);
                    // Catat di riwayat saldo
                    const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} (Gagal/Refund dari provider): ${foxyMessage}`;
                    await client.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES ($1, $2, $3, $4, $5)',
                        [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
                    console.log(`Transaction ${tx.invoice_id} updated to FAILED/REFUNDED and balance refunded.`);
                }
                // Jika statusnya masih 'PENDING' dari Foxy, biarkan saja di database Anda.

            } catch (foxyError) {
                console.error(`Error checking Foxy status for ${tx.invoice_id}:`, foxyError.response ? foxyError.response.data : foxyError.message);
                // Tangani error API Foxy, misal log saja, jangan update status di DB jika tidak yakin.
            }
        }

        await client.query('COMMIT'); // Commit transaksi setelah semua selesai

    } catch (dbError) {
        await client.query('ROLLBACK'); // Rollback jika ada error database saat mengambil/memproses
        console.error('Error in checkPendingTransactions job:', dbError);
    } finally {
        client.release(); // Selalu kembalikan koneksi ke pool
    }
}

app.put('/h2h/profile/callback', protectH2H, async (req, res) => {
    try {
        const { callback_url } = req.body;
        // Validasi URL sederhana
        if (!callback_url || !callback_url.startsWith('https://')) {
            return res.status(400).json({ success: false, message: 'URL tidak valid. Harus dimulai dengan https://' });
        }
        
        await pool.query('UPDATE users SET h2h_callback_url = $1 WHERE id = $2', [callback_url, req.user.id]);
        
        res.json({ success: true, message: 'Callback URL berhasil diperbarui.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memperbarui callback URL.' });
    }
});

app.get('/h2h/profile', protectH2H, async (req, res) => {

    const profileData = {
        username: req.user.username,
        balance: req.user.balance,
        role: req.user.role_name 
    };

    res.json({
        success: true,
        message: 'Profil berhasil diambil.',
        data: profileData
    });
});

module.exports = { app, pool, checkPendingTransactions }; 
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});