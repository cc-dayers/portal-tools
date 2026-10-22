import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { connectToStoredLauncherSession, forgetStoredLauncherSession, launcherSessionPath } from '../src/session-store.mjs';

const hostPath = fileURLToPath(new URL('../src/mock-launcher-host.mjs', import.meta.url));
const directories = [];
afterEach(async () => {
    for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function temporaryDirectory() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-portals-session-test-'));
    directories.push(directory);
    return directory;
}

test('stored session reconnects to the same host without launching and clears on confirmed shutdown', async () => {
    const directory = await temporaryDirectory();
    let connection = await connectToStoredLauncherSession({ hostPath, directory });
    let detached = false;
    try {
        const pid = connection.client.hello.authority.pid;
        const referencePath = launcherSessionPath(hostPath, directory);
        const reference = JSON.parse(await fs.readFile(referencePath, 'utf8'));
        expect(reference.sessionId).toBe(connection.client.hello.sessionId);
        expect(reference.token).toHaveLength(64);
        if (process.platform !== 'win32') expect((await fs.stat(referencePath)).mode & 0o077).toBe(0);
        await expect(connectToStoredLauncherSession({ hostPath, directory })).rejects.toThrow('No replacement was launched');
        expect(JSON.parse(await fs.readFile(referencePath, 'utf8'))).toEqual(reference);
        await connection.client.request('command.launch', { source: 'saved' });
        connection.client.close();
        detached = true;
        await new Promise(resolve => setTimeout(resolve, 30));
        connection = await connectToStoredLauncherSession({ hostPath, directory });
        detached = false;
        expect(connection.client.hello.authority.pid).toBe(pid);
        expect(connection.client.session.running).toBe(true);
        await expect(connection.client.request('command.launch', { source: 'saved' })).rejects.toThrow('already been launched');
        await connection.client.shutdown('quit', 'test complete');
        await connection.clear();
        await expect(fs.stat(referencePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        if (detached) connection = await connectToStoredLauncherSession({ hostPath, directory });
        if (!connection.client.sessionEnded) await connection.client.shutdown('quit', 'test cleanup');
    }
});

test('stale and incomplete references block launch until explicitly forgotten', async () => {
    const directory = await temporaryDirectory();
    const referencePath = launcherSessionPath(hostPath, directory);
    await fs.writeFile(referencePath, JSON.stringify({ endpoint: 'missing', token: 'key', sessionId: null }), { mode: 0o600 });
    await expect(connectToStoredLauncherSession({ hostPath, directory })).rejects.toThrow('--forget-session');
    expect(JSON.parse(await fs.readFile(referencePath, 'utf8')).endpoint).toBe('missing');
    await forgetStoredLauncherSession({ hostPath, directory });
    await expect(fs.stat(referencePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('session paths isolate application workspaces', () => {
    expect(launcherSessionPath(path.resolve('app-one', 'host.mjs'))).not.toBe(
        launcherSessionPath(path.resolve('app-two', 'host.mjs')),
    );
});

test('legacy hosts do not leave a stored reference or offer persistent detach', async () => {
    const directory = await temporaryDirectory();
    const legacyHost = path.join(directory, 'legacy-host.mjs');
    await fs.writeFile(legacyHost,
        `import { createMockLauncherHost } from ${JSON.stringify(new URL('../src/mock-launcher-host.mjs', import.meta.url).href)};
        process.exitCode = await createMockLauncherHost().done;`);
    const connection = await connectToStoredLauncherSession({ hostPath: legacyHost, directory });
    try {
        expect(connection.persistent).toBe(false);
        await expect(fs.stat(launcherSessionPath(legacyHost, directory))).rejects.toMatchObject({ code: 'ENOENT' });
        await connection.client.shutdown('quit', 'legacy test complete');
    } finally {
        connection.client.close();
    }
});

test('malformed references fail explicitly instead of launching replacements', async () => {
    const directory = await temporaryDirectory();
    const referencePath = launcherSessionPath(hostPath, directory);
    await fs.writeFile(referencePath, '{', { mode: 0o600 });
    await expect(connectToStoredLauncherSession({ hostPath, directory })).rejects.toThrow('--forget-session');
    expect(await fs.readFile(referencePath, 'utf8')).toBe('{');
});

test('simultaneous clients reserve only one host session', async () => {
    const directory = await temporaryDirectory();
    const results = await Promise.allSettled([
        connectToStoredLauncherSession({ hostPath, directory }),
        connectToStoredLauncherSession({ hostPath, directory }),
    ]);
    const connections = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    try {
        expect(connections).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    } finally {
        for (const connection of connections) {
            await connection.client.shutdown('quit', 'reservation test complete');
            await connection.clear();
        }
    }
});
