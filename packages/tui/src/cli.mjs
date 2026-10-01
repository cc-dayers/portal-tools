#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import { PassThrough, Writable } from 'node:stream';

import { runPortalConfigTui } from './config-tui.mjs';
import { runPortalDashboard } from './dashboard-tui.mjs';
import { PROTOCOL, PROTOCOL_VERSION, connectToLauncherHost } from '@cc-dayers/portal-protocol';

import { createDashboardLauncherAdapter } from './dashboard-adapter.mjs';
import { runSelfUpdate } from './self-update.mjs';

const PACKAGE_VERSION = '0.1.13';

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
        performanceSteadyMs: performanceValue,
        hostPath: hostIndex >= 0 ? args[hostIndex + 1] ?? '' : '',
        hostArgs: separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [],
    };
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

export async function run(args = process.argv.slice(2)) {
    const parsed = parseCliArgs(args);
    if (parsed.help) {
        process.stdout.write(
            'Usage: cc-portals-tui --host <portal-launcher-host.mjs> -- [launcher flags]\n' +
                '       cc-portals-tui --update\n',
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
                name: 'cc-portals-tui',
                version: PACKAGE_VERSION,
                protocol: PROTOCOL,
                supportedVersions: [PROTOCOL_VERSION],
                performance: { headless: true },
            })}\n`,
        );
        return 0;
    }

    if (!parsed.hostPath) {
        process.stderr.write('Missing required --host <portal-launcher-host.mjs>.\n');
        return 2;
    }
    if (
        parsed.performanceSteadyMs == null &&
        (!process.stdin.isTTY || !process.stdout.isTTY)
    ) {
        process.stderr.write('cc-portals-tui requires an interactive terminal.\n');
        return 2;
    }

    let client;
    const handleInterrupt = () => {
        if (client) void client.shutdown('interrupt', 'SIGINT');
    };
    const handleTerminate = () => {
        if (client) void client.shutdown('terminate', 'SIGTERM');
    };
    process.once('SIGINT', handleInterrupt);
    process.once('SIGTERM', handleTerminate);

    try {
        client = await connectToLauncherHost({
            hostPath: parsed.hostPath,
            hostArgs: parsed.hostArgs,
            cwd: process.env.PORTALS_ROOT || process.cwd(),
        });
        const session = client.session;
        let launchPayload = { source: 'saved' };

        if (session.configurationRequired) {
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
