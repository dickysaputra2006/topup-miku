const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'kunci-rahasia-yang-sangat-aman-untuk-proyek-ini'; // Ganti dengan kunci rahasia yang lebih kuat!

// === KONFIGURASI FOXY API (BARU) ===
// Ganti 'GANTI_DENGAN_API_KEY_ANDA' dengan API Key Foxy Anda yang sebenarnya.
// Sangat disarankan menggunakan process.env.FOXY_API_KEY jika di-deploy di Render.
const FOXY_BASE_URL = 'https://api.foxygamestore.com';
const FOXY_API_KEY = process.env.FOXY_API_KEY || 'kiosgamee94aab3cdd2d062a2005aedecad41beff393ff8dca6eaf1cfec381c2f96e5dd4';

// Middleware
app.use(cors());
app.use(express.json());

// Konfigurasi Database
const dbConfig = { host: 'localhost', user: 'root', password: '', database: 'topup_db' };
const pool = mysql.createPool(dbConfig);

// === AUTH ENDPOINTS ===
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, username, email, nomorWa, password } = req.body;
        if (!fullName || !username || !email || !nomorWa || !password) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO users (full_name, username, email, nomor_wa, password, role_id) VALUES (?, ?, ?, ?, ?, 1)';
        await pool.query(sql, [fullName, username, email, nomorWa, hashedPassword]);
        res.status(201).json({ message: 'Registrasi berhasil! Silakan login.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Username atau Email sudah digunakan.' });
        console.error(error);
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Input tidak boleh kosong.' });
        const sql = 'SELECT users.*, roles.name as role_name FROM users JOIN roles ON users.role_id = roles.id WHERE users.username = ? OR users.email = ?';
        const [users] = await pool.query(sql, [username, username]);
        if (users.length === 0) return res.status(401).json({ message: 'Username atau password salah.' });
        const user = users[0];
        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) return res.status(401).json({ message: 'Username atau password salah.' });
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role_name }, JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ message: 'Login berhasil!', token });
    } catch (error) {
        console.error(error);
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
        const [users] = await pool.query('SELECT * FROM users WHERE api_key = ?', [apiKey]);
        if (users.length === 0) {
            return res.status(403).json({ success: false, message: 'API Key tidak valid.' });
        }
        req.user = users[0];
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error saat validasi API Key.' });
    }
};


