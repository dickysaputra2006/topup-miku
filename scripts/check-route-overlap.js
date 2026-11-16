#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Parse CLI arguments for route overlap and effective-chain checks.
 */
function parseArgs(argv) {
    let baselinePath = path.resolve(__dirname, '..', 'docs', 'routes.baseline.txt');
    let currentPath = null;
    let effectiveBaselinePath = path.resolve(__dirname, '..', 'docs', 'effective-chain.baseline.txt');
    let effectiveCurrentPath = null;
    let skipEffective = false;

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
        } else if (arg === '--effective-baseline' && i + 1 < argv.length) {
            effectiveBaselinePath = path.resolve(argv[++i]);
        } else if (arg.startsWith('--effective-baseline=')) {
            effectiveBaselinePath = path.resolve(arg.slice('--effective-baseline='.length));
        } else if (arg === '--effective-current' && i + 1 < argv.length) {
            effectiveCurrentPath = path.resolve(argv[++i]);
        } else if (arg.startsWith('--effective-current=')) {
            effectiveCurrentPath = path.resolve(arg.slice('--effective-current='.length));
        } else if (arg === '--skip-effective') {
            skipEffective = true;
        }
    }

    return {
        baselinePath,
        currentPath,
        effectiveBaselinePath,
        effectiveCurrentPath,
        skipEffective,
    };
}

/**
 * Parse formatted dump-routes lines: "METHOD /path [item1, item2]".
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

function runDumpRoutes(extraArgs = []) {
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
    return execFileSync(process.execPath, [dumpScript, ...extraArgs], {
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
        if (baseByKey.has(entry.key)) errors.push(`Duplicate route in baseline: ${entry.key}`);
        else baseByKey.set(entry.key, entry);
    }
    for (const entry of current) {
        if (curByKey.has(entry.key)) errors.push(`Duplicate route in current app: ${entry.key}`);
        else curByKey.set(entry.key, entry);
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

    for (const v of overlapViolations) {
        errors.push(`Route order overlap (${v.method}): [${v.earlierInBaseline}] vs [${v.laterInBaseline}]`);
    }

    return {
        ok: errors.length === 0,
        errors,
        overlapViolations,
        reorderedSameMethod,
        count: current.length,
    };
}

function splitChainToken(token) {
    const idx = token.lastIndexOf(':');
    if (idx === -1) return { prefix: '', name: token };
    return { prefix: token.slice(0, idx), name: token.slice(idx + 1) };
}

/**
 * Compare effective middleware chain per route against baseline.
 * Pure "<anonymous> -> <fnName>" at identical scope/mount is reported as a known rename.
 */
function checkEffectiveChains(baselineText, currentText) {
    const baseline = parseRouteLines(baselineText, 'effective-baseline');
    const current = parseRouteLines(currentText, 'effective-current');

    const baseByKey = new Map();
    const curByKey = new Map();
    const errors = [];
    const knownRenames = new Map();

    for (const e of baseline) baseByKey.set(e.key, e);
    for (const e of current) curByKey.set(e.key, e);

    for (const [key] of baseByKey) {
        if (!curByKey.has(key)) errors.push(`Effective-chain missing route: ${key}`);
    }
    for (const [key] of curByKey) {
        if (!baseByKey.has(key)) errors.push(`Effective-chain extra route: ${key}`);
    }
    if (errors.length > 0) return { ok: false, errors, knownRenames, count: current.length };

    for (const [key, baseEntry] of baseByKey) {
        const curEntry = curByKey.get(key);
        const bc = baseEntry.middlewares;
        const cc = curEntry.middlewares;

        if (bc.length !== cc.length) {
            errors.push(`Effective-chain length mismatch on ${key}: baseline(${bc.length})=[${bc.join(', ')}] vs current(${cc.length})=[${cc.join(', ')}]`);
            continue;
        }

        for (let k = 0; k < bc.length; k++) {
            if (bc[k] === cc[k]) continue;
            const bTok = splitChainToken(bc[k]);
            const cTok = splitChainToken(cc[k]);
            if (bTok.prefix === cTok.prefix && bTok.name === '<anonymous>' && cTok.name !== '<anonymous>') {
                const desc = `${bTok.prefix}: <anonymous> -> ${cTok.name}`;
                knownRenames.set(desc, (knownRenames.get(desc) || 0) + 1);
            } else {
                errors.push(`Effective-chain diff on ${key} at #${k + 1}: baseline=${bc[k]} vs current=${cc[k]}`);
            }
        }
    }

    return { ok: errors.length === 0, errors, knownRenames, count: current.length };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const baselineText = fs.readFileSync(opts.baselinePath, 'utf8');
    const currentText = opts.currentPath ? fs.readFileSync(opts.currentPath, 'utf8') : runDumpRoutes();
    const result = checkRouteOverlap(baselineText, currentText);

    if (!result.ok) {
        for (const err of result.errors) console.error(`ERROR: ${err}`);
        process.exit(1);
    }

    if (opts.skipEffective || opts.currentPath) {
        if (!opts.effectiveCurrentPath) {
            console.log(
                `OK: route set=${result.count}/${result.count}, middlewares=${result.count}/${result.count}, ` +
                `reordered_same_method=${result.reorderedSameMethod}, overlap_conflicts=0`
            );
            return;
        }
    }

    const effBaseText = fs.readFileSync(opts.effectiveBaselinePath, 'utf8');
    const effCurText = opts.effectiveCurrentPath
        ? fs.readFileSync(opts.effectiveCurrentPath, 'utf8')
        : runDumpRoutes(['--effective-chains']);
    const effResult = checkEffectiveChains(effBaseText, effCurText);

    if (!effResult.ok) {
        for (const err of effResult.errors) console.error(`ERROR: ${err}`);
        process.exit(1);
    }

    const renameNotes = [...effResult.knownRenames.entries()]
        .map(([desc, n]) => `${desc} (${n} routes)`)
        .join('; ');
    console.log(
        `OK: route set=${result.count}/${result.count}, middlewares=${result.count}/${result.count}, ` +
        `reordered_same_method=${result.reorderedSameMethod}, overlap_conflicts=0, ` +
        `effective_chains=${effResult.count}/${effResult.count}` +
        (renameNotes ? `, known_anonymous_renames=[${renameNotes}]` : '')
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
    checkEffectiveChains,
};
