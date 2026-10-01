import { describe, expect, test } from 'vitest';

import {
    BUILT_IN_PRESETS,
    applyBackendAddition,
    backendAdditionChoices,
    buildDashboardView,
    buildTargetGroups,
    findPreset,
    isAllowedTargetAction,
    removePreset,
    renamePreset,
    resolvePresetSelection,
    selectionSummary,
    sessionLabel,
    targetActions,
    upsertPreset,
} from '../src/launcher-model.mjs';

const CHOICES = {
    portals: [
        { label: 'SSO', value: 'sso' },
        { label: 'Coordinator', value: 'coordinator' },
    ],
    stackModes: [
        { label: 'Full-stack · local data', value: 'fullstack-local-db' },
        { label: 'Frontend · dev API', value: 'frontend-dev-api' },
    ],
    backendModules: [
        { label: 'API', value: 'api' },
        { label: 'Authentication', value: 'auth' },
        { label: 'Patients', value: 'patients' },
        { label: 'Tasks', value: 'tasks' },
    ],
    visualStudioAvailable: true,
};

const FULL_STACK = {
    portals: ['sso', 'coordinator'],
    stackMode: 'fullstack-local-db',
    backendRunMode: 'background',
    backendModules: ['api', 'patients'],
    visualStudioModules: [],
    backendWatchModules: ['patients'],
    buildMode: 'dev',
};

describe('buildTargetGroups', () => {
    test('groups the real host frontend kind and the mock host portal kind together', () => {
        const groups = buildTargetGroups({
            targets: [
                { id: 'sso-local', label: 'SSO', kind: 'frontend', status: 'ready' },
                { id: 'coordinator', label: 'Coordinator', kind: 'portal', status: 'starting' },
                { id: 'api', label: 'API', kind: 'backend', status: 'starting' },
            ],
        });

        expect(groups.map((group) => [group.id, group.targets.map((target) => target.id)])).toEqual([
            ['frontend', ['sso-local', 'coordinator']],
            ['backend', ['api']],
        ]);
    });

    test('keeps empty groups so the dashboard can still offer the add action', () => {
        const groups = buildTargetGroups({ targets: [{ id: 'sso', kind: 'frontend', status: 'ready' }] });
        expect(groups.map((group) => [group.id, group.targets.length])).toEqual([
            ['frontend', 1],
            ['backend', 0],
        ]);
    });
});

describe('targetActions', () => {
    test.each([
        [{ status: 'ready', openable: true }, ['open', 'restart', 'stop']],
        [{ status: 'ready', openable: false }, ['restart', 'stop']],
        [{ status: 'rebuilding', openable: true }, ['open', 'stop']],
        [{ status: 'starting' }, ['stop']],
        [{ status: 'restarting' }, ['stop']],
        [{ status: 'stopping' }, []],
        [{ status: 'failed' }, ['start', 'logs']],
        [{ status: 'stopped' }, ['start']],
    ])('%o allows %o', (target, actions) => {
        expect(targetActions(target)).toEqual(actions);
    });

    test('offers nothing while the whole session is shutting down', () => {
        expect(targetActions({ status: 'ready', openable: true }, { isShuttingDown: true })).toEqual([]);
    });
});

describe('isAllowedTargetAction', () => {
    const snapshot = { targets: [{ id: 'api', status: 'ready' }, { id: 'sso', status: 'stopped' }] };

    test('accepts an action the target currently offers', () => {
        expect(isAllowedTargetAction(snapshot, 'api', 'restart')).toBe(true);
        expect(isAllowedTargetAction(snapshot, 'sso', 'start')).toBe(true);
    });

    test('rejects unknown targets, unknown actions, and actions the state does not offer', () => {
        expect(isAllowedTargetAction(snapshot, 'missing', 'start')).toBe(false);
        expect(isAllowedTargetAction(snapshot, 'api', 'delete')).toBe(false);
        expect(isAllowedTargetAction(snapshot, 'sso', 'stop')).toBe(false);
        expect(isAllowedTargetAction(null, 'api', 'stop')).toBe(false);
    });
});

