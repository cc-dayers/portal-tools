import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export const PROTOCOL = 'cc.portals.launcher';
export const PROTOCOL_VERSION = 1;
const MAX_LINE_CHARS = 1_048_576;
const MAX_BUFFERED_LOGS = 500;
const REQUEST_TIMEOUT_MS = 10_000;

export async function connectToLauncherHost({ hostPath, hostArgs = [], cwd, env = process.env }) {
    const child = spawn(process.execPath, [hostPath, ...hostArgs], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const client = createProtocolClient({
        input: child.stdout,
        output: child.stdin,
        errorInput: child.stderr,
        onClose() {
            if (!child.killed) child.kill();
        },
    });

    child.once('error', (error) => client.fail(error));
    child.once('exit', (code, signal) => client.handleProcessExit(code, signal));
    await client.connect();
    return client;
}

export function createProtocolClient({ input, output, errorInput, onClose = () => {} }) {
    const events = new EventEmitter();
    const pending = new Map();
    const bufferedLogs = [];
    let inputBuffer = '';
    let stderrBuffer = '';
    let requestSequence = 0;
    let hello = null;
    let session = null;
    let lastSnapshot = null;
    let closed = false;
    let resolveExit;
    let resolveHello;
    let rejectHello;
    let resolveSession;
    let rejectSession;

    const exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
    });
    const helloPromise = new Promise((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
    });
    const sessionPromise = new Promise((resolve, reject) => {
        resolveSession = resolve;
        rejectSession = reject;
    });

    function send(type, payload = {}) {
        if (closed || output.destroyed || output.writableEnded) {
            return Promise.reject(new Error('Portal launcher connection is closed.'));
        }

        const requestId = `request-${++requestSequence}`;
        const message = {
            protocol: PROTOCOL,
            version: PROTOCOL_VERSION,
            type,
            requestId,
            payload,
        };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new Error(`Timed out waiting for ${type}.`));
            }, REQUEST_TIMEOUT_MS);
            pending.set(requestId, { resolve, reject, timer });
            output.write(`${JSON.stringify(message)}\n`);
        });
    }

    function handleMessage(message) {
        if (
            !message ||
            message.protocol !== PROTOCOL ||
            message.version !== PROTOCOL_VERSION ||
            typeof message.type !== 'string'
        ) {
            fail(new Error('Launcher host sent an incompatible protocol message.'));
            return;
        }

        if (message.type === 'server.hello') {
            hello = message.payload;
            resolveHello(message.payload);
            return;
        }

        if (message.type === 'response.ok' || message.type === 'response.error') {
            const request = pending.get(message.requestId);
            if (!request) return;
            pending.delete(message.requestId);
            clearTimeout(request.timer);
            if (message.type === 'response.ok') request.resolve(message.payload);
            else request.reject(new Error(message.payload?.message || 'Launcher command failed.'));
            return;
        }

        if (message.type === 'event.session-ready') {
            session = message.payload;
            resolveSession(message.payload);
        } else if (message.type === 'event.state') {
            lastSnapshot = message.payload;
            events.emit('state', message.payload);
        } else if (message.type === 'event.log') {
            if (events.listenerCount('log') === 0) {
                bufferedLogs.push(message.payload);
                if (bufferedLogs.length > MAX_BUFFERED_LOGS) bufferedLogs.shift();
            } else {
                events.emit('log', message.payload);
            }
        } else if (message.type === 'event.log-dropped') {
            events.emit('log', {
                targetId: 'launcher',
                targetLabel: 'Launcher',
                source: 'stderr',
                line: `${message.payload?.count ?? 0} log lines dropped during output burst`,
                timestamp: Date.now(),
            });
        } else if (message.type === 'event.error') {
            events.emit('error-event', message.payload);
        } else if (message.type === 'event.session-exit') {
            closed = true;
            resolveExit(message.payload?.exitCode ?? 1);
            cleanup();
        }
    }

    function handleData(chunk) {
        inputBuffer += chunk.toString('utf8');
        if (inputBuffer.length > MAX_LINE_CHARS && !inputBuffer.includes('\n')) {
            fail(new Error('Launcher host sent an oversized protocol message.'));
            return;
        }

        let newlineIndex;
        while ((newlineIndex = inputBuffer.indexOf('\n')) >= 0) {
            const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, '');
            inputBuffer = inputBuffer.slice(newlineIndex + 1);
            if (!line) continue;
            try {
                handleMessage(JSON.parse(line));
            } catch {
                fail(new Error('Launcher host sent invalid JSON.'));
                return;
            }
        }
    }

    function handleErrorData(chunk) {
        stderrBuffer = `${stderrBuffer}${chunk.toString('utf8')}`.slice(-4096);
    }

    function cleanup() {
        input.off?.('data', handleData);
        input.off?.('error', fail);
        errorInput?.off?.('data', handleErrorData);
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Portal launcher connection closed.'));
        }
        pending.clear();
        onClose();
    }

    function fail(error) {
        if (closed) return;
        closed = true;
        const detail = stderrBuffer.trim();
        const failure = new Error(detail ? `${error.message} ${detail}` : error.message);
        rejectHello(failure);
        rejectSession(failure);
        events.emit('error-event', { message: failure.message });
        resolveExit(1);
        cleanup();
    }

    input.setEncoding?.('utf8');
    input.on('data', handleData);
    input.on('error', fail);
    errorInput?.setEncoding?.('utf8');
    errorInput?.on('data', handleErrorData);

    return {
        async connect() {
            const serverHello = await withTimeout(helloPromise, REQUEST_TIMEOUT_MS, 'launcher hello');
            if (!serverHello?.supportedVersions?.includes(PROTOCOL_VERSION)) {
                throw new Error('Launcher host does not support protocol version 1.');
            }
            await send('client.hello', {
                selectedVersion: PROTOCOL_VERSION,
                client: { name: 'cc-portals-tui', version: '0.1.9' },
            });
            return withTimeout(sessionPromise, REQUEST_TIMEOUT_MS, 'launcher session');
        },
        get session() {
            return session;
        },
        get lastSnapshot() {
            return lastSnapshot;
        },
        get exitPromise() {
            return exitPromise;
        },
        request: send,
        onState(listener) {
            events.on('state', listener);
            if (lastSnapshot) listener(lastSnapshot);
            return () => events.off('state', listener);
        },
        onLog(listener) {
            events.on('log', listener);
            bufferedLogs.splice(0).forEach(listener);
            return () => events.off('log', listener);
        },
        onError(listener) {
            events.on('error-event', listener);
            return () => events.off('error-event', listener);
        },
        fail,
        handleProcessExit(code, signal) {
            if (closed) return;
            fail(
                new Error(
                    `Launcher host exited before the session completed (${signal || code || 'unknown'}).`,
                ),
            );
        },
        async shutdown(cause = 'quit', reason = cause) {
            if (closed) return exitPromise;
            await send('command.session.shutdown', { cause, reason });
            return exitPromise;
        },
        close() {
            if (closed) return;
            closed = true;
            cleanup();
        },
    };
}

