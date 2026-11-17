const http = require('http');
const crypto = require('crypto');
const path = require('path');

require(path.resolve(__dirname, '../../backend/node_modules/dotenv')).config({
    path: path.resolve(__dirname, '../../backend/.env'),
});

/**
 * Kirim callback simulasi ke endpoint lokal Foxy callback (/api/foxy/callback)
 * beserta helper verifikasi signature HMAC-SHA256 webhook H2H.
 */
function postJson(urlStr, payload, headers = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(urlStr);
        const raw = JSON.stringify(payload);
        const req = http.request({
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(raw),
                ...headers,
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch { /* plain text */ }
                resolve({ status: res.statusCode, body, json });
            });
        });
        req.on('error', reject);
        req.write(raw);
        req.end();
    });
}

async function sendFoxyCallback({
    callbackUrl = process.env.FOXY_CALLBACK_URL || 'http://localhost:3000/api/foxy/callback',
    trxId,
    token = (process.env.FOXY_CALLBACK_SECRET || '').trim(),
    tokenPlacement = 'header', // header | query | none
    extraBody = {},
} = {}) {
    const target = new URL(callbackUrl);
    const headers = {};
    if (tokenPlacement === 'header' && token) {
        headers['X-Callback-Token'] = token;
    } else if (tokenPlacement === 'query' && token) {
        target.searchParams.set('token', token);
    }
    return postJson(target.toString(), { trx_id: trxId, ...extraBody }, headers);
}

function verifyH2HWebhookSignature({ rawBody, timestampHeader, signatureHeader, secret, maxAgeSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000) }) {
    if (!timestampHeader || !signatureHeader || !secret) {
        return { ok: false, reason: 'missing_header_or_secret' };
    }
    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > maxAgeSeconds) {
        return { ok: false, reason: 'timestamp_out_of_window' };
    }
    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestampHeader}.${rawBody}`)
        .digest('hex');
    const a = Buffer.from(String(signatureHeader), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { ok: false, reason: 'signature_mismatch' };
    }
    return { ok: true };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const trxArg = args.find((a) => !a.startsWith('--'));
    const modeArg = (args.find((a) => a.startsWith('--token-mode=')) || '--token-mode=header').split('=')[1];
    const customToken = (args.find((a) => a.startsWith('--token=')) || '').split('=')[1];
    const mockUrl = (args.find((a) => a.startsWith('--mock-url=')) || '--mock-url=http://127.0.0.1:4010').split('=')[1];
    const statusArg = (args.find((a) => a.startsWith('--status=')) || '').split('=')[1];

    if (!trxArg) {
        console.error('Usage: node mocks/callbackSender.js <trx_id> [--status=SUCCESS|FAILED|PARTIAL_REFUND] [--token-mode=header|query|none] [--token=xxx]');
        process.exit(1);
    }

    (async () => {
        if (statusArg) {
            await postJson(`${mockUrl}/__mock/mode`, {
                statusOverrides: { [trxArg]: { status: statusArg.toUpperCase() } },
            });
        }
        const res = await sendFoxyCallback({
            trxId: trxArg,
            tokenPlacement: modeArg,
            ...(customToken !== undefined ? { token: customToken } : {}),
        });
        console.log('Callback response:', res.status, res.body);
    })().catch((err) => {
        console.error('Callback sender error:', err.message);
        process.exit(1);
    });
}

module.exports = {
    postJson,
    sendFoxyCallback,
    verifyH2HWebhookSignature,
};
