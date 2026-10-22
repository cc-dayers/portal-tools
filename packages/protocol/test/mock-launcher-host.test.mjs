import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

import { connectToLauncherHost, createProtocolClient, ensureLauncherSetup, reconnectToLauncherHost } from '../src/protocol-client.mjs';

const HOST_SCRIPT = fileURLToPath(new URL('../src/mock-launcher-host.mjs', import.meta.url));

function spawnMockHost(args = [], env = {}) {
    return spawn(process.execPath, [HOST_SCRIPT, ...args], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

test('mock host speaks a real cc.portals.launcher v1 handshake', async () => {
    const child = spawnMockHost(['--config']);
    const client = createProtocolClient({
        input: child.stdout,
        output: child.stdin,
        errorInput: child.stderr,
    });

    const session = await client.connect();
    expect(session).toMatchObject({
        mode: 'configure',
        configurationRequired: true,
    });
    expect(session.choices.portals.length).toBeGreaterThan(0);

    await client.shutdown('quit', 'test complete');
    await client.exitPromise;
    child.kill();
});

test('mock host simulates missing prerequisites and a successful setup recheck', async () => {
    const child = spawnMockHost(['--setup-required']);
    const client = createProtocolClient({ input: child.stdout, output: child.stdin, errorInput: child.stderr });
    try {
        await client.connect();
        let prompted = false;
        expect(await ensureLauncherSetup(client, { source: 'saved' }, async (setup) => {
            prompted = true;
            expect(setup.missing[0].name).toBe('Podman');
            expect(setup.terminal.command).toBe(process.execPath);
            expect(client.lastSnapshot).toBe(null);
            return true;
        })).toBe(true);
        expect(prompted).toBe(true);
        await client.shutdown('quit', 'setup test complete');
    } finally {
        client.close();
        child.kill();
    }
});

test('mock host runs the happy-path launch scenario to ready', async () => {
    const child = spawnMockHost([], { MOCK_SCENARIO: 'happy' });
    const client = createProtocolClient({
        input: child.stdout,
        output: child.stdin,
        errorInput: child.stderr,
    });
    await client.connect();

    const states = [];
    client.onState((snapshot) => states.push(snapshot));

    await client.request('command.launch', { source: 'saved' });

    await waitFor(
        () => states.some((snapshot) => snapshot.targets.every((target) => target.status === 'ready')),
        5000,
    );

    await client.shutdown('quit', 'test complete');
    await client.exitPromise;
    child.kill();
});

test('mock host reports a target failure in the one-fails scenario', async () => {
    const child = spawnMockHost([], { MOCK_SCENARIO: 'one-fails' });
    const client = createProtocolClient({
        input: child.stdout,
        output: child.stdin,
        errorInput: child.stderr,
    });
    await client.connect();

    const states = [];
    client.onState((snapshot) => states.push(snapshot));

    await client.request('command.launch', { source: 'saved' });

    await waitFor(
        () => states.some((snapshot) => snapshot.targets.some((target) => target.status === 'failed')),
        5000,
    );

    await client.shutdown('quit', 'test complete');
    await client.exitPromise;
    child.kill();
});

async function waitFor(predicate, timeoutMs) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for mock host state.');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test('mock host offers the shadow DB stack mode only with --shadow-db, like the real host', async () => {
    for (const [args, offered] of [[['--config'], false], [['--config', '--shadow-db'], true]]) {
        const child = spawnMockHost(args);
        const client = createProtocolClient({ input: child.stdout, output: child.stdin, errorInput: child.stderr });

        const session = await client.connect();
        const shadow = session.choices.stackModes.find((choice) => choice.value === 'fullstack-shadow-db');
        expect(Boolean(shadow)).toBe(offered);
        if (offered) expect(shadow.supportsVisualStudio).toBe(false);

        await client.shutdown('quit', 'test complete');
        await client.exitPromise;
        child.kill();
    }
});

test('persistent mock process survives disconnect and restores controls without relaunching', async () => {
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-portals-process-test-${randomUUID()}`
        : path.join(os.tmpdir(), `cc-portals-${randomUUID()}.sock`);
    const token = randomUUID();
    let client;
    let reference;
    try {
        client = await connectToLauncherHost({
            hostPath: HOST_SCRIPT, persistentSession: { endpoint, token },
        });
        reference = { endpoint, token, sessionId: client.hello.sessionId };
        const pid = client.hello.authority.pid;
        await client.request('command.launch', { source: 'selection', selection: {
            portals: ['coordinator'], stackMode: 'frontend-dev-api', autoOpen: false,
        } });
        await waitFor(() => client.lastSnapshot?.targets.every(target => target.status === 'ready'), 5000);
        client.close();
        expect(() => process.kill(pid, 0)).not.toThrow();
        await new Promise(resolve => setTimeout(resolve, 50));
        client = await reconnectToLauncherHost(reference);
        expect(client.hello.authority.pid).toBe(pid);
        expect(client.session).toMatchObject({
            running: true, runningSelection: { portals: ['coordinator'], stackMode: 'frontend-dev-api' },
        });
        expect(client.lastSnapshot.targets).toMatchObject([{ id: 'coordinator', status: 'ready' }]);
        const logs = [];
        client.onLog(entry => logs.push(entry));
        expect(logs.some(entry => entry.line.includes('ready'))).toBe(true);
        await client.request('command.target.restart', { targetId: 'coordinator' });
        await expect(client.request('command.launch', { source: 'saved' })).rejects.toThrow('already been launched');
        await client.shutdown('quit', 'test complete');
        expect(client.sessionEnded).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 50));
        await expect(reconnectToLauncherHost(reference)).rejects.toThrow();
    } finally {
        if (client && !client.sessionEnded) {
            client.close();
            if (reference) {
                const cleanup = await reconnectToLauncherHost(reference);
                await cleanup.shutdown('quit', 'test cleanup');
            }
        }
    }
});

test('a persistent session survives its client process exiting', async () => {
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-portals-parent-exit-${randomUUID()}`
        : path.join(os.tmpdir(), `cc-portals-${randomUUID()}.sock`);
    const token = randomUUID();
    const clientModule = new URL('../src/protocol-client.mjs', import.meta.url).href;
    const script = `
        import { connectToLauncherHost } from ${JSON.stringify(clientModule)};
        const client = await connectToLauncherHost({
            hostPath: ${JSON.stringify(HOST_SCRIPT)},
            persistentSession: {
                endpoint: process.env.TEST_SESSION_ENDPOINT,
                token: process.env.TEST_SESSION_TOKEN,
            },
        });
        await client.request('command.launch', { source: 'saved' });
        console.log(JSON.stringify({ sessionId: client.hello.sessionId, pid: client.hello.authority.pid }));
        client.close();
    `;
    const driver = spawn(process.execPath, ['--input-type=module', '--eval', script], {
        env: { ...process.env, TEST_SESSION_ENDPOINT: endpoint, TEST_SESSION_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    driver.stdout.on('data', chunk => { stdout += chunk; });
    driver.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
        driver.once('error', reject);
        driver.once('exit', resolve);
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const { sessionId, pid } = JSON.parse(stdout);
    const client = await reconnectToLauncherHost({ endpoint, token, sessionId });
    try {
        expect(client.hello.authority.pid).toBe(pid);
        expect(client.session.running).toBe(true);
        await waitFor(() => client.lastSnapshot?.targets.every(target => target.status === 'ready'), 5000);
        await client.shutdown('quit', 'parent exit test complete');
    } finally {
        if (!client.sessionEnded) await client.shutdown('quit', 'test cleanup');
    }
});