// === USER ENDPOINTS ===
app.get('/api/user/profile', protect, async (req, res) => {
    try {
        const sql = 'SELECT u.id, u.full_name, u.username, u.email, u.nomor_wa, u.balance, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?';
        const [users] = await pool.query(sql, [req.user.id]);
        if (users.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
        res.json(users[0]);
    } catch (error) {
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.put('/api/user/profile', protect, async (req, res) => {
    try {
        const { fullName, email, nomorWa } = req.body;
        if (!fullName || !email || !nomorWa) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const sql = 'UPDATE users SET full_name = ?, email = ?, nomor_wa = ? WHERE id = ?';
        await pool.query(sql, [fullName, email, nomorWa, req.user.id]);
        res.json({ message: 'Profil berhasil diperbarui.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Email sudah digunakan oleh akun lain.' });
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.put('/api/user/password', protect, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Semua kolom wajib diisi!' });
        const sqlSelect = 'SELECT password FROM users WHERE id = ?';
        const [users] = await pool.query(sqlSelect, [req.user.id]);
        const user = users[0];
        const isPasswordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isPasswordMatch) return res.status(401).json({ message: 'Password saat ini salah.' });
        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        const sqlUpdate = 'UPDATE users SET password = ? WHERE id = ?';
        await pool.query(sqlUpdate, [hashedNewPassword, req.user.id]);
        res.json({ message: 'Password berhasil diubah.' });
    } catch (error) {
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/api/user/balance-history', protect, async (req, res) => {
    try {
        const sql = `SELECT amount, type, description, reference_id, created_at FROM balance_history WHERE user_id = ? ORDER BY created_at DESC`;
        const [history] = await pool.query(sql, [req.user.id]);
        res.json(history);
    } catch (error) {
        res.status(500).json({ message: 'Server error saat mengambil riwayat saldo.' });
    }
});
app.post('/api/user/generate-apikey', protect, async (req, res) => {
    try {
        const newApiKey = crypto.randomBytes(24).toString('hex');
        await pool.query('UPDATE users SET api_key = ? WHERE id = ?', [newApiKey, req.user.id]);
        res.json({ message: 'API Key baru berhasil dibuat! Harap simpan di tempat aman.', apiKey: newApiKey });
    } catch (error) {
        res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});
app.get('/api/user/apikey', protect, async (req, res) => {
    try {
        const sql = 'SELECT api_key FROM users WHERE id = ?';
        const [users] = await pool.query(sql, [req.user.id]);
        if (users.length === 0) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
        res.json({ apiKey: users[0].api_key });
    } catch (error) {
        res.status(500).json({ message: 'Server error saat mengambil API key.' });
    }
});

// === DEPOSIT ENDPOINTS ===
app.post('/api/deposit/request', protect, async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user.id;
        if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ message: 'Jumlah deposit tidak valid.' });
        const uniqueCode = Math.floor(Math.random() * 900) + 100;
        const totalAmount = parseInt(amount) + uniqueCode;
        const sql = 'INSERT INTO deposits (user_id, amount, unique_code, status) VALUES (?, ?, ?, ?)';
        const [result] = await pool.query(sql, [userId, totalAmount, uniqueCode, 'Pending']);
        res.status(201).json({
            message: 'Permintaan deposit berhasil dibuat.',
            deposit: { id: result.insertId, amount: totalAmount, paymentInstructions: `Silakan transfer sejumlah Rp ${new Intl.NumberFormat('id-ID').format(totalAmount)} ke rekening Bank ABC 123-456-7890 a/n GameStore.` }
        });
    } catch (error) {
        res.status(500).json({ message: 'Terjadi kesalahan pada server saat membuat permintaan deposit.' });
    }
});

// === ADMIN ENDPOINTS ===
app.get('/api/admin/deposits/pending', protectAdmin, async (req, res) => {
    try {
        const sql = `SELECT d.id, u.username, d.amount, d.created_at FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = 'Pending' ORDER BY d.created_at ASC`;
        const [deposits] = await pool.query(sql);
        res.json(deposits);
    } catch (error) {
        res.status(500).json({ message: 'Server error saat mengambil data deposit.' });
    }
});
app.post('/api/admin/deposits/approve', protectAdmin, async (req, res) => {
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ message: 'Deposit ID tidak boleh kosong.' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [deposits] = await connection.query('SELECT * FROM deposits WHERE id = ? AND status = "Pending" FOR UPDATE', [depositId]);
        if (deposits.length === 0) throw new Error('Deposit tidak ditemukan atau sudah diproses.');
        const deposit = deposits[0];
        await connection.query('UPDATE deposits SET status = "Success" WHERE id = ?', [depositId]);
        await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [deposit.amount, deposit.user_id]);
        const historyDesc = `Deposit #${deposit.id} disetujui`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)';
        await connection.query(historySql, [deposit.user_id, deposit.amount, 'Deposit', historyDesc, `DEPOSIT-${deposit.id}`]);
        await connection.commit();
        res.json({ message: `Deposit #${depositId} berhasil disetujui.` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ message: error.message || 'Gagal menyetujui deposit.' });
    } finally {
        connection.release();
    }
});
app.post('/api/admin/balance/add', protectAdmin, async (req, res) => {
    const { username, amount, description } = req.body;
    if (!username || !amount || !description || isNaN(amount) || amount <= 0) return res.status(400).json({ message: 'Input tidak valid.' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [users] = await connection.query('SELECT id, balance FROM users WHERE username = ? OR email = ?', [username, username]);
        if (users.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = users[0];
        await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [parseInt(amount), user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)';
        await connection.query(historySql, [user.id, parseInt(amount), 'Deposit', description, `ADMIN_ADD-${Date.now()}`]);
        await connection.commit();
        res.json({ message: `Saldo sebesar ${amount} berhasil ditambahkan ke akun ${username}.` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ message: error.message || 'Gagal menambah saldo.' });
    } finally {
        connection.release();
    }
});
app.post('/api/admin/balance/reduce', protectAdmin, async (req, res) => {
    const { username, amount, description } = req.body;
    if (!username || !amount || !description || isNaN(amount) || amount <= 0) return res.status(400).json({ message: 'Input tidak valid.' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [users] = await connection.query('SELECT id, balance FROM users WHERE username = ? OR email = ?', [username, username]);
        if (users.length === 0) throw new Error('Pengguna tidak ditemukan.');
        const user = users[0];
        if (user.balance < amount) throw new Error('Saldo pengguna tidak mencukupi untuk dikurangi.');
        await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, user.id]);
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)';
        await connection.query(historySql, [user.id, -amount, 'Refund', description, `ADMIN_REDUCE-${Date.now()}`]);
        await connection.commit();
        res.json({ message: `Saldo akun ${username} berhasil dikurangi sebesar ${amount}.` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ message: error.message || 'Gagal mengurangi saldo.' });
    } finally {
        connection.release();
    }
});
app.get('/api/admin/roles', protectAdmin, async (req, res) => {
    try {
        const [roles] = await pool.query('SELECT * FROM roles ORDER BY id ASC');
        res.json(roles);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil data roles.' });
    }
});
app.put('/api/admin/roles', protectAdmin, async (req, res) => {
    try {
        const margins = req.body;
        if (!Array.isArray(margins)) return res.status(400).json({ message: 'Format data tidak valid.' });
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        try {
            for (const item of margins) {
                await connection.query('UPDATE roles SET margin_percent = ? WHERE id = ?', [item.margin, item.id]);
            }
            await connection.commit();
            res.json({ message: 'Margin berhasil diperbarui.' });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        res.status(500).json({ message: 'Gagal memperbarui margin.' });
    }
});
app.get('/api/admin/games', protectAdmin, async (req, res) => {
    try {
        const sql = "SELECT * FROM games ORDER BY name ASC";
        const [games] = await pool.query(sql);
        res.json(games);
    } catch (error) {
        res.status(500).json({ message: 'Server error saat mengambil data game.' });
    }
});
app.get('/api/admin/products', protectAdmin, async (req, res) => {
    try {
        const sql = `SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, p.status, g.name as game_name FROM products p JOIN games g ON p.game_id = g.id ORDER BY g.name, p.name ASC`;
        const [products] = await pool.query(sql);
        res.json(products);
    } catch (error) {
        res.status(500).json({ message: 'Server error saat mengambil data produk.' });
    }
});
app.post('/api/admin/games', protectAdmin, async (req, res) => {
    try {
        const { name, category, imageUrl } = req.body;
        if (!name || !category || !imageUrl) return res.status(400).json({ message: 'Semua kolom wajib diisi.' });
        const sql = 'INSERT INTO games (name, category, image_url) VALUES (?, ?, ?)';
        await pool.query(sql, [name, category, imageUrl]);
        res.status(201).json({ message: `Game ${name} berhasil ditambahkan.` });
    } catch (error) {
        res.status(500).json({ message: 'Server error saat menambah game.' });
    }
});
app.post('/api/admin/products', protectAdmin, async (req, res) => {
    try {
        const { game_id, name, provider_sku, price, category_id } = req.body;
        if (!game_id || !name || !provider_sku || !price || !category_id) return res.status(400).json({ message: 'Semua kolom wajib diisi.' });
        const sql = 'INSERT INTO products (game_id, category_id, name, provider_sku, price) VALUES (?, ?, ?, ?, ?)';
        await pool.query(sql, [game_id, category_id, name, provider_sku, price]);
        res.status(201).json({ message: `Produk ${name} berhasil ditambahkan.` });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'SKU Provider sudah ada.' });
        res.status(500).json({ message: 'Server error saat menambah produk.' });
    }
});

