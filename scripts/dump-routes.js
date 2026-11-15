#!/usr/bin/env node
'use strict';

const path = require('path');

if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'dump-routes-inspection-placeholder';
}

const serverPath = path.resolve(__dirname, '..', 'backend', 'server.js');
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

async function main() {
    const rootStack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];
    const lines = collectRoutes(rootStack);
    process.stdout.write(`${lines.join('\n')}\n`);
    if (pool && typeof pool.end === 'function') {
        await pool.end().catch(() => {});
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
