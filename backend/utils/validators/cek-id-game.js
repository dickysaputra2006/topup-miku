const axios = require('axios');

async function validateGameId(gameCode, userId, zoneId = null) {
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

        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.status === true && response.data.data && response.data.data.username) {
            return { success: true, data: response.data.data };
        } else {
            const errorMessage = response.data?.data?.msg || response.data?.message || "ID/Zone tidak valid atau tidak ditemukan.";
            return { success: false, message: errorMessage };
        }
    } catch (error) {
        console.error(`[validateGame] Error saat request API untuk ${gameCode}:`, error.response ? error.response.data : error.message);
        // Lempar error agar bisa ditangkap oleh blok catch di server.js
        throw new Error("Terjadi kesalahan saat menghubungi server validasi.");
    }
}

module.exports = { validateGameId };