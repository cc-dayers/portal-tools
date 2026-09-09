#!/usr/bin/env node

import process from 'node:process';

import { runPortalConfigTui } from './config-tui.mjs';
import { runPortalDashboard } from './dashboard-tui.mjs';
import {
    PROTOCOL,
    PROTOCOL_VERSION,
    connectToLauncherHost,
    createDashboardLauncherAdapter,
} from './protocol-client.mjs';

const PACKAGE_VERSION = '0.1.3';

export function parseCliArgs(args) {
    const hostIndex = args.indexOf('--host');
    const separatorIndex = args.indexOf('--');
    return {
        protocolInfo: args.includes('--protocol-info'),
        help: args.includes('--help') || args.includes('-h'),
        hostPath: hostIndex >= 0 ? args[hostIndex + 1] ?? '' : '',
        hostArgs: separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [],
    };
}

export function toLauncherSelection(config) {
    const backendModules = Array.isArray(config?.backendModules) ? config.backendModules : [];
    return {
        portals: Array.isArray(config?.portals) ? config.portals : [],
        stackMode:
            config?.environment === 'dev-api'
                ? 'dev-api'
                : backendModules.length > 0
                  ? 'local-full'
                  : 'local-frontend',
        backendModules,
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
            'Usage: cc-portals-tui --host <portal-launcher-host.mjs> -- [launcher flags]\n',
        );
        return 0;
    }
    if (parsed.protocolInfo) {
        process.stdout.write(
            `${JSON.stringify({
                name: 'cc-portals-tui',
                version: PACKAGE_VERSION,
                protocol: PROTOCOL,
                supportedVersions: [PROTOCOL_VERSION],
            })}\n`,
        );
        return 0;
    }

    if (!parsed.hostPath) {
        process.stderr.write('Missing required --host <portal-launcher-host.mjs>.\n');
        return 2;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
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

        return await runPortalDashboard({
            launchOptions: {
                targets: [],
                logPath: session.logPath,
            },
            launchPortals: createDashboardLauncherAdapter(client, launchPayload),
        });
    } catch (error) {
        process.stderr.write(`Portal TUI failed: ${sanitizeMessage(error?.message)}\n`);
        client?.close();
        return 1;
    } finally {
        process.removeListener('SIGINT', handleInterrupt);
        process.removeListener('SIGTERM', handleTerminate);
    }
}

function sanitizeMessage(value) {
    return String(value ?? 'Unknown error')
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, 500);
}