describe('selectionSummary', () => {
    test('uses host choice labels and marks watched modules', () => {
        expect(selectionSummary(FULL_STACK, CHOICES)).toBe(
            'SSO, Coordinator · Full-stack · local data · API, Patients (watch)',
        );
    });

    test('marks Visual Studio modules and omits backends for frontend-only launches', () => {
        expect(
            selectionSummary(
                { ...FULL_STACK, backendModules: ['api'], visualStudioModules: ['api'], backendWatchModules: [] },
                CHOICES,
            ),
        ).toBe('SSO, Coordinator · Full-stack · local data · API (VS)');
        expect(selectionSummary({ portals: ['sso'], stackMode: 'frontend-dev-api' }, CHOICES)).toBe(
            'SSO · Frontend · dev API',
        );
    });

    test('falls back to raw values when choices are unavailable', () => {
        expect(selectionSummary({ portals: ['sso'], stackMode: 'frontend-dev-api' }, null)).toBe(
            'sso · frontend-dev-api',
        );
    });
});

describe('presets', () => {
    const now = () => 1000;

    test('upsertPreset adds a trimmed preset and overwrites one with the same name regardless of case', () => {
        const first = upsertPreset([], { name: '  Patients hot reload ', selection: FULL_STACK, summary: 'a' }, now);
        expect(first).toEqual([
            { id: 'patients-hot-reload', name: 'Patients hot reload', selection: FULL_STACK, summary: 'a', savedAt: 1000 },
        ]);

        const second = upsertPreset(first, { name: 'PATIENTS hot reload', selection: FULL_STACK, summary: 'b' }, now);
        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({ id: 'patients-hot-reload', name: 'PATIENTS hot reload', summary: 'b' });
    });

    test('upsertPreset rejects blank names', () => {
        expect(() => upsertPreset([], { name: '   ', selection: FULL_STACK }, now)).toThrow('Enter a preset name.');
    });

    test('upsertPreset stores a copy so later edits to the selection do not leak into the preset', () => {
        const selection = structuredClone(FULL_STACK);
        const [preset] = upsertPreset([], { name: 'Copy', selection, summary: '' }, now);
        selection.portals.push('admin');
        expect(preset.selection.portals).toEqual(['sso', 'coordinator']);
    });

    test('renamePreset changes the name and id and refuses to collide with another preset', () => {
        const presets = [
            { id: 'one', name: 'One', selection: FULL_STACK, summary: '', savedAt: 1 },
            { id: 'two', name: 'Two', selection: FULL_STACK, summary: '', savedAt: 2 },
        ];
        expect(renamePreset(presets, 'one', 'First')[0]).toMatchObject({ id: 'first', name: 'First' });
        expect(() => renamePreset(presets, 'one', 'two')).toThrow('A preset named "two" already exists.');
    });

    test('removePreset drops only the matching preset', () => {
        const presets = [{ id: 'one' }, { id: 'two' }];
        expect(removePreset(presets, 'one')).toEqual([{ id: 'two' }]);
    });
});

describe('built-in presets', () => {
    test('mirror yarn start:all-dev-api, start:core-dev-api, and start:all', () => {
        expect(
            BUILT_IN_PRESETS.map(({ id, selection }) => [id, selection.portals, selection.stackMode, selection.buildMode]),
        ).toEqual([
            ['builtin-all-dev-api', 'all', 'frontend-dev-api', 'dev'],
            ['builtin-core-dev-api', ['sso', 'admin', 'provider', 'coordinator'], 'frontend-dev-api', 'dev'],
            ['builtin-all', 'all', 'frontend-local-api', 'dev'],
        ]);
    });

    test('resolvePresetSelection expands "all" from host choices and drops portals the host does not offer', () => {
        expect(resolvePresetSelection(BUILT_IN_PRESETS[0].selection, CHOICES).portals).toEqual(['sso', 'coordinator']);
        expect(resolvePresetSelection(BUILT_IN_PRESETS[1].selection, CHOICES).portals).toEqual(['sso', 'coordinator']);
    });

    test('resolvePresetSelection leaves ordinary selections unchanged', () => {
        expect(resolvePresetSelection(FULL_STACK, CHOICES)).toEqual(FULL_STACK);
        expect(resolvePresetSelection(FULL_STACK, null)).toEqual(FULL_STACK);
    });

    test('findPreset finds built-in and saved presets and saved preset ids never collide with built-ins', () => {
        const saved = upsertPreset([], { name: 'builtin all dev api', selection: FULL_STACK }, () => 1);
        expect(saved[0].id).toBe('builtin-all-dev-api-saved');
        expect(findPreset(saved, 'builtin-all')).toBe(BUILT_IN_PRESETS[2]);
        expect(findPreset(saved, 'builtin-all-dev-api-saved')).toBe(saved[0]);
        expect(findPreset(saved, 'missing')).toBeUndefined();
    });
});

