import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import {
    PROTOCOL,
    PROTOCOL_VERSION,
    createProtocolClient,
    stackModeSupportsVisualStudio,
    ensureLauncherSetup,
    reconnectToLauncherHost,
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

test('reconnect authenticates and restores a snapshot without issuing a launch', async () => {
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-portals-client-test-${randomUUID()}`
        : path.join(os.tmpdir(), `cc-portals-${randomUUID()}.sock`);
    const requests = [];
    const sockets = new Set();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.write(serverMessage('server.hello', 1, {
            supportedVersions: [1], sessionId: 'existing-session', capabilities: { persistentSession: true },
        }));
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const request = JSON.parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                requests.push(request);
                socket.write(serverMessage('response.ok', 2, {}, request.requestId));
                if (request.type === 'client.hello') {
                    socket.write(serverMessage('event.session-ready', 3, {
                        running: true, runningSelection: { portals: ['sso'] },
                    }));
                    socket.write(serverMessage('event.state', 4, { targets: [{ id: 'sso', status: 'ready' }] }));
                } else if (request.type === 'command.session.shutdown') {
                    socket.end(serverMessage('event.session-exit', 5, { exitCode: 0 }));
                }
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, resolve);
    });
    let client;
    try {
        client = await reconnectToLauncherHost({ endpoint, token: 'private-key', sessionId: 'existing-session' });
        expect(client.session.running).toBe(true);
        expect(client.lastSnapshot.targets[0]).toMatchObject({ id: 'sso', status: 'ready' });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ type: 'client.hello', payload: { sessionToken: 'private-key' } });
        await client.shutdown();
        expect(client.sessionEnded).toBe(true);
        await expect(reconnectToLauncherHost({
            endpoint, token: 'private-key', sessionId: 'different-session',
        })).rejects.toThrow('does not match');
        expect(requests.every(request => request.type !== 'command.launch')).toBe(true);
    } finally {
        client?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    }
    await expect(reconnectToLauncherHost({
        endpoint, token: 'private-key', sessionId: 'existing-session',
    })).rejects.toThrow();
});

test('unexpected EOF reports disconnection, not a completed session', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = createProtocolClient({ input, output });
    const requests = collectJson(output);
    input.write(serverMessage('server.hello', 1, { supportedVersions: [1] }));
    const connected = client.connect();
    await waitFor(() => requests.length === 1);
    input.write(serverMessage('response.ok', 2, {}, requests[0].requestId));
    input.write(serverMessage('event.session-ready', 3, { running: true }));
    await connected;
    const error = vi.fn();
    client.onError(error);
    input.end();
    await expect(client.exitPromise).resolves.toBe(1);
    expect(client.sessionEnded).toBe(false);
    expect(error).toHaveBeenCalledWith({ message: 'Launcher session connection closed.' });
});