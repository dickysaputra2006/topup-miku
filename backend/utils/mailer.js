require('dotenv').config();
const axios = require('axios');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const sendPasswordResetEmail = async (userEmail, token) => {
    if (!BREVO_API_KEY) {
        console.error('Error: BREVO_API_KEY tidak diatur di file .env');
        throw new Error('Konfigurasi email server belum lengkap.');
    }

    const resetUrl = `https://mikutopup.my.id/reset-password.html?token=${token}`;
    
    // Ini adalah format data yang diminta oleh API Brevo
    const payload = {
        sender: {
            name: 'MIKU Store',
            email: 'noreply@mikutopup.my.id' 
        },
        to: [
            {
                email: userEmail
            }
        ],
        subject: 'Reset Password Akun MIKU Store Anda',
        htmlContent: `
            <p>Anda menerima email ini karena Anda (atau seseorang) meminta untuk mereset password akun Anda.</p>
            <p>Silakan klik link di bawah ini untuk menyelesaikan prosesnya:</p>
            <a href="${resetUrl}" style="background-color: #EC4899; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password Anda</a>
            <p>Jika Anda tidak merasa meminta ini, silakan abaikan email ini dan password Anda akan tetap aman.</p>
            <p>Note : Ini adalah email otomatis, mohon jangan membalas ke email ini.</p>
        `
    };

    const headers = {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json'
    };

    try {
        await axios.post(BREVO_API_URL, payload, { headers });
        console.log(`Email reset password (API) berhasil dikirim ke ${userEmail}`);
    } catch (error) {
        console.error(`Gagal mengirim email (API) ke ${userEmail}:`, error.response ? error.response.data : error.message);
        throw new Error('Gagal mengirim email reset password.');
    }
};

module.exports = { sendPasswordResetEmail };