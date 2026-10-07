import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';

import { createProtocolClient } from '../src/protocol-client.mjs';

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
