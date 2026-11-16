const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { BOT_PRODUCT_BLACKLIST } = require('../config/constants');
const { logSafeError } = require('../utils/logger');
const {
    publicStatusLabel,
    maskInvoiceId,
    maskLeaderboardName,
    leaderboardRankLabel,
} = require('../utils/strings');
const { isValidInvoiceId, sanitizeValidationServiceName } = require('../utils/validation');

/**
 * Daftarkan seluruh route publik read-only (tanpa autentikasi).
 */
module.exports = function createPublicRoutes(deps) {
    const { pool } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createPublicRoutes requires a valid pool');
    }

    const router = express.Router();

    router.get('/healthz', (req, res) => {
        res.json({ ok: true, service: 'topup-miku' });
    });

    router.get('/api/games', async (req, res) => {
        try {
            const sql = "SELECT * FROM games WHERE status = 'Active' ORDER BY name ASC";
            const { rows } = await pool.query(sql);
            res.json(rows);
        } catch (error) {
            console.error('Error fetching public games:', error);
            res.status(500).json({ message: 'Server error saat mengambil data game.' });
        }
    });

    router.get('/api/games/validatable', async (req, res) => {
        try {
            const filePath = path.resolve(__dirname, '..', 'utils', 'validators', 'data_cekid.json');
            const cekIdDataBuffer = await fs.readFile(filePath);
            const cekIdGames = JSON.parse(cekIdDataBuffer.toString());

            const finalResult = cekIdGames.filter(game => game.name).map(game => ({
                id: game.name,
                name: sanitizeValidationServiceName(game.name),
                gameCode: game.game,
                hasZoneIdForValidation: game.hasZoneId
            }));

            res.json(finalResult);
        } catch (error) {
            console.error("Error fetching validatable games from JSON:", error);
            res.status(500).json({ message: 'Server error saat mengambil data game dari file.' });
        }
    });

    router.get('/api/games/:gameId/servers', async (req, res) => {
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

    router.get('/api/public/compare-prices', async (req, res) => {
        try {
            const { rows: products } = await pool.query(`
                SELECT p.id, p.game_id, p.name, p.provider_sku, p.price, g.name as game_name, 
                       p.use_manual_prices, p.manual_prices,
                       gm.use_custom_margin, gm.bronze_margin, gm.silver_margin, gm.gold_margin, gm.partner_margin
                FROM products p 
                JOIN games g ON p.game_id = g.id
                LEFT JOIN game_margins gm ON p.game_id = gm.game_id
                WHERE p.status = 'Active' ORDER BY g.name ASC, p.price ASC
            `);
            const { rows: roles } = await pool.query(`SELECT name, margin_percent FROM roles ORDER BY id ASC`);
            const { rows: games } = await pool.query("SELECT id, name FROM games WHERE status = 'Active' ORDER BY name ASC");
            const { rows: activeFlashSales } = await pool.query(
                `SELECT product_id, discount_price FROM flash_sales WHERE is_active = true AND NOW() BETWEEN start_at AND end_at`
            );
            const flashSaleMap = new Map(activeFlashSales.map(fs => [fs.product_id, Number(fs.discount_price)]));

            const productsWithRolePrices = products.map(product => {
                const productWithPrices = { 
                    id: product.id, game_name: product.game_name, product_name: product.name, 
                    provider_sku: product.provider_sku, base_price: product.price 
                }; 
                
                roles.forEach(role => {
                    const roleNameLower = role.name.toLowerCase();
                    let finalPrice;
                    const manualPrice = product.manual_prices ? product.manual_prices[roleNameLower] : null;

                    if (product.use_manual_prices && manualPrice) {
                        finalPrice = manualPrice;
                    } else {
                        let finalMargin = role.margin_percent;
                        if (product.use_custom_margin) {
                            finalMargin = product[`${roleNameLower}_margin`] || role.margin_percent;
                        }
                        finalPrice = Math.ceil(product.price * (1 + (finalMargin / 100)));
                    }
                    // Apply flash sale if active and lower than computed price
                    if (flashSaleMap.has(product.id)) {
                        const flashPrice = flashSaleMap.get(product.id);
                        if (flashPrice > 0 && flashPrice < finalPrice) {
                            finalPrice = flashPrice;
                        }
                    }
                    productWithPrices[`price_${roleNameLower}`] = finalPrice;
                });
                return productWithPrices;
            });

            res.json({ products: productsWithRolePrices, roles: roles, games: games });
        } catch (error) {
            console.error('Error fetching public compare prices:', error);
            res.status(500).json({ message: 'Server error saat mengambil data perbandingan harga.' });
        }
    });

    // Endpoint untuk mengambil produk flash sale yang aktif
    router.get('/api/public/flash-sales', async (req, res) => {
        try {
            const sql = `
                    SELECT 
                        fs.id as flash_sale_id,
                        fs.discount_price,
                        fs.end_at,
                        fs.end_at as end_time,
                        p.id as product_id,
                        p.name as product_name,
                        CEIL(p.price * (1 + COALESCE(r.margin_percent, 0) / 100)) as original_price,
                        g.id as game_id,
                        g.name as game_name,
                        g.image_url as game_image_url
                    FROM flash_sales fs
                    JOIN products p ON fs.product_id = p.id
                    JOIN games g ON p.game_id = g.id
                    LEFT JOIN roles r ON r.id = 1 
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

    // ambil pl dari role bronze di web untuk bot tele
    router.get('/api/public/bot-products/:gameName', async (req, res) => {
        try {
            const { gameName } = req.params;

            // 1. Dapatkan margin untuk role 'BRONZE' (INI YANG DIUBAH)
            const { rows: roleRows } = await pool.query("SELECT margin_percent FROM roles WHERE name = 'BRONZE'");
            if (roleRows.length === 0) {
                throw new Error("Role 'BRONZE' tidak ditemukan untuk perhitungan harga.");
            }
            const publicMargin = roleRows[0].margin_percent;

            // 2. Cari game berdasarkan nama
            const { rows: gameRows } = await pool.query("SELECT id FROM games WHERE name ILIKE $1 AND status = 'Active'", [`%${gameName}%`]);
            if (gameRows.length === 0) {
                return res.status(404).json({ success: false, message: 'Game tidak ditemukan.' });
            }
            const gameId = gameRows[0].id;

            // 3. Ambil semua produk untuk game tersebut
            const { rows: products } = await pool.query("SELECT name, price FROM products WHERE game_id = $1 AND status = 'Active' ORDER BY price ASC", [gameId]);

            // 4. Hitung harga jual akhir untuk setiap produk (LOGIKA DISINI JUGA BERUBAH)
            const finalProducts = products.map(p => {
                // Langsung hitung harga jual berdasarkan margin BRONZE
                const publicPrice = Math.ceil(p.price * (1 + publicMargin / 100));

                return {
                    name: p.name,
                    price: publicPrice
                };
            });

            res.json({ success: true, data: finalProducts });

        } catch (error) {
            console.error("Error di endpoint bot-products:", error);
            res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
        }
    });

    // --- ENDPOINT BARU UNTUK MENGAMBIL DAFTAR GAME UNTUK BOT (DENGAN BLACKLIST) ---
    router.get('/api/public/bot-games', async (req, res) => {
        try {
            const { rows: games } = await pool.query(
                "SELECT name, category FROM games WHERE status = 'Active' ORDER BY category, name"
            );

            // Filter game berdasarkan blacklist
            const filteredGames = games.filter(game => 
                !BOT_PRODUCT_BLACKLIST.some(keyword => game.name.toLowerCase().includes(keyword.toLowerCase()))
            );

            // Kelompokkan game yang sudah difilter berdasarkan kategori
            const groupedGames = filteredGames.reduce((acc, game) => {
                const category = game.category || 'Lainnya';
                if (!acc[category]) {
                    acc[category] = [];
                }
                acc[category].push(game.name);
                return acc;
            }, {});

            res.json({ success: true, data: groupedGames });
        } catch (error) {
            console.error("Error di endpoint bot-games:", error);
            res.status(500).json({ success: false, message: 'Gagal mengambil daftar game.' });
        }
    });

    // === PUBLIC CEK TRANSAKSI ENDPOINTS ===

    // GET /api/public/transaction/:invoiceId — cek satu transaksi (publik, tanpa login)
    router.get('/api/public/transaction/:invoiceId', async (req, res) => {
        try {
            const rawId = String(req.params.invoiceId || '').trim();
            // Hanya izinkan karakter aman [A-Za-z0-9_-] dengan panjang 3-64
            if (!isValidInvoiceId(rawId)) {
                return res.status(400).json({ message: 'Format invoice tidak valid.' });
            }

            const sql = `
                SELECT t.invoice_id, t.status, t.price, t.created_at, t.updated_at,
                       p.name AS product_name,
                       g.name AS game_name
                FROM transactions t
                JOIN products p ON t.product_id = p.id
                JOIN games g ON p.game_id = g.id
                WHERE t.invoice_id = $1
                LIMIT 1
            `;
            const { rows } = await pool.query(sql, [rawId]);

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Transaksi tidak ditemukan.' });
            }
            const tx = rows[0];

            return res.json({
                invoice_id:   tx.invoice_id,
                status:       tx.status,
                status_label: publicStatusLabel(tx.status),
                game_name:    tx.game_name,
                product_name: tx.product_name,
                price:        Number(tx.price),
                created_at:   tx.created_at,
                updated_at:   tx.updated_at
            });
        } catch (error) {
            logSafeError('[public/transaction] Error:', error);
            res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data transaksi.' });
        }
    });

    // GET /api/public/recent-transactions — 10 transaksi terbaru (invoice tersamarkan)
    router.get('/api/public/recent-transactions', async (req, res) => {
        try {
            const sql = `
                SELECT t.invoice_id, t.status, t.created_at,
                       p.name AS product_name,
                       g.name AS game_name
                FROM transactions t
                JOIN products p ON t.product_id = p.id
                JOIN games g ON p.game_id = g.id
                ORDER BY t.created_at DESC
                LIMIT 10
            `;
            const { rows } = await pool.query(sql);

            const result = rows.map(tx => ({
                invoice_masked: maskInvoiceId(tx.invoice_id),
                status:         tx.status,
                status_label:   publicStatusLabel(tx.status),
                game_name:      tx.game_name,
                product_name:   tx.product_name,
                created_at:     tx.created_at
            }));

            return res.json(result);
        } catch (error) {
            logSafeError('[public/recent-transactions] Error:', error);
            res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data transaksi.' });
        }
    });

    // === LEADERBOARD ENDPOINTS ===

    // GET /api/public/leaderboard — top buyer publik (read-only)
    router.get('/api/public/leaderboard', async (req, res) => {
        try {
            // Limit: default 10, max 50
            const rawLimit = parseInt(req.query.limit, 10);
            const limit = (Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 50) ? rawLimit : 10;

            // Period: all_time (default), monthly, weekly
            const period = String(req.query.period || 'all_time').toLowerCase();
            const VALID_PERIODS = ['all_time', 'monthly', 'weekly'];
            const safePeriod = VALID_PERIODS.includes(period) ? period : 'all_time';

            let periodClause = '';
            if (safePeriod === 'monthly') {
                periodClause = "AND t.created_at >= DATE_TRUNC('month', NOW())";
            } else if (safePeriod === 'weekly') {
                periodClause = "AND t.created_at >= NOW() - INTERVAL '7 days'";
            }
            // all_time: no extra clause

            const sql = `
                SELECT
                    u.username,
                    COUNT(t.id)::int          AS total_success_orders,
                    SUM(t.price)::numeric      AS total_spent,
                    MAX(t.created_at)          AS last_order_at
                FROM transactions t
                JOIN users u ON t.user_id = u.id
                WHERE t.status = 'Success'
                ${periodClause}
                GROUP BY u.id, u.username
                ORDER BY total_spent DESC, total_success_orders DESC
                LIMIT $1
            `;

            const { rows } = await pool.query(sql, [limit]);

            const leaderboard = rows.map((row, idx) => ({
                rank:                 idx + 1,
                display_name:         maskLeaderboardName(row.username),
                total_success_orders: row.total_success_orders,
                total_spent:          Number(row.total_spent) || 0,
                last_order_at:        row.last_order_at || null,
                rank_label:           leaderboardRankLabel(row.total_spent)
            }));

            return res.json({
                leaderboard,
                period:    safePeriod,
                generated_at: new Date().toISOString()
            });
        } catch (error) {
            logSafeError('[public/leaderboard] Error:', error);
            res.status(500).json({ message: 'Terjadi kesalahan saat mengambil data leaderboard.' });
        }
    });

    return router;
};
