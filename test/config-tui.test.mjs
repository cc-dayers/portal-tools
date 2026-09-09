import { expect, test } from 'vitest';

import {
    createInitialTuiDraft,
    getConfigLayoutMode,
    getFullChoiceListBudget,
    getNarrowLayoutPlan,
    shouldSpaceChoiceList,
    toLauncherConfig,
} from '../src/config-tui.mjs';

test('configuration layout uses compact mode for a short standard-width terminal', () => {
    expect(getConfigLayoutMode(116, 17)).toBe('compact');
    expect(getConfigLayoutMode(80, 24)).toBe('compact');
    expect(getConfigLayoutMode(120, 30)).toBe('full');
});

test('configuration layout uses a stacked narrow layout for tall, narrow terminals', () => {
    expect(getConfigLayoutMode(60, 14)).toBe('narrow');
    expect(getConfigLayoutMode(47, 20)).toBe('narrow');
    expect(getConfigLayoutMode(40, 28)).toBe('narrow');
});

test('configuration layout reserves the fallback for genuinely small terminals', () => {
    expect(getConfigLayoutMode(29, 30)).toBe('too-small');
    expect(getConfigLayoutMode(60, 13)).toBe('too-small');
    expect(getConfigLayoutMode(80, 11)).toBe('too-small');
});

test('shouldSpaceChoiceList only spaces items out when the budget truly has room', () => {
    expect(shouldSpaceChoiceList(6, 11)).toBe(true);
    expect(shouldSpaceChoiceList(6, 10)).toBe(false);
    expect(shouldSpaceChoiceList(0, 0)).toBe(true);
});

test('the full layout only spaces choices out once there is real headroom, never by shrinking to fit', () => {
    // At the full-mode floor (height 26) there isn't room for 6 spaced
    // portal choices (11 rows) once fixed chrome is subtracted, so the list
    // must render tight instead of asking the terminal to compress rows
    // (which is what previously caused items to randomly cram together).
    expect(shouldSpaceChoiceList(6, getFullChoiceListBudget(26))).toBe(false);
    // With plenty of extra height, spacing is safe.
    expect(shouldSpaceChoiceList(6, getFullChoiceListBudget(40))).toBe(true);
});

test('narrow layout shows the full section menu and spaced choices when there is ample height', () => {
    expect(getNarrowLayoutPlan(28, 8, 6)).toEqual({
        showSectionMenu: true,
        menuRows: 8,
        spacious: true,
        showDescription: true,
    });
});

test('narrow layout collapses the section menu and tightens choices at its minimum height', () => {
    const plan = getNarrowLayoutPlan(14, 8, 6);
    expect(plan.showSectionMenu).toBe(false);
    expect(plan.menuRows).toBe(1);
    expect(plan.spacious).toBe(false);
    expect(plan.showDescription).toBe(false);
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
