import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';

import { runPortalConfigTui } from './config-tui.mjs';
import { runPortalDashboard } from './dashboard-tui.mjs';
import { PROTOCOL, PROTOCOL_VERSION, connectToLauncherHost, ensureLauncherSetup, stackModeSupportsVisualStudio } from '@cc-dayers/portal-protocol';
import { connectToStoredLauncherSession, forgetStoredLauncherSession } from '@cc-dayers/portal-protocol/session-store';

import { createDashboardLauncherAdapter } from './dashboard-adapter.mjs';
import { runSelfUpdate } from './self-update.mjs';
import packageJson from '../package.json' with { type: 'json' };

const PACKAGE_VERSION = packageJson.version;
const CLIENT_NAME = 'cc-portals-tui';
const HOST_RELATIVE_PATH = path.join('Portals', 'scripts', 'portal-launcher-host.mjs');
// Launcher flags the host understands; they may be given directly instead of after `--`.
const HOST_FLAGS = new Set(['--config', '--reset', '--setup', '-c', '--verbose', '-v', '--debug']);

export async function prepareTuiLaunch(client, payload, {
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdin = process.stdin,
    stdout = process.stdout,
    spawnProcess = spawn,
} = {}) {
    return ensureLauncherSetup(client, payload, async (setup) => {
        if (!interactive) throw new Error(setup.guide || 'Launcher setup requires an interactive terminal.');
        const terminal = setup.terminal;
        if (!terminal?.command || !Array.isArray(terminal.args) || !terminal.cwd) {
            throw new Error('The launcher did not provide a setup terminal command.');
        }
        stdout.write(`${setup.guide || 'Launcher setup is required.'}\n`);
        const wasRaw = stdin.isRaw;
        const wasPaused = stdin.isPaused();
        if (wasRaw) stdin.setRawMode(false);
        stdin.pause();
        try {
            return await new Promise((resolve, reject) => {
                const child = spawnProcess(terminal.command, terminal.args, { cwd: terminal.cwd, stdio: 'inherit', windowsHide: false });
                child.once('error', reject);
                child.once('exit', (code) => resolve(code === 0));
            });
        } finally {
            if (wasRaw) stdin.setRawMode(true);
            if (!wasPaused) stdin.resume();
        }
    });
}

export function parseCliArgs(args) {
    const hostIndex = args.indexOf('--host');
    const separatorIndex = args.indexOf('--');
    const performanceIndex = args.indexOf('--performance-steady-ms');
    const performanceValue = performanceIndex >= 0 ? Number(args[performanceIndex + 1]) : null;
    if (
        performanceIndex >= 0 &&
        (!Number.isInteger(performanceValue) || performanceValue < 0)
    ) {
        throw new Error('--performance-steady-ms requires a nonnegative integer');
    }
    return {
        protocolInfo: args.includes('--protocol-info'),
        help: args.includes('--help') || args.includes('-h'),
        update: args.includes('--update'),
        forgetSession: args.includes('--forget-session'),
        performanceSteadyMs: performanceValue,
        hostPath: hostIndex >= 0 ? args[hostIndex + 1] ?? '' : '',
        hostArgs: [
            ...(separatorIndex >= 0 ? args.slice(0, separatorIndex) : args).filter((arg) => HOST_FLAGS.has(arg)),
            ...(separatorIndex >= 0 ? args.slice(separatorIndex + 1) : []),
        ],
    };
}

export function findLauncherHost(startDirectory = process.cwd(), exists = fs.existsSync) {
    let directory = path.resolve(startDirectory);
    while (true) {
        const candidate = path.join(directory, HOST_RELATIVE_PATH);
        if (exists(candidate)) return candidate;
        const parent = path.dirname(directory);
        if (parent === directory) return '';
        directory = parent;
    }
}

export function isReadySnapshot(snapshot) {
    return (
        Array.isArray(snapshot?.targets) &&
        snapshot.targets.length > 0 &&
        snapshot.targets.every((target) => target.status === 'ready')
    );
}