export function createDashboardLauncherAdapter(client, launchPayload) {
    return async function launchWithProtocol(options) {
        const unsubscribeState = client.onState(options.onStateChange);
        const unsubscribeLog = client.onLog(options.onLog);
        const unsubscribeError = client.onError((error) => {
            options.onLog?.({
                targetId: 'launcher',
                targetLabel: 'Launcher',
                source: 'stderr',
                line: error?.message || 'Launcher protocol error.',
                timestamp: Date.now(),
            });
        });
        const controller = createProtocolController(client);
        options.onControllerReady(controller);

        try {
            await client.request('command.launch', launchPayload);
            return await client.exitPromise;
        } finally {
            unsubscribeState();
            unsubscribeLog();
            unsubscribeError();
        }
    };
}

function createProtocolController(client) {
    return Object.freeze({
        getSnapshot: () =>
            client.lastSnapshot ?? {
                targets: [],
                isShuttingDown: false,
                shutdownKind: null,
                shutdownReason: '',
                logPath: client.session?.logPath ?? '',
            },
        start: (targetId) => requestAccepted(client, 'command.target.start', { targetId }),
        stop: (targetId) => requestAccepted(client, 'command.target.stop', { targetId }),
        restart: (targetId) => requestAccepted(client, 'command.target.restart', { targetId }),
        open: (targetId) => requestAccepted(client, 'command.target.open', { targetId }),
        restartAll: () => requestAccepted(client, 'command.session.restart-all'),
        stopAll: (reason = 'quit') =>
            requestAccepted(client, 'command.session.shutdown', { cause: 'quit', reason }),
    });
}

async function requestAccepted(client, type, payload = {}) {
    const response = await client.request(type, payload);
    return response?.accepted !== false;
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}