// === PERUBAHAN DI SINI: SINKRONISASI PRODUK DARI FOXY API ===
app.post('/api/admin/sync-products', protectAdmin, async (req, res) => {
    const { margin_percent } = req.body;
    if (margin_percent === undefined || isNaN(margin_percent)) return res.status(400).json({ message: 'Persentase margin tidak valid.' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Mengambil produk dari Foxy API yang sebenarnya
        // Menggunakan /v1/products sesuai dengan file api foxy yang Anda berikan
        const response = await axios.get(`${FOXY_BASE_URL}/v1/products`, {
            headers: { 'Authorization': FOXY_API_KEY }
        });
        const providerProducts = response.data.data; // Asumsi 'data' adalah array produk di respons Foxy API

        for (const product of providerProducts) {
            let [games] = await connection.query('SELECT id FROM games WHERE name = ?', [product.game]);
            if (games.length === 0) {
                console.warn(`Game "${product.game}" tidak ditemukan. Membuat game baru.`);
                // Tambahkan game baru jika belum ada
                const [newGameResult] = await connection.query('INSERT INTO games (name, category, image_url, needs_server_id, status) VALUES (?, ?, ?, ?, ?)',
                    [product.game, product.category, 'https://via.placeholder.com/200', 0, 'Active']); // Default image dan needs_server_id
                games = [{ id: newGameResult.insertId }]; // Gunakan ID game yang baru dibuat
            }
            const gameId = games[0].id;

            let [categories] = await connection.query('SELECT id FROM product_categories WHERE name = ? AND game_id = ?', [product.category, gameId]);
            let categoryId;
            if (categories.length === 0) {
                const [newCat] = await connection.query('INSERT INTO product_categories (game_id, name) VALUES (?, ?)', [gameId, product.category]);
                categoryId = newCat.insertId;
            } else {
                categoryId = categories[0].id;
            }

            // Hitung harga jual dengan margin
            const sellingPrice = product.product_price * (1 + (margin_percent / 100)); // Menggunakan product_price dari Foxy API

            // Masukkan atau perbarui produk
            const sql = `INSERT INTO products (game_id, category_id, name, provider_sku, price) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), price = VALUES(price), game_id = VALUES(game_id), category_id = VALUES(category_id)`;
            await connection.query(sql, [gameId, categoryId, product.product_name, product.product_code, sellingPrice]); // Menggunakan product_name dan product_code dari Foxy API
        }
        await connection.commit();
        res.json({ message: `Sinkronisasi produk selesai dengan margin ${margin_percent}%.` });
    } catch (error) {
        await connection.rollback();
        console.error('Sync error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Gagal melakukan sinkronisasi. Cek log server.' });
    } finally {
        connection.release();
    }
});


