import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { expect, test } from 'vitest';
import { reconnectToLauncherHost } from '@cc-dayers/portal-protocol';

const host = fileURLToPath(new URL('../../protocol/src/mock-launcher-host.mjs', import.meta.url));
const cli = new URL('../src/cli.mjs', import.meta.url).href;

async function driveCli(home, key, hostArgs = []) {
    const script = `
        import os from 'node:os';
        import { run } from ${JSON.stringify(cli)};
        if (os.homedir() !== process.env.TEST_HOME) throw new Error('Test profile was not isolated.');
        process.stdin.isTTY = true;
        process.stdin.setRawMode = () => process.stdin;
        process.stdout.isTTY = true;
        process.stdout.columns = 100;
        process.stdout.rows = 28;
        process.exitCode = await run(['--host', ${JSON.stringify(host)}, ...${JSON.stringify(hostArgs)}]);
        process.stdin.destroy();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
        env: { ...process.env, HOME: home, USERPROFILE: home, TEST_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let sent = false;
    child.stdout.on('data', chunk => {
        output += chunk;
        if (!sent && output.includes('2 ready')) {
            sent = true;
            if (key === 'crash') child.kill('SIGKILL');
            else child.stdin.write(key);
        }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
        });
        expect(stripVTControlCharacters(errors)).toBe('');
        if (key === 'crash') expect(code).not.toBe(0);
        else expect(code).toBe(0);
        expect(sent).toBe(true);
        return output;
    } finally {
        clearTimeout(timer);
    }
}

test('CLI survives detach and abrupt client exit, reconnects, and q shuts the session down', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-portals-tui-home-'));
    const directory = path.join(home, '.cc-portals', 'tui-sessions');
    try {
        const detached = await driveCli(home, 'd');
        expect(detached).toContain('Detached. Portals are still running');
        const [name] = await fs.readdir(directory);
        const referencePath = path.join(directory, name);
        const reference = JSON.parse(await fs.readFile(referencePath, 'utf8'));
        await driveCli(home, 'crash');
        expect(JSON.parse(await fs.readFile(referencePath, 'utf8'))).toEqual(reference);
        await new Promise(resolve => setTimeout(resolve, 50));
        const stopped = await driveCli(home, 'q');
        expect(stopped).not.toContain('Detached. Portals are still running');
        expect(await fs.readdir(directory)).toEqual([]);
        await expect(reconnectToLauncherHost(reference)).rejects.toThrow();
    } finally {
        const remaining = await fs.readdir(directory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const name of remaining) {
            const reference = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
            const client = await reconnectToLauncherHost(reference);
            await client.shutdown('quit', 'test cleanup');
        }
        await fs.rm(home, { recursive: true, force: true });
    }
}, 35_000);

test('CLI runs prerequisite setup before the first launch only, not when reconnecting', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-portals-tui-home-'));
    const directory = path.join(home, '.cc-portals', 'tui-sessions');
    try {
        const detached = await driveCli(home, 'd', ['--', '--setup-required']);
        expect(detached).toContain('Mock launcher setup');
        expect(detached).toContain('Mock prerequisites are ready.');
        expect(detached).toContain('Detached. Portals are still running');
        const stopped = await driveCli(home, 'q', ['--', '--setup-required']);
        expect(stopped).toContain('Reconnected to the existing session');
        expect(stopped).not.toContain('Mock launcher setup');
        expect(await fs.readdir(directory)).toEqual([]);
    } finally {
        const remaining = await fs.readdir(directory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        for (const name of remaining) {
            const reference = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
            const client = await reconnectToLauncherHost(reference);
            await client.shutdown('quit', 'test cleanup');
        }
        await fs.rm(home, { recursive: true, force: true });
    }
}, 35_000);
