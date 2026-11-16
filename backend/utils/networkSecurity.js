const net = require('net');

const FULL_32_MASK = (1n << 32n) - 1n;
const FULL_128_MASK = (1n << 128n) - 1n;

/**
 * Buat bitmask BigInt sepanjang `prefix` dari total `bits` (32 atau 128).
 */
function createCidrMask(bits, prefix) {
    if (prefix === 0) return 0n;
    const totalMask = bits === 32 ? FULL_32_MASK : FULL_128_MASK;
    return ((~0n << BigInt(bits - prefix)) & totalMask);
}

/**
 * Bersihkan tanda kurung siku IPv6 (`[...]`) dan zone identifier (`%eth0`).
 */
function stripIpDecorations(rawIp) {
    if (typeof rawIp !== 'string') return '';
    let value = rawIp.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
    }
    const zoneIndex = value.indexOf('%');
    if (zoneIndex !== -1) {
        value = value.slice(0, zoneIndex);
    }
    return value.trim().toLowerCase();
}

/**
 * Parse alamat IPv4 menjadi unsigned 32-bit BigInt, atau null jika tidak valid.
 */
function parseIpv4ToBigInt(rawIp) {
    const ip = stripIpDecorations(rawIp);
    if (net.isIP(ip) !== 4) return null;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
    }
    return (
        (BigInt(parts[0]) << 24n) |
        (BigInt(parts[1]) << 16n) |
        (BigInt(parts[2]) << 8n) |
        BigInt(parts[3])
    );
}

/**
 * Parse alamat IPv6 (termasuk IPv4-embedded seperti ::ffff:127.0.0.1) menjadi unsigned 128-bit BigInt.
 */
function parseIpv6ToBigInt(rawIp) {
    const ip = stripIpDecorations(rawIp);
    if (net.isIP(ip) !== 6) return null;

    let normalized = ip;
    if (normalized.includes('.')) {
        const lastColon = normalized.lastIndexOf(':');
        const v4Part = normalized.slice(lastColon + 1);
        const v4Int = parseIpv4ToBigInt(v4Part);
        if (v4Int === null) return null;
        const hi = ((v4Int >> 16n) & 0xffffn).toString(16);
        const lo = (v4Int & 0xffffn).toString(16);
        normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
    }

    const halves = normalized.split('::');
    if (halves.length > 2) return null;

    let groups;
    if (halves.length === 2) {
        const left = halves[0] ? halves[0].split(':') : [];
        const right = halves[1] ? halves[1].split(':') : [];
        const missing = 8 - (left.length + right.length);
        if (missing < 1) return null;
        groups = [...left, ...Array(missing).fill('0'), ...right];
    } else {
        groups = normalized.split(':');
    }

    if (groups.length !== 8) return null;

    let acc = 0n;
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        acc = (acc << 16n) | BigInt(parseInt(group, 16));
    }
    return acc;
}

/**
 * Parse IP ke representasi ternormalisasi.
 * IPv4-mapped IPv6 (::ffff:x.x.x.x) mengekstrak v4 sekaligus menyimpan bentuk 128-bit v6.
 */
function parseNormalizedIp(rawIp) {
    const cleaned = stripIpDecorations(rawIp);
    const v4 = parseIpv4ToBigInt(cleaned);
    if (v4 !== null) {
        return {
            family: 4,
            v4,
            v6: (0xffffn << 32n) | v4,
            isMappedV4: false
        };
    }

    const v6 = parseIpv6ToBigInt(cleaned);
    if (v6 !== null) {
        const isMappedV4 = (v6 >> 32n) === 0xffffn;
        return {
            family: isMappedV4 ? 4 : 6,
            v4: isMappedV4 ? (v6 & FULL_32_MASK) : null,
            v6,
            isMappedV4
        };
    }

    return null;
}

/**
 * Validasi format IP tunggal atau CIDR (IPv4 maupun IPv6) untuk input whitelist user.
 */
function isValidIpOrCidr(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const parts = trimmed.split('/');
    if (parts.length > 2) return false;

    const ipPart = stripIpDecorations(parts[0]);
    const family = net.isIP(ipPart);
    if (!family) return false;

    if (parts.length === 1) return true;
    const prefixStr = parts[1];
    if (!/^\d{1,3}$/.test(prefixStr)) return false;
    const prefixNumber = Number(prefixStr);
    return family === 4
        ? prefixNumber >= 0 && prefixNumber <= 32
        : prefixNumber >= 0 && prefixNumber <= 128;
}

/**
 * Periksa apakah IP merupakan alamat loopback (127.0.0.0/8, ::1, atau ::ffff:127.0.0.0/104).
 */
function isLoopbackIp(rawIp) {
    const parsed = parseNormalizedIp(rawIp);
    if (!parsed) return false;
    if (parsed.v4 !== null) {
        return (parsed.v4 & createCidrMask(32, 8)) === (parseIpv4ToBigInt('127.0.0.0') & createCidrMask(32, 8));
    }
    return parsed.v6 === 1n;
}