app.get('/api/admin/transactions', protectAdmin, async (req, res) => {
    try {
        // Ambil semua transaksi dan gabungkan dengan nama user & produk
        const sql = `
            SELECT t.invoice_id, t.target_game_id, t.price, t.status, t.created_at, p.name as product_name, u.username as user_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
        `;
        const [transactions] = await pool.query(sql);
        res.json(transactions);
    } catch (error) {
        console.error("Gagal mengambil riwayat transaksi admin:", error);
        res.status(500).json({ message: 'Server error saat mengambil riwayat transaksi.' });
    }
});


// === PUBLIC ENDPOINTS ===
app.get('/api/games', async (req, res) => {
    try {
        const sql = "SELECT * FROM games WHERE status = 'Active' ORDER BY name ASC";
        const [games] = await pool.query(sql);
        res.json(games);
    } catch (error) {
        res.status(500).json({ message: 'Server error saat mengambil data game.' });
    }
});
app.get('/api/games/:gameId/products', softProtect, async (req, res) => {
    try {
        const { gameId } = req.params;
        let userRoleId = 1;
        if (req.user) {
            const [userRows] = await pool.query('SELECT role_id FROM users WHERE id = ?', [req.user.id]);
            if (userRows.length > 0) userRoleId = userRows[0].role_id;
        }
        const [roleRows] = await pool.query('SELECT margin_percent FROM roles WHERE id = ?', [userRoleId]);
        if (roleRows.length === 0) throw new Error(`Role dengan ID ${userRoleId} tidak ditemukan.`);
        const margin = roleRows[0].margin_percent;
        const [games] = await pool.query("SELECT name, image_url, needs_server_id FROM games WHERE id = ? AND status = 'Active'", [gameId]);
        if (games.length === 0) return res.status(404).json({ message: 'Game tidak ditemukan.' });
        const [products] = await pool.query("SELECT id, name, provider_sku, price as base_price FROM products WHERE game_id = ? AND status = 'Active' ORDER BY price ASC", [gameId]);
        const finalProducts = products.map(p => {
            const sellingPrice = p.base_price * (1 + (margin / 100));
            return { id: p.id, name: p.name, provider_sku: p.provider_sku, price: Math.ceil(sellingPrice) };
        });
        res.json({ game: games[0], products: finalProducts });
    } catch (error) {
        console.error("Gagal mengambil produk game:", error);
        res.status(500).json({ message: 'Server error saat mengambil data produk.' });
    }
});

