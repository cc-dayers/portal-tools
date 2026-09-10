// Real-render regression coverage for both TUIs across a matrix of
// terminal sizes.
//
// This exists because unit tests on the pure layout-math functions
// (getConfigLayoutMode, getDashboardLayoutMode, etc.) were NOT enough to
// catch two real bugs that shipped: the dashboard's width floor (40) was
// out of sync with the wizard's (30), so handing off from a working wizard
// into the dashboard could immediately hit "Terminal too small"; and a
// component's `borderStyle` implicitly enabled all four sides, drawing a
// box where only a plain top divider was intended. Both were only visible
// by actually rendering the UI.
//
// Two kinds of assertions per size:
//   1. Hard invariants that must ALWAYS hold (no line overflows the
//      terminal width; a size that a lower tier's floor already declared
//      usable must not be rejected as "too small").
//   2. A snapshot of the full rendered frame, so an unintentional visual
//      change (spacing, an unexpected border, a resurrected placeholder)
//      shows up as a diff in review instead of silently shipping. Run
//      `corepack yarn test -u` to intentionally accept a layout change.
import { expect, test } from 'vitest';

import { runPortalConfigTui } from '../src/config-tui.mjs';
import { runPortalDashboard } from '../src/dashboard-tui.mjs';
import { cleanFrames, findOverflowingLines, makeFakeStdin, makeFakeStdout } from '../dev/render-frame.mjs';

const PORTAL_CHOICES = ['SSO', 'Provider', 'Coordinator', 'Admin', 'Reports', 'Patient'].map((name) => ({
    label: name,
    value: name.toLowerCase(),
    color: 'white',
}));

const EXISTING_SERVER_CHOICES = [
    { label: 'Kill before start', value: 'kill-before-start' },
    { label: 'Auto kill and restart on failure', value: 'auto-restart' },
    { label: 'None', value: 'none' },
];

function createSnapshot() {
    return {
        targets: PORTAL_CHOICES.map((choice, index) => ({
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

async function renderConfig(columns, rows) {
    const stdin = makeFakeStdin();
    const { stream: stdout, getBuffer } = makeFakeStdout(columns, rows);

    const configPromise = runPortalConfigTui({
        config: { portals: ['sso', 'provider'], environment: 'dev-api', buildMode: 'dev', existingServerMode: 'auto-restart' },
        defaultBackendModules: [],
        portalChoices: PORTAL_CHOICES,
        backendChoices: [],
        existingServerChoices: EXISTING_SERVER_CHOICES,
        stdin,
        stdout,
        stderr: stdout,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.write('q');
    await configPromise;

    return cleanFrames(getBuffer());
}

async function renderDashboard(columns, rows) {
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

// Sizes here are stdout.rows/columns as a real terminal reports them.
// useTerminalSize() applies height: stdout.rows - 1, so the app's OWN
// displayed size (what a user sees on screen, and what they'd report in a
// bug) is one row shorter than stdout.rows. A screenshot showing "33×28"
// was produced by stdout.rows === 29.
const CONFIG_SIZES = [
    [30, 15], // narrow tier floor (internal height 14)
    [33, 29], // reported real-world pane size (internal 33x28)
    [46, 22],
    [100, 27], // full tier floor
];

const DASHBOARD_SIZES = [
    [30, 9], // minimal tier floor (matches too-small width boundary)
    [30, 15],
    [33, 29], // must match the config wizard's floor — this is the handoff bug
    [46, 22],
];

for (const [columns, rows] of CONFIG_SIZES) {
    test(`config wizard at ${columns}x${rows}: no line overflows the terminal width`, async () => {
        const frame = await renderConfig(columns, rows);
        const overflow = findOverflowingLines(frame, columns);
        expect(overflow).toEqual([]);
    });

    test(`config wizard at ${columns}x${rows} renders as expected`, async () => {
        const frame = await renderConfig(columns, rows);
        expect(frame).toMatchSnapshot();
    });
}

for (const [columns, rows] of DASHBOARD_SIZES) {
    test(`dashboard at ${columns}x${rows}: no line overflows the terminal width`, async () => {
        const frame = await renderDashboard(columns, rows);
        const overflow = findOverflowingLines(frame, columns);
        expect(overflow).toEqual([]);
    });

    test(`dashboard at ${columns}x${rows} renders as expected`, async () => {
        const frame = await renderDashboard(columns, rows);
        expect(frame).toMatchSnapshot();
    });
}

test('a size usable by the config wizard is never rejected as too-small by the dashboard', async () => {
    // This is the exact regression from the bug report: the wizard's own
    // floor is width>=30 with height>=14, so anything the wizard accepts
    // must not immediately dead-end into "Terminal too small" once the
    // dashboard takes over after launch. stdout.rows=29 -> internal
    // height 28, matching the user's reported "33x28".
    const frame = await renderDashboard(33, 29);
    expect(frame).not.toContain('Terminal too small');
});
