import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import {
    PROTOCOL,
    PROTOCOL_VERSION,
    createProtocolClient,
    stackModeSupportsVisualStudio,
    ensureLauncherSetup,
} from '../src/protocol-client.mjs';

test('setup preflight preserves older hosts and skips installation when ready', async () => {
    const runSetup = vi.fn();
    const client = { request: vi.fn().mockResolvedValue({ ready: true }) };
    expect(await ensureLauncherSetup(client, {}, runSetup)).toBe(true);
    expect(client.request).not.toHaveBeenCalled();
    client.hello = { capabilities: { commands: ['setup.check'] } };
    expect(await ensureLauncherSetup(client, { source: 'saved' }, runSetup)).toBe(true);
    expect(client.request).toHaveBeenCalledWith('command.setup.check', { source: 'saved' }, { timeoutMs: 120_000 });
    expect(runSetup).not.toHaveBeenCalled();
});

test('setup waits for the terminal flow and rechecks before permitting launch', async () => {
    const setup = { ready: false, guide: 'Install Podman', terminal: { command: 'node', args: ['setup'], cwd: '/app' } };
    const client = {
        hello: { capabilities: { commands: ['setup.check'] } },
        request: vi.fn().mockResolvedValueOnce(setup).mockResolvedValueOnce({ ready: true }),
    };
    const runSetup = vi.fn(async () => true);
    expect(await ensureLauncherSetup(client, { source: 'saved' }, runSetup)).toBe(true);
    expect(runSetup).toHaveBeenCalledWith(setup);
    expect(client.request).toHaveBeenCalledTimes(2);
});

test('setup cancellation does not recheck or launch and incomplete setup reports the guide', async () => {
    const client = {
        hello: { capabilities: { commands: ['setup.check'] } },
        request: vi.fn().mockResolvedValue({ ready: false, guide: 'Still missing Podman' }),
    };
    expect(await ensureLauncherSetup(client, {}, async () => false)).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(1);
    await expect(ensureLauncherSetup(client, {}, async () => true)).rejects.toThrow('Still missing Podman');
});

test('protocol client sends the configured client identity during the handshake', async () => {
    const hostOutput = new PassThrough();
    const hostInput = new PassThrough();
    const requests = collectJson(hostInput);
    const client = createProtocolClient({
        input: hostOutput,
        output: hostInput,
        clientInfo: { name: 'cc-portals-vscode', version: '0.0.1' },
    });

    hostOutput.write(serverMessage('server.hello', 1, { supportedVersions: [1] }));
    const connectPromise = client.connect();
    await waitFor(() => requests.length === 1);

    expect(requests[0]).toMatchObject({
        type: 'client.hello',
        payload: {
            selectedVersion: 1,
            client: { name: 'cc-portals-vscode', version: '0.0.1' },
        },
    });

    hostOutput.write(serverMessage('response.ok', 2, {}, requests[0].requestId));
    hostOutput.write(serverMessage('event.session-ready', 3, { configurationRequired: false }));
    await connectPromise;
    client.close();
});

test('protocol client handshakes and exposes session metadata', async () => {
    const hostOutput = new PassThrough();
    const hostInput = new PassThrough();
    const requests = collectJson(hostInput);
    const client = createProtocolClient({ input: hostOutput, output: hostInput });

    hostOutput.write(serverMessage('server.hello', 1, { supportedVersions: [1] }));
    const connectPromise = client.connect();
    await waitFor(() => requests.length === 1);
    expect(requests[0]).toMatchObject({ type: 'client.hello', payload: { selectedVersion: 1 } });

    hostOutput.write(serverMessage('response.ok', 2, { command: 'client.hello' }, requests[0].requestId));
    hostOutput.write(
        serverMessage('event.session-ready', 3, {
            mode: 'quick-launch',
            configurationRequired: false,
            logPath: 'scripts/logs/portals.log',
        }),
    );

    await expect(connectPromise).resolves.toMatchObject({ mode: 'quick-launch' });
    client.close();
});

function serverMessage(type, seq, payload, requestId) {
    return `${JSON.stringify({
        protocol: PROTOCOL,
        version: PROTOCOL_VERSION,
        type,
        seq,
        ...(requestId ? { requestId } : {}),
        payload,
    })}\n`;
}

function collectJson(stream) {
    const messages = [];
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line) messages.push(JSON.parse(line));
        }
    });
    return messages;
}

async function waitFor(predicate, timeoutMs = 1000) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for protocol activity.');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('stack modes allow Visual Studio unless the host sends supportsVisualStudio: false', () => {
    const stackModes = [
        { value: 'fullstack-local-db' },
        { value: 'fullstack-shadow-db', supportsVisualStudio: false },
    ];

    expect(stackModeSupportsVisualStudio(stackModes, 'fullstack-local-db')).toBe(true);
    expect(stackModeSupportsVisualStudio(stackModes, 'fullstack-shadow-db')).toBe(false);
    expect(stackModeSupportsVisualStudio(undefined, 'fullstack-local-db')).toBe(true);
});