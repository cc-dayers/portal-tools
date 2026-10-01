#!/usr/bin/env node
// On-demand visual inspection of the config wizard and dashboard at
// specific terminal sizes, without needing an actual terminal that size.
//
// This is the permanent replacement for the throwaway ".manual-check.mjs"
// scripts that kept getting written and deleted during development —
// keep using THIS one, extend its SIZES list when investigating a new
// report, and let test/layout-snapshots.test.mjs catch regressions
// automatically afterward instead of relying on someone remembering to
// re-run this by hand.
//
// Usage:
//   node dev/visualize.mjs                    # runs the default size matrix
//   node dev/visualize.mjs config 33 28       # one config-wizard frame
//   node dev/visualize.mjs dashboard 46 22    # one dashboard frame
//
// Width/height here are what a real terminal pane reports (stdout.columns /
// stdout.rows) — NOT the internal terminal.width/height the components use
// (useTerminalSize applies a -1 row adjustment; see runtime-policy notes in
// config-tui.mjs / dashboard-tui.mjs).

import { runPortalConfigTui } from '../src/config-tui.mjs';
import { runPortalDashboard } from '../src/dashboard-tui.mjs';
import { cleanFrames, findOverflowingLines, makeFakeStdin, makeFakeStdout } from './render-frame.mjs';

const DEFAULT_PORTAL_CHOICES = ['SSO', 'Provider', 'Coordinator', 'Admin', 'Reports', 'Patient'].map((name) => ({
    label: name,
    value: name.toLowerCase(),
    color: 'white',
}));

function createSnapshot() {
    return {
        targets: DEFAULT_PORTAL_CHOICES.map((choice, index) => ({
            id: choice.value,
            label: choice.label,
            color: choice.color,
            kind: 'portal',
            url: `http://localhost:${3000 + index}`,
            status: 'ready',
        })),
        isShuttingDown: false,
        shutdownReason: '',
        logPath: 'scripts/logs/portals.log',
    };
}

async function visualizeConfig(columns, rows) {
    const stdin = makeFakeStdin();
    const { stream: stdout, getBuffer } = makeFakeStdout(columns, rows);

    const configPromise = runPortalConfigTui({
        config: { portals: ['sso', 'provider'], environment: 'dev-api', buildMode: 'dev', existingServerMode: 'auto-restart' },
        defaultBackendModules: [],
        portalChoices: DEFAULT_PORTAL_CHOICES,
        backendChoices: [],
        existingServerChoices: [
            { label: 'Kill before start', value: 'kill-before-start' },
            { label: 'Auto kill and restart on failure', value: 'auto-restart' },
            { label: 'None', value: 'none' },
        ],
        stdin,
        stdout,
        stderr: stdout,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write('q');
    await configPromise;

    return cleanFrames(getBuffer());
}

async function visualizeDashboard(columns, rows) {
    const stdin = makeFakeStdin();
    const { stream: stdout, getBuffer } = makeFakeStdout(columns, rows);

    const launchPortals = (options) =>
        new Promise((resolve) => {
            options.onControllerReady({
                getSnapshot: () => createSnapshot(),
                restart: () => true,
                stop: () => true,
                start: () => true,
                open: () => true,
                restartAll: () => true,
                stopAll: () => resolve(0),
            });
            options.onStateChange(createSnapshot());
        });

    const dashboardPromise = runPortalDashboard({
        launchOptions: { targets: createSnapshot().targets, logPath: 'scripts/logs/portals.log' },
        launchPortals,
        stdin,
        stdout,
        stderr: stdout,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write('q');
    await dashboardPromise;

    return cleanFrames(getBuffer());
}

function report(label, columns, rows, frameText) {
    console.log(`\n=== ${label} (${columns}x${rows}) ===`);
    console.log(frameText);

    const overflow = findOverflowingLines(frameText, columns);
    if (overflow.length > 0) {
        console.log(`  \u26a0 ${overflow.length} line(s) exceed width ${columns}:`);
        overflow.slice(0, 5).forEach(({ index, line }) => console.log(`    [${index}] len=${line.length}: ${JSON.stringify(line)}`));
    }
}

const DEFAULT_SIZES = {
    config: [
        [30, 14],
        [33, 28],
        [46, 22],
        [100, 27],
        [120, 40],
    ],
    dashboard: [
        [30, 9],
        [30, 14],
        [33, 28],
        [46, 22],
        [120, 32],
    ],
};

async function main() {
    const [, , view, columnsArg, rowsArg] = process.argv;

    if (view && columnsArg && rowsArg) {
        const columns = Number(columnsArg);
        const rows = Number(rowsArg);
        const frameText = view === 'config' ? await visualizeConfig(columns, rows) : await visualizeDashboard(columns, rows);
        report(view, columns, rows, frameText);
        return;
    }

    for (const [columns, rows] of DEFAULT_SIZES.config) {
        report('config', columns, rows, await visualizeConfig(columns, rows));
    }
    for (const [columns, rows] of DEFAULT_SIZES.dashboard) {
        report('dashboard', columns, rows, await visualizeDashboard(columns, rows));
    }
}

await main();