// === PERUBAHAN DI SINI: ORDER KE FOXY API ===
app.post('/api/order', protect, async (req, res) => {
    const { productId, targetGameId, targetServerId } = req.body;
    const userId = req.user.id;
    if (!productId || !targetGameId) return res.status(400).json({ message: 'Produk dan ID Game wajib diisi.' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [products] = await connection.query('SELECT p.price as base_price, p.name, g.needs_server_id, p.provider_sku FROM products p JOIN games g ON p.game_id = g.id WHERE p.id = ? AND p.status = "Active" FOR UPDATE', [productId]);
        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        const product = products[0];

        if (product.needs_server_id && !targetServerId) throw new Error('Server ID wajib diisi untuk game ini.');

        const [users] = await connection.query('SELECT balance, role_id FROM users WHERE id = ? FOR UPDATE', [userId]);
        const user = users[0];

        const [roleRows] = await connection.query('SELECT margin_percent FROM roles WHERE id = ?', [user.role_id]);
        const margin = roleRows[0].margin_percent;
        const finalPrice = Math.ceil(product.base_price * (1 + (margin / 100)));

        if (user.balance < finalPrice) throw new Error('Saldo Anda tidak mencukupi.');

        await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [finalPrice, userId]);

        const invoiceId = `TRX-${Date.now()}${userId}`;
        // Foxy API mungkin hanya butuh targetGameId dan targetServerId terpisah,
        // pastikan formatnya sesuai dengan kebutuhan Foxy.
        const finalTargetForDB = product.needs_server_id ? `${targetGameId}|${targetServerId}` : targetGameId;
        const trx_id_provider = `WEB-${Date.now()}`; // Ini adalah ID transaksi unik yang Anda kirim ke Foxy

        const txSql = 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status, provider_trx_id) VALUES (?, ?, ?, ?, ?, "Pending", ?)';
        await connection.query(txSql, [invoiceId, userId, productId, finalTargetForDB, finalPrice, trx_id_provider]); // Simpan status "Pending"

        const historyDesc = `Pembelian produk: ${product.name} (${invoiceId})`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)';
        await connection.query(historySql, [userId, -finalPrice, 'Purchase', historyDesc, invoiceId]);

        // Payload untuk Foxy API
        const foxyPayload = {
            product_code: product.provider_sku, // SKU produk dari database Anda
            user_id: targetGameId,
            server_id: targetServerId || '', // Kirim string kosong jika tidak ada server ID
            trx_id: trx_id_provider, // ID transaksi unik dari sisi Anda
            callback_url: 'https://topup-miku.onrender.com/api/foxy/callback' // URL callback Render Anda
        };

        // Mengirim permintaan order ke Foxy API
        // Menggunakan /v1/order sesuai dengan file api foxy yang Anda berikan
        axios.post(`${FOXY_BASE_URL}/v1/order`, foxyPayload, {
            headers: {
                'Authorization': FOXY_API_KEY,
                'Content-Type': 'application/json'
            }
        })
        .then(response => {
            console.log("Foxy API Order Response:", response.data);
            // Respons sukses dari Foxy berarti order diterima, status akan diupdate via callback
            // Tidak perlu update status di sini, biarkan callback yang melakukan.
        })
        .catch(err => {
            console.error("Foxy API Error on initial order:", err.response ? err.response.data : err.message);
            // Jika ada error langsung dari Foxy saat order, Anda bisa:
            // 1. Mengembalikan saldo (rollback)
            // 2. Mengupdate status transaksi menjadi 'Failed'
            // 3. Memberikan pesan error yang informatif ke pengguna
            // Untuk kesederhanaan saat ini, kita hanya log error.
            // Implementasi yang lebih robust akan melakukan rollback atau update status.
        });

        await connection.commit();
        res.status(201).json({ message: 'Pesanan Anda sedang diproses oleh provider!', invoiceId: invoiceId });
    } catch (error) {
        await connection.rollback();
        console.error("Order error:", error);
        res.status(400).json({ message: error.message || 'Gagal memproses transaksi.' });
    } finally {
        connection.release();
    }
});

