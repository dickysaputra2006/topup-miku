require('dotenv').config();
const nodemailer = require('nodemailer');

// Konfigurasi transporter sekarang menggunakan SMTP biasa dari Brevo
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false, // false untuk port 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const sendPasswordResetEmail = async (userEmail, token) => {
    const resetUrl = `https://mikutopup.my.id/reset-password.html?token=${token}`;

    const mailOptions = {
        from: `"MIKU Store" <${process.env.EMAIL_USER}>`,
        to: userEmail,
        subject: 'Reset Password Akun MIKU Store Anda',
        text: `Anda menerima email ini karena Anda (atau seseorang) meminta untuk mereset password akun Anda.\n\nSilakan klik link di bawah ini, atau salin dan tempel ke browser Anda untuk menyelesaikan prosesnya:\n\n${resetUrl}\n\nJika Anda tidak merasa meminta ini, silakan abaikan email ini dan password Anda akan tetap aman.\n`,
        html: `
            <p>Anda menerima email ini karena Anda (atau seseorang) meminta untuk mereset password akun Anda.</p>
            <p>Silakan klik link di bawah ini untuk menyelesaikan prosesnya:</p>
            <a href="${resetUrl}" style="background-color: #EC4899; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password Anda</a>
            <p>Jika Anda tidak merasa meminta ini, silakan abaikan email ini dan password Anda akan tetap aman.</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email reset password berhasil dikirim ke ${userEmail}`);
    } catch (error) {
        console.error(`Gagal mengirim email ke ${userEmail}:`, error);
        throw new Error('Gagal mengirim email reset password.');
    }
};

module.exports = { sendPasswordResetEmail };