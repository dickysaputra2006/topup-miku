#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Parse CLI arguments for baseline comparison and synthetic test files.
 */
function parseArgs(argv) {
    let baselinePath = path.resolve(__dirname, '..', 'docs', 'routes.baseline.txt');
    let currentPath = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--baseline' && i + 1 < argv.length) {
            baselinePath = path.resolve(argv[++i]);
        } else if (arg.startsWith('--baseline=')) {
            baselinePath = path.resolve(arg.slice('--baseline='.length));
        } else if (arg === '--current' && i + 1 < argv.length) {
            currentPath = path.resolve(argv[++i]);
        } else if (arg.startsWith('--current=')) {
            currentPath = path.resolve(arg.slice('--current='.length));
        }
    }

    return { baselinePath, currentPath };
}

/**
 * Parse formatted dump-routes lines: "METHOD /path [mw1, mw2]".
 */
function parseRouteLines(text, sourceLabel) {
    const cleanText = String(text || '').replace(/^\uFEFF/, '');
    const rawLines = cleanText.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    return rawLines.map((raw, index) => {
        const match = raw.match(/^([A-Z]+)\s+(\S+)\s+\[(.*)\]$/);
        if (!match) {
            throw new Error(`Invalid route line in ${sourceLabel} at #${index + 1}: ${raw}`);
        }
        const [, method, routePath, mwText] = match;
        const middlewares = mwText
            ? mwText.split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        return {
            index,
            method,
            path: routePath,
            key: `${method} ${routePath}`,
            middlewares,
            raw,
        };
    });
}

function splitSegments(routePath) {
    return routePath.split('/').filter(Boolean);
}

function isParamSegment(seg) {
    return seg.startsWith(':') || seg === '*';
}

/**
 * Check if two Express route patterns can match the exact same request URL.
 * Rule: equal segment count; :param matches any segment; literals must match.
 */
function pathsCanMatchSameUrl(pathA, pathB) {
    const segsA = splitSegments(pathA);
    const segsB = splitSegments(pathB);
    if (segsA.length !== segsB.length) return false;

    for (let i = 0; i < segsA.length; i++) {
        const sa = segsA[i];
        const sb = segsB[i];
        if (!isParamSegment(sa) && !isParamSegment(sb) && sa !== sb) {
            return false;
        }
    }
    return true;
}

function runDumpRoutes() {
    const dumpScript = path.resolve(__dirname, 'dump-routes.js');
    const env = {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'test',
        JWT_SECRET: process.env.JWT_SECRET || 'dummy-secret-minimal-32-karakter-untuk-dump',
        FOXY_CALLBACK_SECRET: process.env.FOXY_CALLBACK_SECRET || 'dummy',
        DB_USER: process.env.DB_USER || 'dummy',
        DB_HOST: process.env.DB_HOST || '127.0.0.1',
        DB_NAME: process.env.DB_NAME || 'dummy',
        DB_PASSWORD: process.env.DB_PASSWORD || 'dummy',
        DB_PORT: process.env.DB_PORT || '5432',
        FOXY_API_KEY: process.env.FOXY_API_KEY || 'dummy',
        FOXY_CALLBACK_URL: process.env.FOXY_CALLBACK_URL || 'http://localhost:3000/api/foxy/callback',
    };
    return execFileSync(process.execPath, [dumpScript], {
        encoding: 'utf8',
        env,
        timeout: 60000,
    });
}

function checkRouteOverlap(baselineText, currentText) {
    const baseline = parseRouteLines(baselineText, 'baseline');
    const current = parseRouteLines(currentText, 'current');

    const baseByKey = new Map();
    const curByKey = new Map();
    const errors = [];

    for (const entry of baseline) {
        if (baseByKey.has(entry.key)) {
            errors.push(`Duplicate route in baseline: ${entry.key}`);
        } else {
            baseByKey.set(entry.key, entry);
        }
    }
    for (const entry of current) {
        if (curByKey.has(entry.key)) {
            errors.push(`Duplicate route in current app: ${entry.key}`);
        } else {
            curByKey.set(entry.key, entry);
        }
    }

    for (const [key] of baseByKey) {
        if (!curByKey.has(key)) errors.push(`Missing route from baseline: ${key}`);
    }
    for (const [key] of curByKey) {
        if (!baseByKey.has(key)) errors.push(`Unexpected extra route not in baseline: ${key}`);
    }

    if (errors.length > 0) {
        return { ok: false, errors, overlapViolations: [], reorderedSameMethod: 0, count: current.length };
    }

    for (const [key, baseEntry] of baseByKey) {
        const curEntry = curByKey.get(key);
        const baseMw = baseEntry.middlewares.join(', ');
        const curMw = curEntry.middlewares.join(', ');
        if (baseMw !== curMw) {
            errors.push(`Middleware mismatch on ${key}: baseline=[${baseMw}] vs current=[${curMw}]`);
        }
    }

    let reorderedSameMethod = 0;
    const overlapViolations = [];

    for (let i = 0; i < baseline.length; i++) {
        const a = baseline[i];
        const curA = curByKey.get(a.key);
        for (let j = i + 1; j < baseline.length; j++) {
            const b = baseline[j];
            if (a.method !== b.method) continue;
            const curB = curByKey.get(b.key);
            if (curA.index > curB.index) {
                reorderedSameMethod++;
                if (pathsCanMatchSameUrl(a.path, b.path)) {
                    overlapViolations.push({
                        method: a.method,
                        earlierInBaseline: `${a.key} (base#${a.index + 1} -> cur#${curA.index + 1})`,
                        laterInBaseline: `${b.key} (base#${b.index + 1} -> cur#${curB.index + 1})`,
                    });
                }
            }
        }
    }

    if (overlapViolations.length > 0) {
        for (const v of overlapViolations) {
            errors.push(`Route order overlap (${v.method}): [${v.earlierInBaseline}] vs [${v.laterInBaseline}]`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        overlapViolations,
        reorderedSameMethod,
        count: current.length,
    };
}

function main() {
    const { baselinePath, currentPath } = parseArgs(process.argv.slice(2));
    const baselineText = fs.readFileSync(baselinePath, 'utf8');
    const currentText = currentPath ? fs.readFileSync(currentPath, 'utf8') : runDumpRoutes();
    const result = checkRouteOverlap(baselineText, currentText);

    if (!result.ok) {
        for (const err of result.errors) {
            console.error(`ERROR: ${err}`);
        }
        process.exit(1);
    }

    console.log(
        `OK: route set=${result.count}/${result.count}, middlewares=${result.count}/${result.count}, ` +
        `reordered_same_method=${result.reorderedSameMethod}, overlap_conflicts=0`
    );
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(err.message || err);
        process.exit(1);
    }
}

module.exports = {
    parseRouteLines,
    pathsCanMatchSameUrl,
    checkRouteOverlap,
};
