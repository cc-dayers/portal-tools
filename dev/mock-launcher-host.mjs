#!/usr/bin/env node
// Fake "launcher host" that speaks the same cc.portals.launcher v1 protocol
// as ../../scripts/portal-launcher-host.mjs in the main Portals repo, but
// never spawns a single real dev server. It exists so the TUI (this repo)
// can be developed and demoed on its own, without the Portals monorepo.
//
// Run it directly with `node dev/run-mock.mjs` (see that file), or point
// cc-portals-tui / the built cli.mjs at it manually:
//   node src/bin.mjs --host dev/mock-launcher-host.mjs -- --config
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

const PROTOCOL = 'cc.portals.launcher.v1';
const PROTOCOL_VERSION = 1;
const SCENARIO = process.env.MOCK_SCENARIO || 'happy';

const MOCK_PORTAL_CHOICES = [
    { label: 'SSO', value: 'sso', color: 'magenta' },
    { label: 'Provider', value: 'provider', color: 'cyan' },
    { label: 'Coordinator', value: 'coordinator', color: 'yellow' },
    { label: 'Admin', value: 'admin', color: 'red' },
    { label: 'Reports', value: 'reports', color: 'green' },
    { label: 'Patient', value: 'patient', color: 'blue' },
];

const MOCK_BACKEND_CHOICES = [
    { label: 'API', value: 'api' },
    { label: 'Authentication', value: 'auth' },
    { label: 'Patients', value: 'patients' },
    { label: 'Dev Proxy', value: 'proxy' },
    { label: 'Appointments', value: 'appointments' },
    { label: 'Data Flows', value: 'dataflows' },
    { label: 'Notifications', value: 'notifications' },
    { label: 'Populations', value: 'populations' },
    { label: 'Tasks', value: 'tasks' },
    { label: 'Workflows', value: 'workflows' },
];

const MOCK_STACK_MODE_CHOICES = [
    { label: 'Full stack — local database', value: 'fullstack-local-db' },
    { label: 'Full stack — dev database', value: 'fullstack-dev-db' },
    { label: 'Frontend — local APIs', value: 'frontend-local-api' },
    { label: 'Frontend — dev APIs', value: 'frontend-dev-api' },
];

const MOCK_BACKEND_RUN_MODE_CHOICES = [
    { label: 'Background', value: 'background' },
    { label: 'Visual Studio', value: 'vs' },
    { label: 'Mixed', value: 'mixed' },
];

const MOCK_EXISTING_SERVER_CHOICES = [
    { label: 'Kill before start', value: 'kill-before-start', description: 'stop selected portal ports before launching' },
    { label: 'Auto kill and restart on failure', value: 'auto-restart', description: 'adopt healthy servers; otherwise kill and restart' },
    { label: 'None', value: 'none', description: 'let server commands fail normally' },
];

const MOCK_SAVED_CONFIG = {
    portals: ['sso', 'provider'],
    stackMode: 'frontend-dev-api',
    backendRunMode: 'background',
    backendModules: [],
    visualStudioModules: [],
    backendWatchModules: [],
    buildMode: 'dev',
    existingServerMode: 'auto-restart',
    verbose: false,
    autoOpen: true,
};

export function createMockLauncherHost({
    input = process.stdin,
    output = process.stdout,
    args = [],
    scenario = SCENARIO,
} = {}) {
    const cliArgs = new Set(args);
    const configurationRequired = cliArgs.has('--config') || cliArgs.has('--configure');

    let inputBuffer = '';
    let handshakeComplete = false;
    let launched = false;
    let finished = false;
    let timers = [];
    let resolveDone;
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });

    function send(type, payload = {}, requestId = null) {
        if (finished) return;
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
                stackModes: MOCK_STACK_MODE_CHOICES,
                backendRunModes: MOCK_BACKEND_RUN_MODE_CHOICES,
                existingServerModes: MOCK_EXISTING_SERVER_CHOICES,
            },
        });
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
                kind: 'portal',
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

        if (!handshakeComplete) {
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
        sessionId: 'mock-session',
        authority: { name: 'mock-portals-launcher', pid: process.pid, nodeVersion: process.versions.node },
        capabilities: {
            commands: [
                'launch',
                'target.start',
                'target.stop',
                'target.restart',
                'target.open',
                'session.restart-all',
                'session.shutdown',
            ],
            events: ['session-ready', 'state', 'log', 'log-dropped', 'error', 'session-exit'],
        },
    });

    return { done, close: handleEnd };
}

async function main() {
    const host = createMockLauncherHost({ args: process.argv.slice(2) });
    process.exitCode = await host.done;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    await main();
}
