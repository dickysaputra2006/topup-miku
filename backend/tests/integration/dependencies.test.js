const { test, describe, mock } = require('node:test');
const assert = require('node:assert');
const { pool, startServer } = require('../helpers/appFactory');

describe('Phase 10: SEC-006 Dependency Vulnerability Hardening', () => {
    const fs = require('fs');
    const path = require('path');
    const { createRequire } = require('module');
    const backendDir = path.join(__dirname, '../..');

    function parseSemver(ver) {
        const clean = String(ver || '').trim().replace(/^[^\d]*/, '').split('-')[0];
        const parts = clean.split('.').map(n => Number.parseInt(n, 10) || 0);
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
    }

    function compareSemver(a, b) {
        const pa = parseSemver(a);
        const pb = parseSemver(b);
        for (let i = 0; i < 3; i += 1) {
            if (pa[i] !== pb[i]) return pa[i] - pb[i];
        }
        return 0;
    }

    function getLockEntries(lockJson, pkgName) {
        const suffix = `node_modules/${pkgName}`;
        return Object.entries(lockJson.packages || {})
            .filter(([pkgPath]) => pkgPath === suffix || pkgPath.endsWith(`/${suffix}`))
            .map(([pkgPath, meta]) => ({ pkgPath, version: meta && meta.version }));
    }

    test('package-lock.json dipertahankan dan seluruh dependensi SEC-006 memenuhi versi aman minimum', () => {
        const pkgPath = path.join(backendDir, 'package.json');
        const lockPath = path.join(backendDir, 'package-lock.json');
        assert.ok(fs.existsSync(lockPath), 'backend/package-lock.json harus dipertahankan');

        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const lockJson = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.ok(lockJson.lockfileVersion >= 2, 'lockfileVersion harus valid');

        const rootLockDeps = (lockJson.packages && lockJson.packages[''] && lockJson.packages[''].dependencies) || {};
        assert.deepStrictEqual(rootLockDeps, pkgJson.dependencies, 'dependencies root package-lock.json harus sinkron dengan package.json');

        const minVersions = [
            { name: 'axios', min: '1.20.0', maxExclusive: '2.0.0' },
            { name: 'form-data', min: '4.0.6' },
            { name: 'follow-redirects', min: '1.16.0' },
            { name: 'express', min: '4.22.3', maxExclusive: '5.0.0' },
            { name: 'proxy-addr', min: '2.0.8' },
            { name: 'body-parser', min: '1.20.9' },
            { name: 'qs', min: '6.16.1' },
            { name: 'express-rate-limit', min: '8.6.0', maxExclusive: '9.0.0' },
            { name: 'ip-address', min: '10.7.4' },
            { name: 'jws', min: '3.2.3' },
        ];

        for (const rule of minVersions) {
            const entries = getLockEntries(lockJson, rule.name);
            assert.ok(entries.length > 0, `Dependensi ${rule.name} harus tercatat di package-lock.json`);
            for (const entry of entries) {
                assert.ok(
                    compareSemver(entry.version, rule.min) >= 0,
                    `${entry.pkgPath} (${entry.version}) masih di bawah versi aman >= ${rule.min}`
                );
                if (rule.maxExclusive) {
                    assert.ok(
                        compareSemver(entry.version, rule.maxExclusive) < 0,
                        `${entry.pkgPath} (${entry.version}) tidak boleh melompat ke major >= ${rule.maxExclusive}`
                    );
                }
            }
        }
    });

    test('qs bebas crash TypeError pada comma-format array null dan non-callable toString (GHSA-q8mj-m7cp-5q26, GHSA-6pq8-jhm2-2vcw)', () => {
        const expressReq = createRequire(require.resolve('express'));
        const bodyParserReq = createRequire(expressReq.resolve('body-parser'));
        const qsInstances = [expressReq('qs'), bodyParserReq('qs')];

        for (const qs of qsInstances) {
            assert.doesNotThrow(() => {
                qs.stringify({ a: [null, 'b'] }, { arrayFormat: 'comma', encodeValuesOnly: true });
            }, 'qs.stringify dengan elemen null pada arrayFormat comma tidak boleh crash TypeError');

            assert.doesNotThrow(() => {
                qs.stringify({ a: [{ toString: null }] }, { arrayFormat: 'comma' });
            }, 'qs.stringify dengan toString: null pada arrayFormat comma tidak boleh crash TypeError');
        }
    });

    test('form-data mensanitasi/menolak injeksi CRLF pada nama field multipart (GHSA-hmw2-7cc7-3qxx)', () => {
        const axiosReq = createRequire(require.resolve('axios'));
        const FormData = axiosReq('form-data');
        const fd = new FormData();
        fd.append('bad\r\nfield', 'val');
        const body = fd.getBuffer().toString();
        assert.ok(!body.includes('bad\r\nfield'), 'form-data tidak boleh menyisipkan CRLF mentah ke header multipart');
    });

    test('ip-address mengenali rentang penuh link-local IPv6 fe80::/10 (GHSA-rpw4-54j3-4h4q)', () => {
        const rateLimitReq = createRequire(require.resolve('express-rate-limit'));
        const { Address6 } = rateLimitReq('ip-address');
        assert.strictEqual(new Address6('febf::1').isLinkLocal(), true);
    });

    test('Express + trust proxy + rate limiter + body-parser + JWT tetap kompatibel pasca-upgrade', async () => {
        const jwt = require('jsonwebtoken');
        const srv = startServer(0);
        const origQuery = pool.query;
        try {
            const port = srv.address().port;
            const baseUrl = `http://127.0.0.1:${port}`;
            const testIp = '198.51.100.206';

            const resNoToken = await fetch(`${baseUrl}/api/user/profile`, {
                headers: { 'X-Forwarded-For': testIp }
            });
            assert.strictEqual(resNoToken.status, 401);
            assert.ok(resNoToken.headers.get('ratelimit-limit') || resNoToken.headers.get('ratelimit-policy'));

            mock.method(pool, 'query', async () => ({
                rows: [{ id: 206, username: 'sec006user', email: 'sec006@example.com', nomor_wa: '+628123456789', balance: '50000', role_name: 'BRONZE' }]
            }));
            const token = jwt.sign({ id: 206, username: 'sec006user', role: 'BRONZE' }, process.env.JWT_SECRET, { expiresIn: '1h' });
            const resProfile = await fetch(`${baseUrl}/api/user/profile`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Forwarded-For': testIp
                }
            });
            assert.strictEqual(resProfile.status, 200);
            const profileData = await resProfile.json();
            assert.strictEqual(profileData.username, 'sec006user');

            const resBadJson = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': testIp
                },
                body: '{"broken":'
            });
            assert.strictEqual(resBadJson.status, 400);
        } finally {
            pool.query = origQuery;
            await new Promise(resolve => srv.close(resolve));
        }
    });
});