export function writePerformanceState(filePath, snapshot, append = fs.appendFileSync) {
    if (!filePath) return;
    const targets = (snapshot?.targets ?? []).map((target) => ({
        id: target.id,
        status: target.status,
        startedAt: Number.isFinite(target.startedAt) ? target.startedAt : null,
        readyAt: Number.isFinite(target.readyAt) ? target.readyAt : null,
        readySignal: target.readySignal ?? null,
        adopted: Boolean(target.adopted),
        failureReason: target.failureReason ?? null,
    }));
    append(filePath, `${JSON.stringify({ targets })}\n`);
}

export function toLauncherSelection(config) {
    return {
        portals: Array.isArray(config?.portals) ? config.portals : [],
        stackMode: config?.stackMode,
        backendRunMode: config?.backendRunMode ?? 'background',
        backendModules: Array.isArray(config?.backendModules) ? config.backendModules : [],
        visualStudioModules: Array.isArray(config?.visualStudioModules) ? config.visualStudioModules : [],
        backendWatchModules: Array.isArray(config?.backendWatchModules) ? config.backendWatchModules : [],
        buildMode: config?.buildMode === 'preview' ? 'preview' : 'dev',
        existingServerMode: config?.existingServerMode ?? 'auto-restart',
        verbose: config?.verbose ?? false,
        autoOpen: config?.autoOpen ?? true,
    };
}

// Visual Studio is offered when adding a backend only if it is installed and the launched
// environment supports it (the host rejects it otherwise).
export function canAddVisualStudioBackend(session, launchPayload) {
    const stackMode = session?.runningSelection?.stackMode ??
        launchPayload?.selection?.stackMode ?? session?.initialSelection?.stackMode;
    return session?.choices?.visualStudioAvailable !== false &&
        stackModeSupportsVisualStudio(session?.choices?.stackModes, stackMode);
}

