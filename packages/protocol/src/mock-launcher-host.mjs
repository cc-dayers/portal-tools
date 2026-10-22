#!/usr/bin/env node
// Fake "launcher host" that speaks the same cc.portals.launcher v1 protocol
// as Portals/scripts/portal-launcher-host.mjs in carecontinuity.app, but
// never spawns a single real dev server. It lets the TUI and the VS Code
// extension be developed, demoed, and tested without the Portals monorepo.
//
// Point a client at it, for example from packages/tui:
//   node src/bin.mjs --host ../protocol/src/mock-launcher-host.mjs -- --config
//
// Scenario selection (env var MOCK_SCENARIO, default "happy"):
//   happy      - every target starts and reaches "ready"
//   one-fails  - one target fails to start
//   flaky      - a target flickers through rebuilding a couple of times
//   slow       - targets take longer to become ready, to see the "starting" state
//
// This file intentionally has zero imports from outside this repo.

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPersistentMockTransport } from './mock-launcher-transport.mjs';
import { randomUUID } from 'node:crypto';

const PROTOCOL = 'cc.portals.launcher.v1';
const PROTOCOL_VERSION = 1;
const SCENARIO = process.env.MOCK_SCENARIO || 'happy';

// Choices mirror the real host's session-ready payload exactly: domain values only.
// Presentation (icons, headings, colours) belongs to each client.
const MOCK_PORTAL_CHOICES = [
    { label: 'SSO', value: 'sso' },
    { label: 'Provider', value: 'provider' },
    { label: 'Coordinator', value: 'coordinator' },
    { label: 'Admin', value: 'admin' },
    { label: 'Reports', value: 'reports' },
    { label: 'Patient', value: 'patient' },
];

const MOCK_BACKEND_CHOICES = [
    { label: 'API', value: 'api' },
    { label: 'Authentication', value: 'auth' },
    { label: 'Patients', value: 'patients' },
    { label: 'Dev Proxy', value: 'proxy' },
    { label: 'Notifications', value: 'notifications' },
    { label: 'Tasks', value: 'tasks' },
    { label: 'Appointments', value: 'appointments' },
    { label: 'Workflows', value: 'workflows' },
    { label: 'Populations', value: 'populations' },
    { label: 'DataFlows', value: 'dataflows' },
];

const MOCK_STACK_MODE_CHOICES = [
    { label: 'Full-stack · local data', value: 'fullstack-local-db', description: 'Local frontend and backend using local data' },
    { label: 'Full-stack · dev data', value: 'fullstack-dev-db', description: 'Local frontend and backend using dev data' },
    { label: 'Frontend · local API', value: 'frontend-local-api', description: 'Local frontend using an independently managed local API' },
    { label: 'Frontend · dev API', value: 'frontend-dev-api', description: 'Local frontend using the deployed dev API' },
];

// The real host offers this only where its experimental shadow-data tooling exists;
// the mock offers it with --shadow-db.
const MOCK_SHADOW_STACK_MODE_CHOICE = {
    label: 'Full-stack · shadow data',
    value: 'fullstack-shadow-db',
    description: 'Local frontend and backend using shadow data (experimental)',
    supportsVisualStudio: false,
};

const MOCK_BACKEND_RUN_MODE_CHOICES = [
    { label: 'Background', value: 'background' },
    { label: 'Visual Studio', value: 'vs', disabled: false },
    { label: 'Mixed', value: 'mixed', disabled: false },
];

const MOCK_EXISTING_SERVER_CHOICES = [
    { label: 'Kill before start', value: 'kill-before-start', description: 'stop selected portal ports before launching' },
    { label: 'Auto kill and restart on failure', value: 'auto-restart', description: 'adopt healthy servers; otherwise kill and restart' },
    { label: 'None', value: 'none', description: 'let server commands fail normally' },
];

// The real host sends its own saved-config format (environment/backendProfile),
// not the client selection model used by initialSelection.
const MOCK_SAVED_CONFIG = {
    portals: ['sso', 'provider'],
    environment: 'dev-api',
    backendModules: [],
    backendProfile: 'local',
    backendWatchModules: [],
    visualStudioModules: [],
    buildMode: 'dev',
    verbose: false,
    autoOpen: true,
    existingServerMode: 'auto-restart',
};

