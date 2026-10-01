import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });

// Bundle the TUI with the workspace protocol package; runtime dependencies stay installable from npm.
await esbuild.build({
    entryPoints: [path.join(root, 'src', 'bin.mjs')],
    outfile: path.join(dist, 'bin.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]),
    logLevel: 'warning',
});

console.log(`Built ${pkg.name} ${pkg.version} in ${path.relative(root, dist)}`);
