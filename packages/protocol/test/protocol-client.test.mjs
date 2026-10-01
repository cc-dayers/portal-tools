import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import {
    PROTOCOL,
    PROTOCOL_VERSION,
    createProtocolClient,
} from '../src/protocol-client.mjs';

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
