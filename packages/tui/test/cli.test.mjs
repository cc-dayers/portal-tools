import { expect, test } from 'vitest';

import {
    createPerformanceTerminal,
    isReadySnapshot,
    parseCliArgs,
    toLauncherSelection,
    writePerformanceState,
} from '../src/cli.mjs';

test('parseCliArgs separates the host script from forwarded launcher flags', () => {
    expect(
        parseCliArgs([
            '--host',
            'C:/repo/Portals/scripts/portal-launcher-host.mjs',
            '--',
            '--config',
            '--verbose',
        ]),
    ).toEqual({
        protocolInfo: false,
        help: false,
        update: false,
        performanceSteadyMs: null,
        hostPath: 'C:/repo/Portals/scripts/portal-launcher-host.mjs',
        hostArgs: ['--config', '--verbose'],
    });
});

test('parseCliArgs accepts the internal performance steady-state duration', () => {
    expect(parseCliArgs(['--performance-steady-ms', '1500'])).toMatchObject({
        performanceSteadyMs: 1500,
    });
    expect(() => parseCliArgs(['--performance-steady-ms', '-1'])).toThrow(
        '--performance-steady-ms requires a nonnegative integer',
    );
});

test('performance readiness requires every target to be ready', () => {
    expect(isReadySnapshot({ targets: [{ status: 'ready' }, { status: 'starting' }] })).toBe(
        false,
    );
    expect(isReadySnapshot({ targets: [{ status: 'ready' }, { status: 'ready' }] })).toBe(true);
    expect(isReadySnapshot({ targets: [] })).toBe(false);
});

test('performance terminal implements the TTY controls Ink requires', () => {
    const terminal = createPerformanceTerminal();
    expect(terminal.stdin.isTTY).toBe(true);
    expect(terminal.stdin.ref()).toBe(terminal.stdin);
    expect(terminal.stdin.unref()).toBe(terminal.stdin);
    expect(terminal.stdin.setRawMode(true)).toBe(terminal.stdin);
});

test('performance state output contains lifecycle fields without launcher paths', () => {
    let written;
    writePerformanceState(
        'state.ndjson',
        {
            logPath: 'C:/private/portals.log',
            targets: [
                {
                    id: 'sso-local',
                    status: 'ready',
                    startedAt: 100,
                    readyAt: 200,
                    readySignal: 'Vite ready',
                    command: 'secret command',
                },
            ],
        },
        (_path, value) => {
            written = JSON.parse(value);
        },
    );

    expect(written).toEqual({
        targets: [
            {
                id: 'sso-local',
                status: 'ready',
                startedAt: 100,
                readyAt: 200,
                readySignal: 'Vite ready',
                adopted: false,
                failureReason: null,
            },
        ],
    });
});

test('parseCliArgs recognizes help, protocol preflight, and update modes', () => {
    expect(parseCliArgs(['--help'])).toMatchObject({ help: true });
    expect(parseCliArgs(['--protocol-info'])).toMatchObject({ protocolInfo: true });
    expect(parseCliArgs(['--update'])).toMatchObject({ update: true });
});

test('toLauncherSelection restores the wizard stack mode', () => {
    expect(
        toLauncherSelection({
            portals: ['provider'],
            stackMode: 'fullstack-dev-db',
            backendRunMode: 'mixed',
            backendModules: ['api'],
            visualStudioModules: ['api'],
            backendWatchModules: [],
            buildMode: 'preview',
            existingServerMode: 'auto-restart',
            verbose: false,
            autoOpen: true,
        }),
    ).toEqual({
        portals: ['provider'],
        stackMode: 'fullstack-dev-db',
        backendRunMode: 'mixed',
        backendModules: ['api'],
        visualStudioModules: ['api'],
        backendWatchModules: [],
        buildMode: 'preview',
        existingServerMode: 'auto-restart',
        verbose: false,
        autoOpen: true,
    });
});
