const axios = require('axios');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

function isPrivateIp(ip) {
    if (net.isIP(ip) === 4) {
        const parts = ip.split('.').map(Number);
        return parts[0] === 10 ||
            parts[0] === 127 ||
            parts[0] === 0 || // Block 0.0.0.0/8 which routes to localhost on linux/mac
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168) ||
            (parts[0] === 169 && parts[1] === 254);
    }
    if (net.isIP(ip) === 6) {
        const lower = ip.toLowerCase();
        // Check for IPv6 loopback (::1), unspecified (::), unique local (fc00::/7), link local (fe80::/10),
        // and IPv4-mapped loopback/unspecified addresses.
        return lower === '::1' ||
               lower === '::' ||
               lower.startsWith('fc') ||
               lower.startsWith('fd') ||
               lower.startsWith('fe80') ||
               lower.includes('127.') || // crude but effective for mapped v4 loopbacks e.g. ::ffff:127.0.0.1
               lower.endsWith(':0.0.0.0'); // crude for mapped unspecified
    }
    return false;
}

// Custom lookup function that resolves the hostname, validates the IP, and passes it to the socket
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (err, address, family) => {
        if (err) {
            return callback(err);
        }

        // Handle Happy Eyeballs / Node 20+ `{ all: true }` which returns an array of addresses
        if (Array.isArray(address)) {
            for (const addrObj of address) {
                if (isPrivateIp(addrObj.address)) {
                     return callback(new Error(`SSRF Prevention: Hostname '${hostname}' resolved to private IP '${addrObj.address}', which is blocked.`));
                }
            }
        } else {
             if (isPrivateIp(address)) {
                  return callback(new Error(`SSRF Prevention: Hostname '${hostname}' resolved to private IP '${address}', which is blocked.`));
             }
        }

        callback(null, address, family);
    });
}

const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

const safeAxios = axios.create({
    httpAgent,
    httpsAgent
});

module.exports = safeAxios;
