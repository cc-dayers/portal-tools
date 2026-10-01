import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const dist = path.join(root, 'dist');
const webview = path.join(dist, 'webview');

await rm(dist, { recursive: true, force: true });
await mkdir(webview, { recursive: true });

// One CommonJS file for the extension host; `vscode` is provided at runtime.
await esbuild.build({
    entryPoints: [path.join(root, 'src', 'extension.mjs')],
    outfile: path.join(dist, 'extension.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'warning',
});

// The webview loads plain files from dist/webview, which is its only localResourceRoot.
// Resolve through Node so this works whether workspaces hoist @vscode/codicons or not.
const codicons = path.dirname(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css'));
await Promise.all([
    cp(path.join(root, 'resources', 'webview', 'dashboard.js'), path.join(webview, 'dashboard.js')),
    cp(path.join(root, 'resources', 'webview', 'dashboard.css'), path.join(webview, 'dashboard.css')),
    cp(path.join(codicons, 'codicon.css'), path.join(webview, 'codicon.css')),
    cp(path.join(codicons, 'codicon.ttf'), path.join(webview, 'codicon.ttf')),
]);

console.log(`Built ${production ? 'production' : 'development'} bundle in ${path.relative(root, dist)}`);
