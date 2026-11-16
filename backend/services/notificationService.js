/**
 * Buat fungsi pembantu pencatatan notifikasi user dengan pool yang diberikan.
 */
function createNotificationService(deps) {
    const { pool } = deps || {};
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('createNotificationService requires a valid pool');
    }

    return async function createNotification(userId, message, link = null) {
        try {
            const sql = 'INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)';
            await pool.query(sql, [userId, message, link]);
            console.log(`Notifikasi dibuat untuk user ${userId}: "${message}"`);
        } catch (error) {
            console.error(`Gagal membuat notifikasi untuk user ${userId}:`, error);
        }
    };
}

module.exports = {
    createNotificationService,
};
