const { test, describe } = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');
const { sendPasswordResetEmail, SMTP_TIMEOUT_MS } = require('../../utils/mailer');

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'SMTP_FROM_EMAIL', 'APP_BASE_URL'];

function captureAndSetEnv(overrides) {
    const saved = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    return () => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    };
}

describe('Mailer Unit Tests (Sumopod SMTP / Nodemailer)', () => {
    test('tolak kirim saat SMTP_USER atau SMTP_PASS belum diatur tanpa memanggil transporter', async () => {
        const restoreEnv = captureAndSetEnv({ SMTP_HOST: 'smtp.sumopod.com' });
        const origCreateTransport = nodemailer.createTransport;
        let called = false;
        nodemailer.createTransport = () => {
            called = true;
            return { sendMail: async () => ({}) };
        };
        try {
            await assert.rejects(
                () => sendPasswordResetEmail('buyer@example.com', 'tok-123'),
                { message: 'Konfigurasi email server belum lengkap.' }
            );
            assert.strictEqual(called, false);
        } finally {
            nodemailer.createTransport = origCreateTransport;
            restoreEnv();
        }
    });

    test('menggunakan default Sumopod SMTP port 465 SSL true, timeout 10s, dan payload reset mikutopup.my.id', async () => {
        const restoreEnv = captureAndSetEnv({
            SMTP_USER: 'smtp-user',
            SMTP_PASS: 'smtp-pass-secret',
            SMTP_FROM_NAME: 'MIKU Store',
            SMTP_FROM_EMAIL: 'noreply@mikutopup.my.id',
            APP_BASE_URL: 'https://mikutopup.my.id/'
        });
        const origCreateTransport = nodemailer.createTransport;
        let capturedTransport = null;
        let capturedMail = null;

        nodemailer.createTransport = (opts) => {
            capturedTransport = opts;
            return {
                sendMail: async (mail) => {
                    capturedMail = mail;
                    return { messageId: 'sumopod-msg-1' };
                }
            };
        };

        try {
            await sendPasswordResetEmail('buyer@example.com', 'abc123token');
            assert.strictEqual(capturedTransport.host, 'smtp.sumopod.com');
            assert.strictEqual(capturedTransport.port, 465);
            assert.strictEqual(capturedTransport.secure, true);
            assert.deepStrictEqual(capturedTransport.auth, { user: 'smtp-user', pass: 'smtp-pass-secret' });
            assert.strictEqual(capturedTransport.connectionTimeout, SMTP_TIMEOUT_MS);
            assert.strictEqual(capturedTransport.greetingTimeout, SMTP_TIMEOUT_MS);
            assert.strictEqual(capturedTransport.socketTimeout, SMTP_TIMEOUT_MS);

            assert.strictEqual(capturedMail.from, '"MIKU Store" <noreply@mikutopup.my.id>');
            assert.strictEqual(capturedMail.to, 'buyer@example.com');
            assert.ok(capturedMail.text.includes('https://mikutopup.my.id/reset-password.html?token=abc123token'));
            assert.ok(capturedMail.html.includes('https://mikutopup.my.id/reset-password.html?token=abc123token'));
        } finally {
            nodemailer.createTransport = origCreateTransport;
            restoreEnv();
        }
    });

    test('menangani error SMTP dengan pesan aman tanpa membocorkan SMTP_PASS ke log/caller', async () => {
        const restoreEnv = captureAndSetEnv({
            SMTP_HOST: 'smtp.sumopod.com',
            SMTP_PORT: '465',
            SMTP_SECURE: 'true',
            SMTP_USER: 'smtp-user',
            SMTP_PASS: 'UltraSecretSmtpPass999'
        });
        const origCreateTransport = nodemailer.createTransport;
        const origConsoleErr = console.error;
        const logged = [];
        console.error = (...args) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        nodemailer.createTransport = () => ({
            sendMail: async () => {
                throw new Error('535 Authentication failed for UltraSecretSmtpPass999');
            }
        });

        try {
            await assert.rejects(
                () => sendPasswordResetEmail('buyer@example.com', 'tok-xyz'),
                { message: 'Gagal mengirim email reset password.' }
            );
            assert.strictEqual(logged.join('\n').includes('UltraSecretSmtpPass999'), false, 'Password SMTP tidak boleh muncul di log');
        } finally {
            console.error = origConsoleErr;
            nodemailer.createTransport = origCreateTransport;
            restoreEnv();
        }
    });
});