export async function run(args = process.argv.slice(2)) {
    const parsed = parseCliArgs(args);
    if (parsed.help) {
        process.stdout.write(
            'Usage: cc-portals-tui [--config] [--verbose] [--host <portal-launcher-host.mjs>] [-- launcher flags]\n' +
                '       cc-portals-tui --update\n\n' +
                '       cc-portals-tui --forget-session [--host <path>]\n\n' +
                'Reconnects to this workspace\'s detached TUI session when available.\n' +
                'Run inside a carecontinuity.app checkout; the launcher host is found automatically.\n',
        );
        return 0;
    }
    if (parsed.update) {
        const result = await runSelfUpdate({
            currentVersion: PACKAGE_VERSION,
            log: (message) => process.stdout.write(`[cc-portals-tui] ${message}\n`),
        });
        if (!result.success) {
            process.stderr.write(`[cc-portals-tui] Update failed: ${result.message}\n`);
            return 1;
        }
        return 0;
    }
    if (parsed.protocolInfo) {
        process.stdout.write(
            `${JSON.stringify({
                name: CLIENT_NAME,
                version: PACKAGE_VERSION,
                protocol: PROTOCOL,
                supportedVersions: [PROTOCOL_VERSION],
                performance: { headless: true },
            })}\n`,
        );
        return 0;
    }

    const hostPath = parsed.hostPath ? path.resolve(parsed.hostPath) : findLauncherHost();
    if (!hostPath) {
        process.stderr.write(
            `Could not find ${HOST_RELATIVE_PATH}. Run cc-portals-tui inside a carecontinuity.app checkout, or pass --host <path>.\n`,
        );
        return 2;
    }
    if (parsed.forgetSession) {
        await forgetStoredLauncherSession({ hostPath });
        process.stdout.write('Forgot the TUI connection only. Any surviving processes must be stopped separately before launching again.\n');
        return 0;
    }
    if (
        parsed.performanceSteadyMs == null &&
        (!process.stdin.isTTY || !process.stdout.isTTY)
    ) {
        process.stderr.write('cc-portals-tui requires an interactive terminal.\n');
        return 2;
    }

    let client;
    let storedSession;
    let detachRequested = false;
    const shutdown = (cause, reason) => {
        if (client) void client.shutdown(cause, reason).catch((error) => {
            process.stderr.write(`Unable to stop launcher: ${sanitizeMessage(error.message)}\n`);
            client.close();
        });
    };
    const handleInterrupt = () => {
        shutdown('interrupt', 'SIGINT');
    };
    const handleTerminate = () => {
        shutdown('terminate', 'SIGTERM');
    };
    process.once('SIGINT', handleInterrupt);
    process.once('SIGTERM', handleTerminate);

    try {
        const connectionOptions = {
            hostPath,
            hostArgs: parsed.hostArgs,
            // The host lives in Portals/scripts and expects to run from the Portals workspace.
            cwd: process.env.PORTALS_ROOT || path.dirname(path.dirname(hostPath)),
            clientInfo: { name: CLIENT_NAME, version: PACKAGE_VERSION },
        };
        if (parsed.performanceSteadyMs == null) {
            storedSession = await connectToStoredLauncherSession(connectionOptions);
            client = storedSession.client;
        } else {
            client = await connectToLauncherHost(connectionOptions);
        }
        const session = client.session;
        if (session.running && parsed.hostArgs.length) {
            process.stdout.write('Reconnected to the existing session; startup flags do not reconfigure a running session.\n');
        }
        let launchPayload = { source: 'saved' };

        if (!session.running && session.configurationRequired) {
            const selectedConfig = await runPortalConfigTui({
                config: session.savedConfig,
                defaultBackendModules: session.initialSelection?.backendModules ?? [],
                portalChoices: session.choices?.portals ?? [],
                backendChoices: session.choices?.backendModules ?? [],
                stackModeChoices: session.choices?.stackModes ?? [],
                backendRunModeChoices: session.choices?.backendRunModes ?? [],
                existingServerChoices: session.choices?.existingServerModes ?? [],
            });

            if (!selectedConfig) {
                return await client.shutdown('cancel', 'configuration cancelled');
            }
            launchPayload = {
                source: 'selection',
                selection: toLauncherSelection(selectedConfig),
            };
        }

        // A recovered running session was already launched, so its prerequisites are not re-checked.
        if (!session.running && !await prepareTuiLaunch(client, launchPayload, {
            interactive: parsed.performanceSteadyMs == null && Boolean(process.stdin.isTTY && process.stdout.isTTY),
        })) {
            return await client.shutdown('cancel', 'prerequisite setup cancelled');
        }

        let performanceTimer;
        let stopPerformanceListener;
        if (parsed.performanceSteadyMs != null) {
            stopPerformanceListener = client.onState((snapshot) => {
                writePerformanceState(process.env.PORTALS_PERFORMANCE_STATE_PATH, snapshot);
                if (performanceTimer || !isReadySnapshot(snapshot)) return;
                performanceTimer = setTimeout(
                    () => void client.shutdown('quit', 'performance measurement complete'),
                    parsed.performanceSteadyMs,
                );
            });
        }
        const terminal =
            parsed.performanceSteadyMs == null ? {} : createPerformanceTerminal();
        try {
            return await runPortalDashboard({
                launchOptions: {
                    targets: [],
                    logPath: session.logPath,
                    backendChoices: session.choices?.backendModules ?? [],
                    canAddBackend: client.hello?.capabilities?.commands?.includes('backend.add') ?? false,
                    canUseVisualStudio: canAddVisualStudioBackend(session, launchPayload),
                    canDetach: storedSession?.persistent === true,
                    onDetach: () => { detachRequested = true; },
                },
                launchPortals: createDashboardLauncherAdapter(client, launchPayload),
                ...terminal,
            });
        } finally {
            clearTimeout(performanceTimer);
            stopPerformanceListener?.();
        }
    } catch (error) {
        process.stderr.write(`Portal TUI failed: ${sanitizeMessage(error?.message)}\n`);
        client?.close();
        return 1;
    } finally {
        process.removeListener('SIGINT', handleInterrupt);
        process.removeListener('SIGTERM', handleTerminate);
        client?.close();
        if (storedSession && client?.sessionEnded) await storedSession.clear();
        if (detachRequested) process.stdout.write('Detached. Portals are still running; run cc-portals-tui again to reconnect.\n');
        else if (storedSession?.persistent && client && !client.sessionEnded) {
            process.stderr.write('Launcher connection closed without confirmed shutdown. Run cc-portals-tui again to recover; no replacement session will be launched.\n');
        }
    }
}

export function createPerformanceTerminal() {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    stdout.isTTY = true;
    stdout.columns = 120;
    stdout.rows = 30;
    const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    return { stdin, stdout, stderr };
}

function sanitizeMessage(value) {
    return String(value ?? 'Unknown error')
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, 500);
}
