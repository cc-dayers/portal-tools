import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import {
    getDashboardLayoutMode,
    getDashboardRowBudget,
    getVisibleLogRows,
    getVisibleTargetWindow,
    runPortalDashboard,
} from '../src/dashboard-tui.mjs';


test('dashboard layout keeps a short standard-width terminal usable', () => {
    expect(getDashboardLayoutMode(116, 17)).toBe('compact');
    expect(getDashboardLayoutMode(80, 24)).toBe('compact');
    expect(getDashboardLayoutMode(120, 30)).toBe('full');
});

test('dashboard layout degrades to status-only before showing the size fallback', () => {
    expect(getDashboardLayoutMode(60, 12)).toBe('minimal');
    expect(getDashboardLayoutMode(29, 20)).toBe('too-small');
    expect(getDashboardLayoutMode(80, 7)).toBe('too-small');
});

test('dashboard width floor matches the config wizard so handoff never hits too-small', () => {
    // getConfigLayoutMode (config-tui.mjs) supports width>=30 with height>=14.
    // The wizard hands off straight into this dashboard, so a terminal that
    // was fine for the wizard must not become "too small" here.
    expect(getDashboardLayoutMode(30, 14)).not.toBe('too-small');
    expect(getDashboardLayoutMode(33, 27)).not.toBe('too-small');
});

test('minimal tier gets a real scrolling log budget, not a fixed single line', () => {
    // This is the bug: the old getVisibleLogRows returned a hardcoded 1 for
    // anything narrower than 72 columns, so a tall-but-narrow terminal could
    // never show more than a placeholder no matter how much vertical room
    // it had.
    expect(getVisibleLogRows(13, 'minimal')).toBeGreaterThan(1);
    expect(getVisibleLogRows(28, 'minimal')).toBeGreaterThan(getVisibleLogRows(13, 'minimal'));
    expect(getVisibleLogRows(20, 'compact')).toBe(getVisibleLogRows(20, 'minimal'));
});

test('minimal tier leaves room for the stacked action rows below the target list', () => {
    expect(getDashboardRowBudget(13, 'minimal')).toBeGreaterThan(0);
    expect(getDashboardRowBudget(28, 'minimal')).toBeGreaterThan(getDashboardRowBudget(13, 'minimal'));
});

test('target window keeps the selected target visible', () => {
    const targets = Array.from({ length: 12 }, (_, index) => ({ id: `target-${index}` }));

    expect(getVisibleTargetWindow(targets, 0, 5)).toEqual({
        items: targets.slice(0, 5),
        start: 0,
    });
    expect(getVisibleTargetWindow(targets, 8, 5)).toEqual({
        items: targets.slice(6, 11),
        start: 6,
    });
    expect(getVisibleTargetWindow(targets, 11, 5)).toEqual({
        items: targets.slice(7, 12),
        start: 7,
    });
});

