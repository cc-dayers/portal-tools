import { expect, test } from 'vitest';

import {
    createInitialTuiDraft,
    getConfigLayoutMode,
    toLauncherConfig,
} from '../src/config-tui.mjs';

test('configuration layout uses compact mode for a short standard-width terminal', () => {
    expect(getConfigLayoutMode(116, 17)).toBe('compact');
    expect(getConfigLayoutMode(80, 24)).toBe('compact');
    expect(getConfigLayoutMode(120, 30)).toBe('full');
});

test('configuration layout reserves the fallback for genuinely small terminals', () => {
    expect(getConfigLayoutMode(60, 12)).toBe('minimal');
    expect(getConfigLayoutMode(47, 20)).toBe('too-small');
    expect(getConfigLayoutMode(80, 11)).toBe('too-small');
});

test('createInitialTuiDraft provides useful first-run defaults', () => {
    expect(createInitialTuiDraft({}, ['api', 'auth'])).toEqual({
        portals: ['sso', 'provider'],
        stackMode: 'local-full',
        backendModules: ['api', 'auth'],
        buildMode: 'dev',
        existingServerMode: 'auto-restart',
        verbose: false,
        autoOpen: true,
    });
});

test('createInitialTuiDraft restores a saved dev API configuration', () => {
    expect(
        createInitialTuiDraft({
            portals: ['sso', 'coordinator'],
            environment: 'dev-api',
            backendModules: ['api'],
            buildMode: 'preview',
            existingServerMode: 'kill-before-start',
            verbose: true,
            autoOpen: false,
        }),
    ).toMatchObject({
        portals: ['sso', 'coordinator'],
        stackMode: 'dev-api',
        backendModules: ['api'],
        buildMode: 'preview',
        existingServerMode: 'kill-before-start',
        verbose: true,
        autoOpen: false,
    });
});

test('toLauncherConfig removes backend modules outside local full-stack mode', () => {
    const config = toLauncherConfig({
        portals: ['sso'],
        stackMode: 'dev-api',
        backendModules: ['api', 'auth'],
        buildMode: 'dev',
        existingServerMode: 'auto-restart',
        verbose: false,
        autoOpen: true,
    });

    expect(config.environment).toBe('dev-api');
    expect(config.backendModules).toEqual([]);
});

test('toLauncherConfig preserves selected local backend modules', () => {
    const config = toLauncherConfig({
        portals: ['sso', 'provider'],
        stackMode: 'local-full',
        backendModules: ['api', 'patients'],
        buildMode: 'preview',
        existingServerMode: 'none',
        verbose: true,
        autoOpen: false,
    });

    expect(config).toEqual({
        portals: ['sso', 'provider'],
        environment: 'local',
        backendModules: ['api', 'patients'],
        buildMode: 'preview',
        existingServerMode: 'none',
        verbose: true,
        autoOpen: false,
    });
});
