const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

function isPrivateIP(ip) {
    if (net.isIP(ip) === 4) {
        const parts = ip.split('.').map(Number);
        return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
               (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
               (parts[0] === 192 && parts[1] === 168) ||
               (parts[0] === 169 && parts[1] === 254);
    }
    if (net.isIP(ip) === 6) {
        if (ip.toLowerCase().startsWith('::ffff:')) {
            return isPrivateIP(ip.toLowerCase().split('::ffff:')[1]);
        }
        return ip === '::1' || ip.toLowerCase().startsWith('fc') ||
               ip.toLowerCase().startsWith('fd') || ip.toLowerCase().startsWith('fe80');
    }
    return false;
}

const safeLookup = (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
        if (err) return callback(err);
        const addresses = Array.isArray(address) ? address.map(a => a.address) : [address];
        if (addresses.some(isPrivateIP)) {
            return callback(new Error('SSRF attempt blocked: Resolved to private IP'));
        }
        callback(null, address, family);
    });
};

const safeHttpAgent = new http.Agent({ lookup: safeLookup });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup });

module.exports = { safeHttpAgent, safeHttpsAgent };