#!/usr/bin/env node
'use strict';

const path = require('path');

/**
 * Parse CLI arguments for route/layer inspection.
 */
function parseArgs(argv) {
    let layers = false;
    let target = null;
    let root = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--layers') {
            layers = true;
        } else if (arg === '--target' && i + 1 < argv.length) {
            target = argv[++i];
        } else if (arg.startsWith('--target=')) {
            target = arg.slice('--target='.length);
        } else if (arg === '--root' && i + 1 < argv.length) {
            root = argv[++i];
        } else if (arg.startsWith('--root=')) {
            root = arg.slice('--root='.length);
        }
    }

    return { layers, target, root };
}

const args = parseArgs(process.argv.slice(2));

if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'dump-routes-inspection-placeholder';
}

const serverPath = args.target
    ? path.resolve(args.target)
    : args.root
        ? path.resolve(args.root, 'backend', 'server.js')
        : path.resolve(__dirname, '..', 'backend', 'server.js');
const { app, pool } = require(serverPath);

function extractMountPath(layer) {
    if (layer.path) return layer.path;
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    const src = layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/');
    return src.startsWith('/') ? src : '';
}

function joinPaths(prefix, routePath) {
    const cleanPrefix = prefix && prefix !== '/' ? prefix.replace(/\/+$/, '') : '';
    const cleanRoute = routePath || '/';
    if (!cleanPrefix) return cleanRoute;
    if (cleanRoute === '/') return cleanPrefix || '/';
    return `${cleanPrefix}${cleanRoute.startsWith('/') ? cleanRoute : `/${cleanRoute}`}`;
}

function formatHandlerName(layer) {
    return layer.name || (layer.handle && layer.handle.name) || '<anonymous>';
}

function collectRoutes(stack, prefix = '', inheritedMiddlewares = [], output = []) {
    const activeMiddlewares = [...inheritedMiddlewares];

    for (const layer of stack) {
        if (layer.route) {
            const fullPath = joinPaths(prefix, layer.route.path);
            const methods = Object.keys(layer.route.methods)
                .filter((m) => layer.route.methods[m])
                .map((m) => m.toUpperCase());
            const routeHandlers = layer.route.stack.map(formatHandlerName);
            const allHandlers = [...activeMiddlewares, ...routeHandlers];

            for (const method of methods) {
                output.push(`${method.padEnd(6)} ${fullPath} [${allHandlers.join(', ')}]`);
            }
        } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
            const mountPrefix = joinPaths(prefix, extractMountPath(layer));
            collectRoutes(layer.handle.stack, mountPrefix, activeMiddlewares, output);
        } else if (prefix) {
            activeMiddlewares.push(formatHandlerName(layer));
        }
    }

    return output;
}

/**
 * Collect all Express middleware and route layers in exact execution order.
 */
function collectLayers(stack, prefix = '', output = []) {
    for (const layer of stack) {
        if (layer.route) {
            const fullPath = joinPaths(prefix, layer.route.path);
            const methods = Object.keys(layer.route.methods)
                .filter((m) => layer.route.methods[m])
                .map((m) => m.toUpperCase());
            const routeHandlers = layer.route.stack.map(formatHandlerName);

            for (const method of methods) {
                output.push(`${method.padEnd(6)} ${fullPath} [${routeHandlers.join(', ')}]`);
            }
        } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
            const mountPrefix = joinPaths(prefix, extractMountPath(layer));
            collectLayers(layer.handle.stack, mountPrefix, output);
        } else {
            const mountPath = joinPaths(prefix, extractMountPath(layer)) || '/';
            const kind = (layer.handle && layer.handle.length === 4) ? 'ERR' : 'USE';
            output.push(`${kind.padEnd(6)} ${mountPath} [${formatHandlerName(layer)}]`);
        }
    }

    return output;
}

async function main() {
    const timer = setTimeout(() => {
        console.error('dump-routes timed out after 60 seconds');
        process.exit(124);
    }, 60000);
    timer.unref();

    try {
        const rootStack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];
        const lines = args.layers ? collectLayers(rootStack) : collectRoutes(rootStack);
        process.stdout.write(`${lines.join('\n')}\n`);
        if (pool && typeof pool.end === 'function') {
            await pool.end().catch(() => {});
        }
    } finally {
        clearTimeout(timer);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
