import { expect, test } from 'vitest';

import { parseCliArgs, toLauncherSelection } from '../src/cli.mjs';

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
        hostPath: 'C:/repo/Portals/scripts/portal-launcher-host.mjs',
        hostArgs: ['--config', '--verbose'],
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
            environment: 'local',
            backendModules: ['api'],
            buildMode: 'preview',
            existingServerMode: 'auto-restart',
            verbose: false,
            autoOpen: true,
        }),
    ).toEqual({
        portals: ['provider'],
        stackMode: 'local-full',
        backendModules: ['api'],
        buildMode: 'preview',
        existingServerMode: 'auto-restart',
        verbose: false,
        autoOpen: true,
    });
});
