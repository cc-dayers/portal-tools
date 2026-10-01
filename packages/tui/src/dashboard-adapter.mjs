// Adapts a protocol client to the launchPortals/controller contract the Ink dashboard was built around.
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
        addBackend: (request) => requestAccepted(client, 'command.backend.add', request),
        restartAll: () => requestAccepted(client, 'command.session.restart-all'),
        stopAll: (reason = 'quit') =>
            requestAccepted(client, 'command.session.shutdown', { cause: 'quit', reason }),
    });
}

async function requestAccepted(client, type, payload = {}) {
    const response = await client.request(type, payload);
    return response?.accepted !== false;
}
