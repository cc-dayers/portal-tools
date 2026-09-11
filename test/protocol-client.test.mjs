import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import {
    PROTOCOL,
    PROTOCOL_VERSION,
    createDashboardLauncherAdapter,
    createProtocolClient,
} from '../src/protocol-client.mjs';

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

test('dashboard adapter maps controller actions and streamed events to the existing UI contract', async () => {
    const hostOutput = new PassThrough();
    const hostInput = new PassThrough();
    const requests = collectJson(hostInput);
    const client = createProtocolClient({ input: hostOutput, output: hostInput });

    hostOutput.write(serverMessage('server.hello', 1, { supportedVersions: [1] }));
    const connectPromise = client.connect();
    await waitFor(() => requests.length === 1);
    hostOutput.write(serverMessage('response.ok', 2, {}, requests[0].requestId));
    hostOutput.write(serverMessage('event.session-ready', 3, { configurationRequired: false }));
    await connectPromise;

    const onControllerReady = vi.fn();
    const onStateChange = vi.fn();
    const onLog = vi.fn();
    const launch = createDashboardLauncherAdapter(client, { source: 'saved' });
    const launchPromise = launch({ onControllerReady, onStateChange, onLog });

    await waitFor(() => requests.some((request) => request.type === 'command.launch'));
    const launchRequest = requests.find((request) => request.type === 'command.launch');
    hostOutput.write(serverMessage('response.ok', 4, { accepted: true }, launchRequest.requestId));
    hostOutput.write(serverMessage('event.state', 5, { targets: [], isShuttingDown: false }));
    hostOutput.write(
        serverMessage('event.log', 6, {
            targetId: 'launcher',
            targetLabel: 'Launcher',
            source: 'stdout',
            line: 'started',
            timestamp: 1,
        }),
    );
    await waitFor(() => onStateChange.mock.calls.length === 1 && onLog.mock.calls.length === 1);

    const controller = onControllerReady.mock.calls[0][0];
    const restartPromise = controller.restart('provider-local');
    await waitFor(() => requests.some((request) => request.type === 'command.target.restart'));
    const restartRequest = requests.find((request) => request.type === 'command.target.restart');
    hostOutput.write(serverMessage('response.ok', 7, { accepted: true }, restartRequest.requestId));
    await expect(restartPromise).resolves.toBe(true);

    const addPromise = controller.addBackend({ module: 'appointments', runMode: 'background', watch: true });
    await waitFor(() => requests.some((request) => request.type === 'command.backend.add'));
    const addRequest = requests.find((request) => request.type === 'command.backend.add');
    expect(addRequest.payload).toEqual({ module: 'appointments', runMode: 'background', watch: true });
    hostOutput.write(serverMessage('response.ok', 8, { accepted: true }, addRequest.requestId));
    await expect(addPromise).resolves.toBe(true);

    hostOutput.write(serverMessage('event.session-exit', 9, { exitCode: 0 }));
    await expect(launchPromise).resolves.toBe(0);
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