export function createMockLauncherHost({
    input = process.stdin,
    output = process.stdout,
    args = [],
    scenario = SCENARIO,
    reconnectable = false,
} = {}) {
    const cliArgs = new Set(args);
    const configurationRequired = cliArgs.has('--config') || cliArgs.has('--configure');

    let inputBuffer = '';
    let handshakeComplete = false;
    let launched = false;
    let setupChecked = false;
    let finished = false;
    let runningSelection = null;
    let lastSnapshot = null;
    const recentLogs = [];
    let timers = [];
    let resolveDone;
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });

    function send(type, payload = {}, requestId = null, replay = false) {
        if (finished) return;
        if (type === 'event.state') lastSnapshot = structuredClone(payload);
        if (type === 'event.log' && !replay) {
            recentLogs.push(payload);
            if (recentLogs.length > 500) recentLogs.shift();
        }
        const message = { protocol: PROTOCOL, version: PROTOCOL_VERSION, type, payload };
        if (requestId) message.requestId = requestId;
        output.write(`${JSON.stringify(message)}\n`);
    }

    function sendError(requestId, code, message, retryable = false) {
        send('response.error', { code, message, retryable }, requestId);
    }

    function finish(exitCode) {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        timers = [];
        input.off?.('data', handleData);
        input.off?.('end', handleEnd);
        resolveDone(exitCode);
    }

    function schedule(fn, delayMs) {
        const timer = setTimeout(fn, delayMs);
        timers.push(timer);
        return timer;
    }

    function sendSessionReady() {
        send('event.session-ready', {
            mode: configurationRequired ? 'configure' : 'quick-launch',
            configurationRequired,
            configPath: 'scripts/.launcher-config.json',
            logPath: 'scripts/logs/portals.log',
            savedConfig: MOCK_SAVED_CONFIG,
            initialSelection: {
                portals: MOCK_SAVED_CONFIG.portals,
                stackMode: 'frontend-dev-api',
                backendRunMode: 'background',
                backendModules: [],
                visualStudioModules: [],
                backendWatchModules: [],
                buildMode: 'dev',
                existingServerMode: 'auto-restart',
                verbose: false,
                autoOpen: true,
            },
            choices: {
                portals: MOCK_PORTAL_CHOICES,
                backendModules: MOCK_BACKEND_CHOICES,
                stackModes: cliArgs.has('--shadow-db')
                    ? [...MOCK_STACK_MODE_CHOICES.slice(0, 2), MOCK_SHADOW_STACK_MODE_CHOICE, ...MOCK_STACK_MODE_CHOICES.slice(2)]
                    : MOCK_STACK_MODE_CHOICES,
                backendRunModes: MOCK_BACKEND_RUN_MODE_CHOICES,
                existingServerModes: MOCK_EXISTING_SERVER_CHOICES,
                visualStudioAvailable: true,
            },
            ...(reconnectable ? { running: launched, runningSelection } : {}),
        });
        if (reconnectable && lastSnapshot) send('event.state', lastSnapshot);
        if (reconnectable) {
            for (const entry of recentLogs) send('event.log', entry, null, true);
        }
    }

    function buildTargets(selectionOrSaved) {
        const portalIds = Array.isArray(selectionOrSaved?.portals) && selectionOrSaved.portals.length > 0
            ? selectionOrSaved.portals
            : MOCK_SAVED_CONFIG.portals;

        return portalIds.map((id) => {
            const meta = MOCK_PORTAL_CHOICES.find((choice) => choice.value === id) ?? { label: id, color: 'white' };
            return {
                id,
                label: meta.label,
                color: meta.color,
                kind: 'frontend',
                url: `http://localhost:${3000 + portalIds.indexOf(id)}`,
                openable: true,
                status: 'starting',
            };
        });
    }

    function runScenario(message, targets) {
        const state = { targets, isShuttingDown: false, shutdownReason: '', logPath: 'scripts/logs/portals.log' };
        const emitState = () => send('event.state', state, null);
        const emitLog = (target, line, source = 'stdout') =>
            send('event.log', {
                targetId: target.id,
                targetLabel: target.label,
                targetColor: target.color,
                source,
                line,
                timestamp: Date.now(),
            });

        emitState();

        targets.forEach((target, index) => {
            const baseDelay = scenario === 'slow' ? 2500 : 400;
            const startDelay = baseDelay + index * 250;

            emitLog(target, `Starting ${target.label}...`);

            schedule(() => {
                const shouldFail = scenario === 'one-fails' && index === targets.length - 1;
                if (shouldFail) {
                    target.status = 'failed';
                    target.failureReason = 'Mock failure: port already in use';
                    emitLog(target, 'Error: address already in use :::3000', 'stderr');
                    emitState();
                    return;
                }

                target.status = 'ready';
                target.readyAt = Date.now();
                emitLog(target, `${target.label} ready at ${target.url}`);
                emitState();

                if (scenario === 'flaky' && index === 0) {
                    schedule(() => {
                        target.status = 'rebuilding';
                        emitLog(target, 'File change detected. Rebuilding...');
                        emitState();
                    }, 3000);
                    schedule(() => {
                        target.status = 'ready';
                        emitLog(target, `${target.label} ready at ${target.url}`);
                        emitState();
                    }, 4500);
                }
            }, startDelay);
        });
    }

    async function handleLaunch(message) {
        if (launched) {
            sendError(message.requestId, 'COMMAND_REJECTED', 'Portals have already been launched.');
            return;
        }

        let selection;
        if (message.payload?.source === 'saved') {
            selection = MOCK_SAVED_CONFIG;
        } else if (message.payload?.source === 'selection') {
            selection = message.payload.selection;
        } else {
            sendError(message.requestId, 'INVALID_MESSAGE', 'Launch source must be saved or selection.');
            return;
        }

        launched = true;
        runningSelection = message.payload.source === 'saved'
            ? {
                portals: MOCK_SAVED_CONFIG.portals, stackMode: 'frontend-dev-api',
                backendRunMode: 'background', backendModules: [], visualStudioModules: [],
                backendWatchModules: [], buildMode: 'dev', existingServerMode: 'auto-restart',
                verbose: false, autoOpen: true,
            }
            : structuredClone(selection);
        const targets = buildTargets(selection);
        send('response.ok', { command: 'launch', accepted: true }, message.requestId);
        runScenario(message, targets);

        // In "happy"/"one-fails"/"slow" scenarios, stay running until the
        // client asks us to shut down (mirrors the real long-lived launcher).
    }

    function handleShutdown(message) {
        send('response.ok', { command: message.type, accepted: true }, message.requestId);
        send('event.session-exit', {
            exitCode: 0,
            shutdownKind: 'signal',
            shutdownReason: message.payload?.reason ?? 'quit',
        });
        finish(0);
    }

    function handleTargetCommand(message, method) {
        // Accept every target action instantly; nothing real is running so
        // there is nothing to actually start/stop/restart.
        send('response.ok', { command: message.type, accepted: true }, message.requestId);
    }

    async function handleMessage(message) {
        if (!message || message.protocol !== PROTOCOL || message.version !== PROTOCOL_VERSION) {
            sendError(message?.requestId, 'INVALID_MESSAGE', 'Expected a version 1 portal launcher message.');
            return;
        }

        if (!handshakeComplete || (reconnectable && message.type === 'client.hello')) {
            if (message.type !== 'client.hello') {
                sendError(message.requestId, 'INVALID_MESSAGE', 'client.hello must be the first command.');
                return;
            }
            handshakeComplete = true;
            send('response.ok', { command: 'client.hello' }, message.requestId);
            sendSessionReady();
            return;
        }

        switch (message.type) {
            case 'command.setup.check':
                if (cliArgs.has('--setup-required') && !setupChecked) {
                    setupChecked = true;
                    send('response.ok', {
                        ready: false,
                        missing: [{ id: 'engine', name: 'Podman', purpose: 'mock container engine' }],
                        guide: 'Mock launcher setup: no software will be installed.',
                        terminal: {
                            command: process.execPath,
                            args: ['-e', 'console.log("Mock prerequisites are ready.")'],
                            cwd: process.cwd(),
                        },
                    }, message.requestId);
                } else {
                    send('response.ok', { ready: true }, message.requestId);
                }
                break;
            case 'command.launch':
                await handleLaunch(message);
                break;
            case 'command.target.start':
            case 'command.target.stop':
            case 'command.target.restart':
            case 'command.target.open':
                handleTargetCommand(message, message.type);
                break;
            case 'command.session.restart-all':
                send('response.ok', { command: message.type, accepted: true }, message.requestId);
                break;
            case 'command.backend.add':
                send('response.ok', { command: message.type, accepted: true }, message.requestId);
                break;
            case 'command.session.shutdown':
                handleShutdown(message);
                break;
            default:
                sendError(message.requestId, 'INVALID_MESSAGE', `Unknown command: ${message.type}.`);
        }
    }

    function handleData(chunk) {
        if (finished) return;
        inputBuffer += chunk.toString('utf8');
        let newlineIndex;
        while ((newlineIndex = inputBuffer.indexOf('\n')) >= 0) {
            const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, '');
            inputBuffer = inputBuffer.slice(newlineIndex + 1);
            if (!line.trim()) continue;
            try {
                void handleMessage(JSON.parse(line));
            } catch {
                sendError(null, 'INVALID_JSON', 'Input was not valid JSON.');
            }
        }
    }

    function handleEnd() {
        if (!finished) finish(0);
    }

    input.on('data', handleData);
    input.on('end', handleEnd);
    input.setEncoding?.('utf8');

    send('server.hello', {
        supportedVersions: [PROTOCOL_VERSION],
        sessionId: randomUUID(),
        authority: { name: 'mock-portals-launcher', pid: process.pid, nodeVersion: process.versions.node },
        capabilities: {
            ...(reconnectable ? { persistentSession: true } : {}),
            commands: [
                'setup.check',
                'launch',
                'target.start',
                'target.stop',
                'target.restart',
                'target.open',
                'backend.add',
                'session.restart-all',
                'session.shutdown',
            ],
            events: ['session-ready', 'state', 'log', 'log-dropped', 'error', 'session-exit'],
        },
    });

    return { done, close: handleEnd };
}

export async function runMockLauncherHost(args = process.argv.slice(2)) {
    const endpoint = process.env.CC_PORTALS_SESSION_ENDPOINT;
    const token = process.env.CC_PORTALS_SESSION_TOKEN;
    delete process.env.CC_PORTALS_SESSION_ENDPOINT;
    delete process.env.CC_PORTALS_SESSION_TOKEN;
    const transport = endpoint
        ? await createPersistentMockTransport({ endpoint, token, input: process.stdin, output: process.stdout })
        : null;
    try {
        return await createMockLauncherHost({
            args,
            ...(transport ? { input: transport.input, output: transport.output, reconnectable: true } : {}),
        }).done;
    } finally {
        transport?.close();
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    process.exitCode = await runMockLauncherHost();
}
