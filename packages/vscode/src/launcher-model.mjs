const GROUPS = [
    { id: 'frontend', label: 'Frontend', kinds: ['frontend', 'portal'] },
    { id: 'backend', label: 'Backend', kinds: ['backend'] },
];

const TARGET_ACTIONS = ['open', 'restart', 'stop', 'start', 'logs'];

const FRONTEND_ONLY = { backendModules: [], visualStudioModules: [], backendWatchModules: [], buildMode: 'dev' };

// Starter presets matching the Portals package scripts. `portals: 'all'` resolves from the host's choices at launch.
export const BUILT_IN_PRESETS = Object.freeze([
    {
        id: 'builtin-all-dev-api',
        name: 'All portals · dev API',
        summary: 'Every portal against the deployed dev API. Same as yarn start:all-dev-api.',
        selection: { portals: 'all', stackMode: 'frontend-dev-api', ...FRONTEND_ONLY },
    },
    {
        id: 'builtin-core-dev-api',
        name: 'Core portals · dev API',
        summary: 'SSO, Admin, Provider and Coordinator against the dev API. Same as yarn start:core-dev-api.',
        selection: { portals: ['sso', 'admin', 'provider', 'coordinator'], stackMode: 'frontend-dev-api', ...FRONTEND_ONLY },
    },
    {
        id: 'builtin-all',
        name: 'All portals · local API',
        summary: 'Every portal against a backend you run yourself. Same as yarn start:all.',
        selection: { portals: 'all', stackMode: 'frontend-local-api', ...FRONTEND_ONLY },
    },
]);

export function buildTargetGroups(snapshot) {
    const targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [];
    return GROUPS.map(({ id, label, kinds }) => ({
        id,
        label,
        targets: targets.filter((target) => kinds.includes(target.kind)),
    }));
}

export function sessionLabel(snapshot) {
    if (!snapshot) return 'Not running';
    if (snapshot.isShuttingDown) return 'Stopping';
    const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
    const ready = targets.filter((target) => target.status === 'ready').length;
    return `${ready} of ${targets.length} ready`;
}

export function targetActions(target, snapshot) {
    if (snapshot?.isShuttingDown) return [];
    const open = target.openable ? ['open'] : [];
    switch (target.status) {
        case 'ready':
            return [...open, 'restart', 'stop'];
        case 'rebuilding':
            return [...open, 'stop'];
        case 'starting':
        case 'restarting':
            return ['stop'];
        case 'failed':
            return ['start', 'logs'];
        case 'stopped':
            return ['start'];
        default:
            return [];
    }
}

export function isAllowedTargetAction(snapshot, targetId, action) {
    if (!TARGET_ACTIONS.includes(action)) return false;
    const target = snapshot?.targets?.find((candidate) => candidate.id === targetId);
    return Boolean(target) && targetActions(target, snapshot).includes(action);
}

const CODICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Presentation is the client's concern: the launcher host sends domain values only,
// so icons and headings are chosen here unless a host supplies its own.
const CHOICE_PRESENTATION = Object.freeze({
    'fullstack-local-db': { icon: 'database', group: 'Full stack' },
    'fullstack-dev-db': { icon: 'cloud', group: 'Full stack' },
    'fullstack-shadow-db': { icon: 'beaker', group: 'Full stack' },
    'frontend-local-api': { icon: 'plug', group: 'Frontend only' },
    'frontend-dev-api': { icon: 'globe', group: 'Frontend only' },
    background: { icon: 'terminal' },
    vs: { icon: 'debug-alt' },
    mixed: { icon: 'split-horizontal' },
    'kill-before-start': { icon: 'debug-stop' },
    'auto-restart': { icon: 'sync' },
    none: { icon: 'circle-slash' },
});

// Turns host choices into picker entries; `icon` is a codicon name and `group` becomes a heading.
export function choiceEntries(choices) {
    const entries = [];
    let group = '';
    for (const choice of choices ?? []) {
        const presentation = CHOICE_PRESENTATION[choice.value] ?? {};
        const groupName = choice.group ?? presentation.group;
        const heading = typeof groupName === 'string' ? groupName.trim() : '';
        if (heading && heading !== group) entries.push({ separator: true, label: heading });
        group = heading;
        const iconName = choice.icon ?? presentation.icon;
        const icon = typeof iconName === 'string' && CODICON_NAME.test(iconName) ? iconName : '';
        entries.push({
            label: icon ? `$(${icon}) ${choice.label}` : choice.label,
            description: choice.description,
            value: choice.value,
        });
    }
    return entries;
}

export function selectionSummary(selection, choices) {
    const label = (list, value) => list?.find((choice) => choice.value === value)?.label ?? value;
    const parts = [
        (selection?.portals ?? []).map((portal) => label(choices?.portals, portal)).join(', '),
        label(choices?.stackModes, selection?.stackMode),
    ];
    if (isFullStack(selection) && selection.backendModules?.length) {
        parts.push(
            selection.backendModules
                .map((module) => {
                    const name = label(choices?.backendModules, module);
                    if (selection.visualStudioModules?.includes(module)) return `${name} (VS)`;
                    if (selection.backendWatchModules?.includes(module)) return `${name} (watch)`;
                    return name;
                })
                .join(', '),
        );
    }
    return parts.filter(Boolean).join(' · ');
}

export function findPreset(presets, id) {
    return BUILT_IN_PRESETS.find((preset) => preset.id === id) ?? presets.find((preset) => preset.id === id);
}

export function resolvePresetSelection(selection, choices) {
    const available = choices?.portals?.map((choice) => choice.value);
    if (!available) return selection;
    const portals = selection.portals === 'all' ? available : selection.portals.filter((portal) => available.includes(portal));
    return { ...selection, portals };
}