/**
 * Cocokkan IP request terhadap daftar IP tunggal dan/atau CIDR (IPv4 & IPv6),
 * termasuk normalisasi ::ffff:x.x.x.x agar cocok dengan rule IPv4/CIDR IPv4.
 */
function isIpInAllowList(requestIp, allowList) {
    if (!Array.isArray(allowList) || allowList.length === 0) return true;
    const reqParsed = parseNormalizedIp(requestIp);
    if (!reqParsed) return false;

    for (const rawRule of allowList) {
        if (typeof rawRule !== 'string') continue;
        const trimmed = rawRule.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('/');
        if (parts.length > 2) continue;

        const ruleIpStr = stripIpDecorations(parts[0]);
        const ruleFamily = net.isIP(ruleIpStr);
        if (!ruleFamily) continue;

        const maxPrefix = ruleFamily === 4 ? 32 : 128;
        let prefix = maxPrefix;
        if (parts.length === 2) {
            if (!/^\d{1,3}$/.test(parts[1])) continue;
            prefix = Number(parts[1]);
            if (prefix < 0 || prefix > maxPrefix) continue;
        }

        if (ruleFamily === 4) {
            if (reqParsed.v4 === null) continue;
            const ruleV4 = parseIpv4ToBigInt(ruleIpStr);
            if (ruleV4 === null) continue;
            const mask = createCidrMask(32, prefix);
            if ((reqParsed.v4 & mask) === (ruleV4 & mask)) {
                return true;
            }
        } else {
            const ruleV6 = parseIpv6ToBigInt(ruleIpStr);
            if (ruleV6 === null) continue;
            const mask = createCidrMask(128, prefix);
            if ((reqParsed.v6 & mask) === (ruleV6 & mask)) {
                return true;
            }
        }
    }

    return false;
}

const OUTBOUND_BLOCKED_V4_CIDRS = [
    ['0.0.0.0', 8],       // RFC 1122 "this network"
    ['10.0.0.0', 8],      // RFC 1918 private
    ['100.64.0.0', 10],   // RFC 6598 CGNAT
    ['127.0.0.0', 8],     // RFC 1122 loopback
    ['169.254.0.0', 16],  // RFC 3927 link-local / cloud metadata
    ['172.16.0.0', 12],   // RFC 1918 private
    ['192.0.0.0', 24],    // RFC 6890 IETF protocol assignments
    ['192.168.0.0', 16],  // RFC 1918 private
    ['224.0.0.0', 4],     // Multicast
    ['240.0.0.0', 4]      // Reserved / limited broadcast
].map(([ip, prefix]) => {
    const mask = createCidrMask(32, prefix);
    return { network: parseIpv4ToBigInt(ip) & mask, mask };
});

const OUTBOUND_BLOCKED_V6_CIDRS = [
    ['::', 128],          // Unspecified
    ['::1', 128],         // Loopback
    ['::ffff:0:0', 96],   // IPv4-mapped IPv6
    ['::', 96],           // Deprecated IPv4-compatible IPv6
    ['64:ff9b::', 96],    // NAT64 well-known
    ['64:ff9b:1::', 48],  // NAT64 local-use
    ['100::', 64],        // Discard-only
    ['fc00::', 7],        // Unique local address (ULA)
    ['fe80::', 10],       // Link-local (fe80:: - febf::)
    ['fec0::', 10],       // Deprecated site-local
    ['ff00::', 8]         // Multicast
].map(([ip, prefix]) => {
    const mask = createCidrMask(128, prefix);
    return { network: parseIpv6ToBigInt(ip) & mask, mask };
});

/**
 * Periksa apakah alamat IP termasuk rentang internal/khusus yang dilarang untuk request keluar (SSRF).
 * Mengembalikan true untuk private, loopback, link-local, CGNAT, 0.0.0.0/8, ULA, multicast/reserved, dan ::ffff:0:0/96.
 */
function isRestrictedIpForOutbound(rawIp) {
    const cleaned = stripIpDecorations(rawIp);
    const v4 = parseIpv4ToBigInt(cleaned);
    if (v4 !== null) {
        return OUTBOUND_BLOCKED_V4_CIDRS.some(({ network, mask }) => (v4 & mask) === network);
    }

    const v6 = parseIpv6ToBigInt(cleaned);
    if (v6 !== null) {
        return OUTBOUND_BLOCKED_V6_CIDRS.some(({ network, mask }) => (v6 & mask) === network);
    }

    return true;
}

/**
 * Periksa hostname teks untuk tujuan lokal/internal yang tidak diizinkan.
 */
function isRestrictedHostname(rawHostname) {
    const host = stripIpDecorations(rawHostname).replace(/\.+$/, '');
    if (!host) return true;
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host.endsWith('.localdomain')
    ) {
        return true;
    }
    if (net.isIP(host)) {
        return isRestrictedIpForOutbound(host);
    }
    return false;
}

module.exports = {
    stripIpDecorations,
    parseIpv4ToBigInt,
    parseIpv6ToBigInt,
    parseNormalizedIp,
    isValidIpOrCidr,
    isLoopbackIp,
    isIpInAllowList,
    isRestrictedIpForOutbound,
    isRestrictedHostname
};
