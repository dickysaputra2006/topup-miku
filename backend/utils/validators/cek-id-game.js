const axios = require('axios');

// Fungsi baru untuk menerapkan aturan pada hasil validasi
function applyValidationRules(validationData, rules) {
    if (!rules || Object.keys(rules).length === 0) {
        return { valid: true }; // Jika tidak ada aturan, selalu valid
    }

    const { region } = validationData;

    // Aturan untuk region yang diizinkan (allowedRegions)
    if (rules.allowedRegions && !rules.allowedRegions.includes(region.toUpperCase())) {
        return { valid: false, message: `Akun ini bukan dari region yang diizinkan (${rules.allowedRegions.join(', ')}).` };
    }

    // Aturan untuk region yang dilarang (disallowedRegions)
    if (rules.disallowedRegions && rules.disallowedRegions.includes(region.toUpperCase())) {
        return { valid: false, message: `Akun dari region ${region} tidak dapat membeli produk ini.` };
    }

    return { valid: true }; // Lolos semua aturan
}

async function validateGameId(gameCode, userId, zoneId = null, rules = {}) {
    const pgsKey = process.env.PGS_KEY;
    const pgsApiKey = process.env.PGS_API_KEY;

    if (!pgsKey || !pgsApiKey) {
        return { success: false, message: "Kunci API untuk validasi belum diatur di server." };
    }

    try {
        const apiUrl = 'https://pgscode.id/api/tools/run';
        const payload = {
            key: pgsKey,
            api_key: pgsApiKey,
            action: "get-nick",
            target: {
                user_id: String(userId).trim(),
                game: gameCode,
            }
        };

        if (zoneId) {
            payload.target.server_id = String(zoneId).trim();
        }

        const response = await axios.post(apiUrl, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        
        if (response.data && response.data.status === true && response.data.data && response.data.data.username) {
            const validationData = response.data.data;
            
            // Terapkan aturan di sini!
            const ruleCheck = applyValidationRules(validationData, rules);

            if (!ruleCheck.valid) {
                // Gagal karena aturan tidak terpenuhi
                return { success: false, message: ruleCheck.message };
            }
            
            // Sukses dan lolos semua aturan
            return { success: true, data: validationData };
        } else {
            const errorMessage = response.data?.data?.msg || response.data?.message || "ID/Zone tidak valid atau tidak ditemukan.";
            return { success: false, message: errorMessage };
        }
    } catch (error) {
        console.error(`[validateGame] Error saat request API untuk ${gameCode}:`, error.response ? error.response.data : error.message);
        throw new Error("Terjadi kesalahan saat menghubungi server validasi.");
    }
}

module.exports = { validateGameId };