describe('backend additions', () => {
    test('backendAdditionChoices lists modules not yet in a full-stack selection', () => {
        expect(backendAdditionChoices(FULL_STACK, CHOICES).map((choice) => choice.value)).toEqual([
            'auth',
            'tasks',
        ]);
    });

    test('backendAdditionChoices is empty for frontend-only launches', () => {
        expect(backendAdditionChoices({ portals: ['sso'], stackMode: 'frontend-dev-api' }, CHOICES)).toEqual([]);
    });

    test('applyBackendAddition mirrors the host so presets saved later include the addition', () => {
        expect(applyBackendAddition(FULL_STACK, { module: 'tasks', runMode: 'background', watch: true })).toMatchObject({
            backendModules: ['api', 'patients', 'tasks'],
            backendWatchModules: ['patients', 'tasks'],
            visualStudioModules: [],
        });
        expect(applyBackendAddition(FULL_STACK, { module: 'auth', runMode: 'vs' })).toMatchObject({
            backendRunMode: 'mixed',
            backendModules: ['api', 'patients', 'auth'],
            visualStudioModules: ['auth'],
            backendWatchModules: ['patients'],
        });
    });
});

describe('buildDashboardView', () => {
    test('describes an idle launcher with the saved configuration and presets', () => {
        const presets = [{ id: 'p', name: 'P', summary: 'SSO · Frontend · dev API', selection: {}, savedAt: 1 }];
        expect(buildDashboardView({ phase: 'idle', presets })).toEqual({
            phase: 'idle',
            error: null,
            starters: BUILT_IN_PRESETS.map(({ id, name, summary }) => ({ id, name, summary })),
            presets: [{ id: 'p', name: 'P', summary: 'SSO · Frontend · dev API' }],
        });
    });

    test('describes a running session with grouped targets, allowed actions, and add availability', () => {
        const view = buildDashboardView({
            phase: 'running',
            sessionName: 'Patients hot reload',
            selection: FULL_STACK,
            choices: CHOICES,
            snapshot: {
                isShuttingDown: false,
                targets: [
                    {
                        id: 'sso-local', label: 'SSO', kind: 'frontend', status: 'ready', openable: true,
                        url: 'http://localhost:3001', startedAt: 10, readyAt: 20, color: 'cyan',
                    },
                    {
                        id: 'backend-patients', label: 'Patients (hot reload)', kind: 'backend', status: 'failed', openable: false,
                        failureReason: 'exited with code 1', command: 'dotnet watch',
                    },
                ],
            },
        });

        expect(view.session).toEqual({ name: 'Patients hot reload', label: '1 of 2 ready', isShuttingDown: false });
        expect(view.canAddBackend).toBe(true);
        expect(view.groups[0].targets[0]).toEqual({
            id: 'sso-local', label: 'SSO', status: 'ready', port: '3001', actions: ['open', 'restart', 'stop'],
            startedAt: 10, readyAt: 20, failureReason: '', lastRebuildDurationMs: null, watch: false, adopted: false,
        });
        expect(view.groups[1].targets[0]).toMatchObject({
            id: 'backend-patients', label: 'Patients', status: 'failed', port: '', failureReason: 'exited with code 1',
            actions: ['start', 'logs'], watch: true,
        });
    });

    test('hides the add action once every module is running or the session is stopping', () => {
        const all = { ...FULL_STACK, backendModules: ['api', 'auth', 'patients', 'tasks'] };
        expect(
            buildDashboardView({ phase: 'running', selection: all, choices: CHOICES, snapshot: { targets: [] } })
                .canAddBackend,
        ).toBe(false);
        expect(
            buildDashboardView({
                phase: 'running', selection: FULL_STACK, choices: CHOICES,
                snapshot: { targets: [], isShuttingDown: true },
            }).canAddBackend,
        ).toBe(false);
    });
});

test('sessionLabel describes disconnected, running, and stopping sessions', () => {
    expect(sessionLabel(null)).toBe('Not running');
    expect(sessionLabel({ targets: [{ status: 'ready' }, { status: 'starting' }] })).toBe('1 of 2 ready');
    expect(sessionLabel({ targets: [], isShuttingDown: true })).toBe('Stopping');
});
