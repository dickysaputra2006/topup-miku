require('dotenv').config();
const nodemailer = require('nodemailer');
const { safeErrorDetail } = require('./logger');

const SMTP_TIMEOUT_MS = 10000;

/**
 * Baca konfigurasi SMTP Sumopod/Nodemailer secara dinamis dari environment variables.
 */
function getSmtpConfig() {
    const host = String(process.env.SMTP_HOST || 'smtp.sumopod.com').trim();
    const parsedPort = Number(process.env.SMTP_PORT || '465');
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 465;

    const rawSecure = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
    const secure = rawSecure === 'true' ? true : (rawSecure === 'false' ? false : port === 465);

    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '');
    const fromName = String(process.env.SMTP_FROM_NAME || 'MIKU Store').replace(/[\r\n"]/g, '').trim() || 'MIKU Store';
    const fromEmail = String(process.env.SMTP_FROM_EMAIL || 'noreply@mikutopup.my.id').replace(/[\r\n<>]/g, '').trim() || 'noreply@mikutopup.my.id';
    const appBaseUrl = String(process.env.APP_BASE_URL || 'https://mikutopup.my.id').trim().replace(/\/+$/, '');

    return { host, port, secure, user, pass, fromName, fromEmail, appBaseUrl };
}

/**
 * Buat instance transporter SMTP Nodemailer dengan batas timeout terukur.
 */
function createSmtpTransporter(config = getSmtpConfig()) {
    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.pass,
        },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
    });
}

/**
 * Kirim email tautan reset password menggunakan SMTP Nodemailer.
 */
async function sendPasswordResetEmail(userEmail, token) {
    const config = getSmtpConfig();
    if (!config.host || !config.user || !config.pass) {
        console.error('Error: SMTP_HOST, SMTP_USER, atau SMTP_PASS belum diatur di file .env');
        throw new Error('Konfigurasi email server belum lengkap.');
    }

    const safeTo = String(userEmail || '').replace(/[\r\n<>]/g, '').trim();
    const resetUrl = `${config.appBaseUrl}/reset-password.html?token=${encodeURIComponent(String(token || ''))}`;
    const transporter = createSmtpTransporter(config);

    try {
        await transporter.sendMail({
            from: `"${config.fromName}" <${config.fromEmail}>`,
            to: safeTo,
            subject: 'Reset Password Akun MIKU Store Anda',
            text: [
                'Anda menerima email ini karena ada permintaan untuk mereset password akun MIKU Store Anda.',
                `Silakan buka tautan berikut untuk menyelesaikan prosesnya: ${resetUrl}`,
                'Jika Anda tidak merasa meminta ini, silakan abaikan email ini.',
            ].join('\n\n'),
            html: [
                '<p>Anda menerima email ini karena Anda (atau seseorang) meminta untuk mereset password akun Anda.</p>',
                '<p>Silakan klik link di bawah ini untuk menyelesaikan prosesnya:</p>',
                `<a href="${resetUrl}" style="background-color: #EC4899; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password Anda</a>`,
                '<p>Jika Anda tidak merasa meminta ini, silakan abaikan email ini dan password Anda akan tetap aman.</p>',
                '<p>Note : Ini adalah email otomatis, mohon jangan membalas ke email ini.</p>',
            ].join('\n'),
        });
        console.log('Email reset password (SMTP) berhasil dikirim.');
    } catch (error) {
        const safeDetail = safeErrorDetail(error);
        if (config.pass && safeDetail && typeof safeDetail.message === 'string') {
            safeDetail.message = safeDetail.message.split(config.pass).join('[REDACTED]');
        }
        console.error('Gagal mengirim email reset password (SMTP):', safeDetail);
        throw new Error('Gagal mengirim email reset password.');
    }
}

module.exports = {
    SMTP_TIMEOUT_MS,
    getSmtpConfig,
    createSmtpTransporter,
    sendPasswordResetEmail,
};