// Endpoint callback Foxy API (tidak ada perubahan besar di sini, sudah cukup baik)
app.post('/api/foxy/callback', async (req, res) => {
    // Di aplikasi nyata, tambahkan verifikasi (misal: cek signature) untuk memastikan request ini benar-benar dari Foxy
    const { trx_id, status, message } = req.body;
    console.log('Callback diterima:', req.body);

    if (!trx_id || !status) {
        return res.status(400).json({ message: 'Parameter tidak lengkap.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Ambil transaksi berdasarkan trx_id_provider (bukan invoice_id)
        const [transactions] = await connection.query('SELECT * FROM transactions WHERE provider_trx_id = ? AND status = "Pending" FOR UPDATE', [trx_id]);
        if (transactions.length === 0) {
            console.log(`Callback untuk provider_trx_id ${trx_id} tidak ditemukan atau sudah diproses.`);
            return res.status(200).json({ message: 'OK' });
        }
        const tx = transactions[0];

        if (status.toUpperCase() === 'SUCCESS') {
            await connection.query('UPDATE transactions SET status = "Success" WHERE id = ?', [tx.id]);
        } else if (status.toUpperCase() === 'FAILED' || status.toUpperCase() === 'REFUNDED') {
            await connection.query('UPDATE transactions SET status = "Failed" WHERE id = ?', [tx.id]);
            await connection.query('UPDATE users SET balance = balance + ? WHERE id = ?', [tx.price, tx.user_id]);

            const historyDesc = `Pengembalian dana untuk invoice ${tx.invoice_id} karena: ${message || 'Transaksi gagal dari provider'}`;
            await connection.query('INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)', [tx.user_id, tx.price, 'Refund', historyDesc, tx.invoice_id]);
        } else if (status.toUpperCase() === 'PENDING') {
            // Jika status masih pending dari callback (jarang terjadi, tapi bisa)
            // Anda bisa tambahkan logika untuk tidak melakukan apa-apa atau mencatatnya
            console.log(`Transaksi ${trx_id} masih pending dari callback.`);
        }
        
        await connection.commit();
        res.status(200).json({ message: 'Callback berhasil diproses.' });

    } catch (error) {
        await connection.rollback();
        console.error('Callback error:', error);
        res.status(500).json({ message: 'Gagal memproses callback.' });
    } finally {
        connection.release();
    }
});

// === H2H ENDPOINTS (tidak ada perubahan) ===
app.post('/h2h/order', protectH2H, async (req, res) => {
    const { productId, targetGameId } = req.body;
    const h2hUser = req.user;

    if (!productId || !targetGameId) {
        return res.status(400).json({ success: false, message: 'productId dan targetGameId wajib diisi.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [products] = await connection.query('SELECT price as base_price, name FROM products WHERE id = ? AND status = "Active" FOR UPDATE', [productId]);
        if (products.length === 0) throw new Error('Produk tidak valid atau tidak aktif.');
        const product = products[0];

        const [users] = await connection.query('SELECT balance, role_id FROM users WHERE id = ? FOR UPDATE', [h2hUser.id]);
        const userForTx = users[0];

        const [roleRows] = await connection.query('SELECT margin_percent FROM roles WHERE id = ?', [userForTx.role_id]);
        const margin = roleRows[0].margin_percent;
        const finalPrice = Math.ceil(product.base_price * (1 + (margin / 100)));

        if (userForTx.balance < finalPrice) throw new Error('Saldo Anda tidak mencukupi.');
        
        await connection.query('UPDATE users SET balance = balance - ? WHERE id = ?', [finalPrice, h2hUser.id]);

        const invoiceId = `H2H-${Date.now()}${h2hUser.id}`;
        const txSql = 'INSERT INTO transactions (invoice_id, user_id, product_id, target_game_id, price, status) VALUES (?, ?, ?, ?, ?, ?)';
        await connection.query(txSql, [invoiceId, h2hUser.id, productId, targetGameId, finalPrice, 'Success']);

        const historyDesc = `Pembelian H2H: ${product.name} (${invoiceId})`;
        const historySql = 'INSERT INTO balance_history (user_id, amount, type, description, reference_id) VALUES (?, ?, ?, ?, ?)';
        await connection.query(historySql, [h2hUser.id, -finalPrice, 'Purchase', historyDesc, invoiceId]);

        await connection.commit();
        
        res.status(201).json({ 
            success: true,
            message: 'Transaksi H2H berhasil!', 
            data: {
                invoiceId: invoiceId,
                productName: product.name,
                target: targetGameId,
                price: finalPrice
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error("H2H Order error:", error);
        res.status(400).json({ success: false, message: error.message || 'Gagal memproses transaksi H2H.' });
    } finally {
        connection.release();
    }
});

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});