export function upsertPreset(presets, { name, selection, summary = '' }, now = Date.now) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('Enter a preset name.');
    const id = presetId(trimmed);
    const preset = { id, name: trimmed, selection: structuredClone(selection), summary, savedAt: now() };
    const index = presets.findIndex((candidate) => candidate.id === id);
    if (index < 0) return [...presets, preset];
    return presets.map((candidate, position) => (position === index ? preset : candidate));
}

export function renamePreset(presets, id, name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('Enter a preset name.');
    const nextId = presetId(trimmed);
    if (presets.some((candidate) => candidate.id === nextId && candidate.id !== id)) {
        throw new Error(`A preset named "${trimmed}" already exists.`);
    }
    return presets.map((candidate) =>
        candidate.id === id ? { ...candidate, id: nextId, name: trimmed } : candidate,
    );
}

export function removePreset(presets, id) {
    return presets.filter((candidate) => candidate.id !== id);
}

export const EMPTY_USAGE = Object.freeze({ last: null, used: {} });

// `last.presetId` is null when the most recent launch was not a preset (saved configuration or an unsaved selection).
export function recordUse(usage, presetId, at = Date.now(), configuration = null) {
    const used = usage?.used ?? {};
    return {
        last: {
            presetId: presetId ?? null,
            at,
            ...(configuration ? { name: configuration.name, summary: configuration.summary } : {}),
        },
        used: presetId ? { ...used, [presetId]: at } : used,
    };
}

// Passing `to = null` forgets the preset.
export function moveUsage(usage, from, to) {
    const { [from]: at, ...used } = usage?.used ?? {};
    return {
        last: usage?.last?.presetId === from ? { ...usage.last, presetId: to } : (usage?.last ?? null),
        used: to && at !== undefined ? { ...used, [to]: at } : used,
    };
}

export function backendAdditionChoices(selection, choices) {
    if (!isFullStack(selection)) return [];
    const running = new Set(selection.backendModules ?? []);
    return (choices?.backendModules ?? []).filter((choice) => !running.has(choice.value));
}

export function applyBackendAddition(selection, { module, runMode, watch = false }) {
    const currentMode = selection.backendRunMode ?? 'background';
    return {
        ...selection,
        backendRunMode: currentMode === runMode ? currentMode : 'mixed',
        backendModules: [...(selection.backendModules ?? []), module],
        visualStudioModules:
            runMode === 'vs'
                ? [...(selection.visualStudioModules ?? []), module]
                : [...(selection.visualStudioModules ?? [])],
        backendWatchModules:
            runMode === 'background' && watch
                ? [...(selection.backendWatchModules ?? []), module]
                : [...(selection.backendWatchModules ?? [])],
    };
}

export function buildDashboardView({ phase, snapshot = null, presets = [], usage = EMPTY_USAGE, sessionName, selection, choices, error = null, presetDisplay = 'full' }) {
    const used = usage?.used ?? {};
    const entry = (kind) => ({ id, name, summary }) => ({ id, name, summary, kind, lastUsedAt: used[id] ?? null });
    const all = [...presets.map(entry('custom')), ...BUILT_IN_PRESETS.map(entry('canned'))].sort(
        (first, second) => (second.lastUsedAt ?? 0) - (first.lastUsedAt ?? 0),
    );
    const presetState = { presets: all, presetDisplay: presetDisplay === 'compact' ? 'compact' : 'full' };
    if (phase === 'idle') {
        const lastId = usage?.last?.presetId;
        return {
            phase,
            error,
            ...presetState,
            hasLaunched: Boolean(usage?.last),
            lastUsedId: all.some((preset) => preset.id === lastId) ? lastId : null,
            lastConfiguration: usage?.last ? { name: usage.last.name || 'Last launch', summary: usage.last.summary || '' } : null,
        };
    }

    const watchModules = new Set(selection?.backendWatchModules ?? []);
    return {
        phase,
        error,
        ...presetState,
        session: {
            name: sessionName || 'Custom launch',
            label: phase === 'disconnected' ? 'Disconnected' : snapshot ? sessionLabel(snapshot) : 'Preparing launch',
            isShuttingDown: Boolean(snapshot?.isShuttingDown),
        },
        canAddBackend:
            phase === 'running' &&
            !snapshot?.isShuttingDown &&
            backendAdditionChoices(selection, choices).length > 0,
        groups: buildTargetGroups(snapshot).map((group) => ({
            id: group.id,
            label: group.label,
            targets: group.targets.map((target) => ({
                id: target.id,
                label: String(target.label ?? target.id).replace(/\s*\(hot reload\)$/, ''),
                status: target.status,
                port: portOf(target.url),
                actions: targetActions(target, snapshot),
                startedAt: target.startedAt ?? null,
                readyAt: target.readyAt ?? null,
                failureReason: target.failureReason ?? '',
                lastRebuildDurationMs: target.lastRebuildDurationMs ?? null,
                watch:
                    watchModules.has(String(target.id).replace(/^backend-/, '')) ||
                    /\(hot reload\)$/.test(target.label ?? ''),
                adopted: Boolean(target.adopted),
            })),
        })),
    };
}

function isFullStack(selection) {
    return String(selection?.stackMode ?? '').startsWith('fullstack-');
}

function presetId(name) {
    const id =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'preset';
    return BUILT_IN_PRESETS.some((preset) => preset.id === id) ? `${id}-saved` : id;
}

function portOf(url) {
    if (!url) return '';
    try {
        return new URL(url).port;
    } catch {
        return '';
    }
}
