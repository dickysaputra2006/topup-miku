const express = require('express');
const app = express();
const PORT = 4000; // Jalankan di port yang berbeda

app.use(express.json());

// API ini seolah-olah dari Foxy Gamestore
app.get('/foxy-api/products', (req, res) => {
    // Ini adalah contoh data yang akan kita dapatkan dari provider
    const productListFromFoxy = [
        { sku: 'ML_D_100', game: 'Mobile Legends', category: 'Diamonds', name: '100 Diamonds', base_price: 25000 },
        { sku: 'ML_D_250', game: 'Mobile Legends', category: 'Diamonds', name: '250 Diamonds', base_price: 60000 },
        { sku: 'ML_W_PASS', game: 'Mobile Legends', category: 'Weekly Pass', name: 'Weekly Diamond Pass', base_price: 28000 },
        { sku: 'PUBG_UC_300', game: 'PUBG Mobile', category: 'UC', name: '300 UC', base_price: 70000 },
    ];
    res.json(productListFromFoxy);
});

app.listen(PORT, () => {
    console.log(`[SIMULATOR] API Provider Foxy berjalan di http://localhost:${PORT}`);
});