#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const REFACTORED_JS_DIR = path.join(FRONTEND_DIR, 'js');
const REFACTORED_CSS_DIR = path.join(FRONTEND_DIR, 'css');
const HARD_LINE_LIMIT = 600;
const CSS_HARD_LINE_LIMIT = 800;

/**
 * Hitung jumlah baris aktual suatu file (seperti wc -l).
 */
function countLines(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.length) return 0;
    const parts = text.split(/\r?\n/);
    return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * Kumpulkan semua file berakhiran ekstensi tertentu secara rekursif.
 */
function walkFiles(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkFiles(fullPath, ext));
        } else if (entry.name.endsWith(ext)) {
            results.push(fullPath);
        }
    }
    return results.sort();
}

/**
 * Cek apakah URL eksternal (http/https/protocol-relative/data).
 */
function isExternalRef(ref) {
    return /^(?:https?:)?\/\//i.test(ref) || /^data:/i.test(ref);
}

/**
 * Ubah path aset lokal (relatif terhadap root HTML atau '/' webroot) menjadi path disk di frontend/.
 */
function resolveLocalAssetPath(rawRef) {
    const cleanRef = String(rawRef || '').split(/[?#]/)[0].trim();
    const withoutLeadingSlash = cleanRef.replace(/^\/+/, '');
    return path.resolve(FRONTEND_DIR, withoutLeadingSlash);
}

/**
 * Normalisasi identifier aset lokal untuk deteksi duplikasi dalam satu HTML.
 */
function normalizeAssetKey(rawRef) {
    const cleanRef = String(rawRef || '').split(/[?#]/)[0].trim().replace(/^\.\//, '');
    return cleanRef.replace(/^\/+/, '');
}

/**
 * Parse atribut pada tag HTML tunggal (mis. <script ...> atau <link ...>).
 */
function parseAttributes(attrText) {
    const attrs = {};
    const re = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let match;
    while ((match = re.exec(attrText))) {
        const name = match[1].toLowerCase();
        const value = match[2] !== undefined ? match[2]
            : match[3] !== undefined ? match[3]
                : match[4] !== undefined ? match[4]
                    : true;
        attrs[name] = value;
    }
    return attrs;
}

/**
 * Hapus komentar HTML agar tag di dalam komentar tidak ikut diperiksa.
 */
function stripHtmlComments(html) {
    return html.replace(/<!--[\s\S]*?-->/g, '');
}

function checkHtmlFiles() {
    const htmlFiles = fs.readdirSync(FRONTEND_DIR)
        .filter((name) => name.endsWith('.html'))
        .sort()
        .map((name) => path.join(FRONTEND_DIR, name));

    const errors = [];
    let scriptRefCount = 0;
    let cssRefCount = 0;

    for (const htmlPath of htmlFiles) {
        const htmlName = path.basename(htmlPath);
        const content = stripHtmlComments(fs.readFileSync(htmlPath, 'utf8'));
        const seenScripts = new Set();
        const seenStyles = new Set();
        let hasDeferredLocalScript = false;

        // 1. Cek seluruh tag <script ...>
        const scriptRe = /<script\b([^>]*)>/gi;
        let match;
        while ((match = scriptRe.exec(content))) {
            const attrs = parseAttributes(match[1]);
            if (typeof attrs.src !== 'string' || !attrs.src.trim()) continue;
            const rawSrc = attrs.src.trim();
            if (isExternalRef(rawSrc)) continue;

            scriptRefCount += 1;
            const normKey = normalizeAssetKey(rawSrc);
            if (seenScripts.has(normKey)) {
                errors.push(`${htmlName}: duplikat <script src="${rawSrc}">`);
            } else {
                seenScripts.add(normKey);
            }

            if (attrs.defer === true || typeof attrs.defer === 'string') {
                hasDeferredLocalScript = true;
            } else if (hasDeferredLocalScript) {
                errors.push(`${htmlName}: <script src="${rawSrc}"> tanpa 'defer' setelah script ber-'defer' (berisiko urutan eksekusi terbalik)`);
            }

            const resolved = resolveLocalAssetPath(rawSrc);
            if (!fs.existsSync(resolved)) {
                errors.push(`${htmlName}: broken script path "${rawSrc}" -> ${path.relative(FRONTEND_DIR, resolved)}`);
            }
        }

        // 2. Cek seluruh tag <link rel="stylesheet" ...>
        const linkRe = /<link\b([^>]*)>/gi;
        while ((match = linkRe.exec(content))) {
            const attrs = parseAttributes(match[1]);
            const rel = typeof attrs.rel === 'string' ? attrs.rel.toLowerCase().split(/\s+/) : [];
            if (!rel.includes('stylesheet')) continue;
            if (typeof attrs.href !== 'string' || !attrs.href.trim()) continue;

            const rawHref = attrs.href.trim();
            if (isExternalRef(rawHref)) continue;

            cssRefCount += 1;
            const normKey = normalizeAssetKey(rawHref);
            if (seenStyles.has(normKey)) {
                errors.push(`${htmlName}: duplikat <link rel="stylesheet" href="${rawHref}">`);
            } else {
                seenStyles.add(normKey);
            }

            const resolved = resolveLocalAssetPath(rawHref);
            if (!fs.existsSync(resolved)) {
                errors.push(`${htmlName}: broken stylesheet path "${rawHref}" -> ${path.relative(FRONTEND_DIR, resolved)}`);
            }
        }
    }

    return { htmlCount: htmlFiles.length, scriptRefCount, cssRefCount, errors };
}

function checkJsSyntax() {
    const jsFiles = walkFiles(FRONTEND_DIR, '.js');
    for (const jsPath of jsFiles) {
        execFileSync(process.execPath, ['--check', jsPath], { stdio: 'inherit' });
    }
    return jsFiles;
}

function checkCssBraces() {
    const cssFiles = walkFiles(FRONTEND_DIR, '.css');
    const errors = [];
    for (const cssPath of cssFiles) {
        const text = fs.readFileSync(cssPath, 'utf8');
        let depth = 0;
        let inComment = false;
        let quote = null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = text[i + 1];
            if (inComment) {
                if (ch === '*' && next === '/') {
                    inComment = false;
                    i += 1;
                }
                continue;
            }
            if (quote) {
                if (ch === '\\') {
                    i += 1;
                    continue;
                }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '/' && next === '*') {
                inComment = true;
                i += 1;
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth < 0) {
                    const rel = path.relative(FRONTEND_DIR, cssPath).replace(/\\/g, '/');
                    errors.push(`frontend/${rel}: kurung kurawal '}' berlebih.`);
                    break;
                }
            }
        }
        if (depth > 0) {
            const rel = path.relative(FRONTEND_DIR, cssPath).replace(/\\/g, '/');
            errors.push(`frontend/${rel}: kurung kurawal '{' tidak tertutup (${depth}).`);
        }
    }
    return { cssFiles, errors };
}

function checkRefactoredJsLineLimits() {
    const allJsFiles = walkFiles(FRONTEND_DIR, '.js');
    const refactoredFiles = walkFiles(REFACTORED_JS_DIR, '.js');
    const warnings = [];
    for (const filePath of allJsFiles) {
        const lines = countLines(filePath);
        if (lines > HARD_LINE_LIMIT) {
            const rel = path.relative(FRONTEND_DIR, filePath).replace(/\\/g, '/');
            warnings.push(`[WARN] frontend/${rel}: ${lines} baris (> batas keras ${HARD_LINE_LIMIT} baris JS)`);
        }
    }
    return { count: refactoredFiles.length, totalCount: allJsFiles.length, warnings };
}

function checkCssLineLimits() {
    const cssFiles = walkFiles(REFACTORED_CSS_DIR, '.css');
    const warnings = [];
    for (const filePath of cssFiles) {
        const lines = countLines(filePath);
        if (lines > CSS_HARD_LINE_LIMIT) {
            const rel = path.relative(FRONTEND_DIR, filePath).replace(/\\/g, '/');
            warnings.push(`[WARN] frontend/${rel}: ${lines} baris (> batas keras ${CSS_HARD_LINE_LIMIT} baris CSS)`);
        }
    }
    return { count: cssFiles.length, warnings };
}

function main() {
    if (!fs.existsSync(FRONTEND_DIR)) {
        throw new Error(`Direktori frontend tidak ditemukan: ${FRONTEND_DIR}`);
    }

    const htmlAudit = checkHtmlFiles();
    const cssBraceAudit = checkCssBraces();
    const allErrors = [...htmlAudit.errors, ...cssBraceAudit.errors];
    if (allErrors.length > 0) {
        for (const err of allErrors) {
            console.error(`ERROR: ${err}`);
        }
        process.exit(1);
    }

    const jsFiles = checkJsSyntax();
    const jsLimitAudit = checkRefactoredJsLineLimits();
    const cssLimitAudit = checkCssLineLimits();
    const allWarnings = [...jsLimitAudit.warnings, ...cssLimitAudit.warnings];
    for (const warn of allWarnings) {
        console.warn(warn);
    }

    console.log(
        `OK: html=${htmlAudit.htmlCount}, script_refs=${htmlAudit.scriptRefCount}, ` +
        `css_refs=${htmlAudit.cssRefCount}, js_checked=${jsFiles.length}, ` +
        `refactored_js=${jsLimitAudit.count}, css_checked=${cssBraceAudit.cssFiles.length}, ` +
        `refactored_css=${cssLimitAudit.count}, limit_warnings=${allWarnings.length}`
    );

    if (allWarnings.length > 0) {
        process.exit(1);
    }
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
    countLines,
    walkFiles,
    checkHtmlFiles,
    checkJsSyntax,
    checkCssBraces,
    checkRefactoredJsLineLimits,
    checkCssLineLimits,
};
