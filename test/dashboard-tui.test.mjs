import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import {
    getDashboardLayoutMode,
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
    expect(getDashboardLayoutMode(39, 20)).toBe('too-small');
    expect(getDashboardLayoutMode(80, 7)).toBe('too-small');
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