test('dashboard owns launcher output and coordinates shutdown through the controller', async () => {
    const stdin = createInput();
    const stdout = createOutput();
    let renderedOutput = '';
    stdout.on('data', (chunk) => {
        renderedOutput += chunk.toString();
    });
    let resolveLauncher;
    const stopAll = vi.fn(() => {
        resolveLauncher(0);
    });
    const controller = {
        getSnapshot: () => createSnapshot(),
        restart: vi.fn(),
        stop: vi.fn(),
        start: vi.fn(),
        open: vi.fn(),
        restartAll: vi.fn(),
        stopAll,
    };
    const launchPortals = vi.fn(
        (options) =>
            new Promise((resolve) => {
                resolveLauncher = resolve;
                options.onControllerReady(controller);
                options.onStateChange(createSnapshot());
                options.onLog({
                    targetId: 'sso-local',
                    targetLabel: 'SSO',
                    source: 'stdout',
                    line: 'ready',
                    timestamp: 1,
                });
            }),
    );

    const dashboardPromise = runPortalDashboard({
        launchOptions: { targets: createSnapshot().targets, logPath: 'scripts/logs/portals.log' },
        launchPortals,
        stdin,
        stdout,
        stderr: stdout,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let index = 0; index < 2_000; index += 1) {
        stdout.columns = 72 + (index % 40);
        stdout.rows = 18 + (index % 20);
        stdout.emit('resize');
    }
    stdin.write('q');
    const exitCode = await dashboardPromise;

    expect(exitCode).toBe(0);
    expect(renderedOutput).toContain('CareContinuity Portals');
    expect(renderedOutput).not.toContain('Terminal too small');
    expect(launchPortals).toHaveBeenCalledWith(
        expect.objectContaining({
            uiMode: 'external',
            verbose: false,
            debug: false,
        }),
    );
    expect(stopAll).toHaveBeenCalledWith('q');
});


test('logs tab renders real log lines on a narrow terminal instead of a static placeholder', async () => {
    const stdin = createInput();
    const stdout = createOutput();
    stdout.columns = 40;
    stdout.rows = 21; // -1 adjustment inside useTerminalSize makes this height 20 (minimal tier)
    let renderedOutput = '';
    stdout.on('data', (chunk) => {
        renderedOutput += chunk.toString();
    });

    const launchPortals = vi.fn(
        (options) =>
            new Promise((resolve) => {
                options.onControllerReady({
                    getSnapshot: () => createSnapshot(),
                    restart: vi.fn(),
                    stop: vi.fn(),
                    start: vi.fn(),
                    open: vi.fn(),
                    restartAll: vi.fn(),
                    stopAll: vi.fn(() => resolve(0)),
                });
                options.onStateChange(createSnapshot());
                options.onLog({
                    targetId: 'sso-local',
                    targetLabel: 'SSO',
                    source: 'stdout',
                    line: 'listening on http://localhost:3000',
                    timestamp: 1,
                });
            }),
    );

    const dashboardPromise = runPortalDashboard({
        launchOptions: { targets: createSnapshot().targets, logPath: 'scripts/logs/portals.log' },
        launchPortals,
        stdin,
        stdout,
        stderr: stdout,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write('2'); // switch to the Logs tab
    await new Promise((resolve) => setTimeout(resolve, 150));
    stdin.write('q');
    await dashboardPromise;

    expect(renderedOutput).toContain('SSO');
    expect(renderedOutput).toContain('listening on http');
    expect(renderedOutput).not.toContain('Logs continue in the background');
    expect(renderedOutput).not.toContain('resize for the live viewer');
});

test('minimal-tier action rows use a plain divider, not a boxed panel', async () => {
    // Regression test: MinimalDashboardActions's outer Box set borderTop:
    // true and borderStyle: 'single' without disabling the other three
    // sides, so Ink drew a full box around the actions instead of a plain
    // top divider — this is what made the action area look cramped and
    // out of place at narrow widths.
    const stdin = createInput();
    const stdout = createOutput();
    stdout.columns = 46;
    stdout.rows = 22;
    let renderedOutput = '';
    stdout.on('data', (chunk) => {
        renderedOutput += chunk.toString();
    });

    let resolveLauncher;
    const launchPortals = vi.fn(
        (options) =>
            new Promise((resolve) => {
                resolveLauncher = resolve;
                options.onControllerReady({
                    getSnapshot: () => createSnapshot(),
                    restart: vi.fn(),
                    stop: vi.fn(),
                    start: vi.fn(),
                    open: vi.fn(),
                    restartAll: vi.fn(),
                    stopAll: vi.fn(() => resolveLauncher(0)),
                });
                options.onStateChange(createSnapshot());
            }),
    );

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

    const clean = renderedOutput.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
    const frame = clean.split('\u001b[?1049l')[0] || clean;
    const lines = frame.split('\n');

    // No line should overflow the terminal width.
    lines.forEach((line) => {
        expect(line.length).toBeLessThanOrEqual(46);
    });

    // The action area should render as a plain divider (no box-drawing
    // corner/side characters around the Stop/Restart/Open row).
    const actionLines = lines.filter((line) => line.includes('Restart All'));
    expect(actionLines.length).toBeGreaterThan(0);
    actionLines.forEach((line) => {
        expect(line).not.toMatch(/[┌┐└┘│]/);
    });
});

function createInput() {
    const stream = new PassThrough();
    stream.isTTY = true;
    stream.setRawMode = () => stream;
    stream.ref = () => stream;
    stream.unref = () => stream;
    return stream;
}

function createOutput() {
    const stream = new PassThrough();
    stream.isTTY = true;
    stream.columns = 116;
    stream.rows = 18;
    return stream;
}

function createSnapshot() {
    return {
        targets: [
            {
                id: 'sso-local',
                label: 'SSO',
                kind: 'frontend',
                url: 'http://localhost:3000/sso',
                status: 'ready',
                startedAt: 0,
                readyAt: 100,
                failedAt: null,
                endedAt: null,
                failureReason: '',
                readySignal: 'test',
                lastRebuildDurationMs: null,
                adopted: false,
            },
        ],
        isShuttingDown: false,
        shutdownReason: '',
        logPath: 'scripts/logs/portals.log',
    };
}
