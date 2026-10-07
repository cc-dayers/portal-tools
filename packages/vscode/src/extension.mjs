import crypto from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';

import { connectToLauncherHost, stackModeSupportsVisualStudio } from '@cc-dayers/portal-protocol';
import * as model from './launcher-model.mjs';

const CLIENT_INFO = { name: 'cc-portals-vscode', version: '0.0.1' };
const HOST_RELATIVE_PATH = path.join('Portals', 'scripts', 'portal-launcher-host.mjs');
const VIEW_ID = 'ccPortalLauncher.dashboard';
const PRESETS_KEY = 'ccPortalLauncher.presets';
const USAGE_KEY = 'ccPortalLauncher.usage';
const PRESET_DISPLAY_SETTING = 'ccPortalLauncher.presets.displayMode';
const WEBVIEW_COMMANDS = new Set([
    'launchSaved',
    'configure',
    'editSession',
    'resetDefaults',
    'restartAll',
    'stopAll',
    'addBackend',
    'savePreset',
    'showLogs',
]);

let activeSession;

export async function activate(context) {
    const output = vscode.window.createOutputChannel('CareContinuity Portal Launcher', { log: true });
    const state = { phase: 'idle', snapshot: null, selection: null, sessionName: '', error: null };
    let webviewView;

    const getPresets = () => context.workspaceState.get(PRESETS_KEY, []);
    const setPresets = async (presets) => {
        await context.workspaceState.update(PRESETS_KEY, presets);
        render();
    };
    const getUsage = () => context.workspaceState.get(USAGE_KEY, model.EMPTY_USAGE);
    const setUsage = async (usage) => {
        await context.workspaceState.update(USAGE_KEY, usage);
        render();
    };
    const presetIdByName = (name) => getPresets().find((preset) => preset.name === name)?.id ?? null;

    function dashboardView() {
        return model.buildDashboardView({
            ...state,
            presets: getPresets(),
            usage: getUsage(),
            choices: activeSession?.client.session?.choices,
            presetDisplay: vscode.workspace.getConfiguration('ccPortalLauncher').get('presets.displayMode', 'full'),
        });
    }

    function render() {
        if (!webviewView) return;
        const targets = state.snapshot?.targets ?? [];
        const failed = targets.filter((target) => target.status === 'failed').length;
        webviewView.badge = failed ? { value: failed, tooltip: `${failed} failed` } : undefined;
        webviewView.description = state.phase === 'idle' ? undefined : model.sessionLabel(state.snapshot);
        if (!webviewView.visible) return;
        void webviewView.webview.postMessage({
            type: 'render',
            view: dashboardView(),
        });
    }

    function setPhase(phase, patch = {}) {
        Object.assign(state, { phase }, patch);
        void setSessionContext(phase === 'idle' ? 'idle' : 'running');
        render();
    }

    async function connect() {
        if (activeSession) return activeSession;
        const workspace = await findApplicationWorkspace();
        if (!workspace) {
            throw new Error('Open a workspace containing Portals/scripts/portal-launcher-host.mjs.');
        }

        const hostPath = resolveHostPath(context, workspace);
        const client = await connectToLauncherHost({
            hostPath,
            cwd: path.dirname(path.dirname(hostPath)),
            runtimePath: 'node',
            clientInfo: CLIENT_INFO,
        });
        const session = { client, launched: false, disposables: [] };
        activeSession = session;
        session.disposables.push(
            client.onState((snapshot) => {
                state.snapshot = snapshot;
                render();
            }),
            client.onLog((entry) => writeLog(output, entry)),
            client.onError((error) => {
                output.error(error?.message || 'Launcher protocol error');
                state.error = error?.message || 'Launcher protocol error';
                render();
            }),
        );
        void client.exitPromise.then((exitCode) => {
            output.info(`Launcher session exited with code ${exitCode}.`);
            if (activeSession !== session) return;
            releaseSession(session);
            setPhase('idle', {
                snapshot: null,
                selection: null,
                sessionName: '',
                error: session.launched && exitCode !== 0 ? `The launcher exited with code ${exitCode}. See the log for details.` : state.error,
            });
        });
        return session;
    }

    function disconnectIdle(session) {
        if (session.launched || activeSession !== session) return;
        releaseSession(session);
        session.client.close();
    }

    async function launch({ source, selection, name, presetId = null }) {
        if (activeSession?.launched) throw new Error('A launcher session is already running.');
        setPhase('connecting', { error: null, snapshot: null, sessionName: name });
        let session;
        try {
            session = await connect();
            const resolved =
                source === 'saved'
                    ? session.client.session?.initialSelection
                    : model.resolvePresetSelection(selection, session.client.session?.choices);
                    const summary = model.selectionSummary(resolved, session.client.session?.choices);
                    const launchName = name || summary || 'Last launch';
            session.launched = true;
                    setPhase('launching', { selection: structuredClone(resolved ?? null), sessionName: launchName });
            await session.client.request(
                'command.launch',
                source === 'saved' ? { source: 'saved' } : { source: 'selection', selection: resolved },
            );
            setPhase('running');
            await setUsage(model.recordUse(getUsage(), presetId, Date.now(), { name: launchName, summary }));
        } catch (error) {
            if (session) {
                session.launched = false;
                disconnectIdle(session);
            }
            setPhase('idle', { snapshot: null, selection: null, error: error?.message || String(error) });
        }
    }

    async function configure(seed, presetName, editingId = null) {
        if (activeSession?.launched) throw new Error('Stop the current session before configuring another launch.');
        const session = await connect();
        try {
            const result = await collectSelection(
                session.client.session,
                seed
                    ? model.resolvePresetSelection(seed, session.client.session?.choices)
                    : session.client.session?.initialSelection ?? session.client.session?.savedConfig,
                { editing: Boolean(seed) },
            );
            if (!result) return;

            let name = presetName || '';
            let presetId = null;
            if (result.save) {
                const saved = await promptPresetName(presetName);
                if (saved === undefined) return;
                name = saved;
                await savePreset(saved, result.selection, session.client.session?.choices, editingId);
                presetId = presetIdByName(saved);
            }
            if (result.launch) await launch({ source: 'selection', selection: result.selection, name, presetId });
        } finally {
            disconnectIdle(session);
        }
    }

    async function editSession() {
        const session = requireRunningSession();
        if (!state.selection) throw new Error('The launcher did not report the running selection.');
        const choices = session.client.session?.choices;
        const sessionName = state.sessionName;
        const result = await collectSelection(session.client.session, structuredClone(state.selection), { relaunch: true });
        if (!result) return;

        let name = sessionName;
        let presetId = null;
        if (result.save) {
            const saved = await promptPresetName(sessionName);
            if (saved === undefined) return;
            name = saved;
            await savePreset(name, result.selection, choices);
            presetId = presetIdByName(name);
        }
        if (!result.launch) return;

        const confirmed = await vscode.window.showWarningMessage(
            'Applying this configuration will stop the current session and launch it again.',
            { modal: true },
            'Apply and relaunch',
        );
        if (confirmed !== 'Apply and relaunch') return;
        if (requireRunningSession() !== session) throw new Error('The session changed while editing. Open its configuration again.');
        await session.client.shutdown('quit', 'Configuration changed from VS Code');
        await launch({ source: 'selection', selection: result.selection, name, presetId });
    }

    async function savePreset(name, selection, choices, editingId = null) {
        const presets = editingId ? model.renamePreset(getPresets(), editingId, name) : getPresets();
        await setPresets(
            model.upsertPreset(presets, {
                name,
                selection,
                summary: model.selectionSummary(selection, choices),
            }),
        );
        if (editingId && editingId !== presetIdByName(name)) {
            await setUsage(model.moveUsage(getUsage(), editingId, presetIdByName(name)));
        }
        void vscode.window.showInformationMessage(`Saved preset "${name.trim()}".`);
    }

    async function saveRunningPreset() {
        const session = requireRunningSession();
        if (!state.selection) throw new Error('The launcher did not report the running selection.');
        const name = await promptPresetName(state.sessionName);
        if (name === undefined) return;
        await savePreset(name, state.selection, session.client.session?.choices);
        await setUsage(model.recordUse(getUsage(), presetIdByName(name), Date.now(), {
            name: name.trim(), summary: model.selectionSummary(state.selection, session.client.session?.choices),
        }));
        state.sessionName = name.trim();
        render();
    }

    async function addBackend() {
        const session = requireRunningSession();
        const choices = session.client.session?.choices;
        const modules = model.backendAdditionChoices(state.selection, choices);
        if (modules.length === 0) throw new Error('Every backend module is already part of this session.');

        const module = await pickSimple('Add backend module (1/2)', 'Choose a module to add to this session', modules);
        if (module === undefined) return;
        const label = modules.find((choice) => choice.value === module)?.label ?? module;
        const runModes = [
            { label: 'Background', icon: 'terminal', description: 'Artifact build, lowest memory', value: { runMode: 'background', watch: false } },
            { label: 'Background with hot reload', icon: 'flame', description: 'dotnet watch', value: { runMode: 'background', watch: true } },
        ];
        if (choices?.visualStudioAvailable && stackModeSupportsVisualStudio(choices.stackModes, state.selection?.stackMode)) {
            runModes.push({ label: 'Visual Studio', icon: 'debug-alt', description: 'Opens the solution for debugging', value: { runMode: 'vs', watch: false } });
        }
        const mode = await pickSimple(`Add ${label} (2/2)`, `How should ${label} run?`, runModes);
        if (mode === undefined) return;

        const request = { module, ...mode };
        await vscode.window.withProgress(
            { location: { viewId: VIEW_ID }, title: `Adding ${label}` },
            () => session.client.request('command.backend.add', request),
        );
        state.selection = model.applyBackendAddition(state.selection, request);
        render();
    }

    function presetFromContext(context) {
        const preset = model.findPreset(getPresets(), context?.presetId);
        if (!preset) throw new Error('That preset no longer exists.');
        return preset;
    }

    function savedPresetFromContext(context) {
        const preset = presetFromContext(context);
        if (model.BUILT_IN_PRESETS.includes(preset)) throw new Error('Starter presets cannot be renamed or deleted.');
        return preset;
    }

    async function renamePresetFromContext(context) {
        const preset = savedPresetFromContext(context);
        const name = await promptPresetName(preset.name, 'Rename preset');
        if (name === undefined) return;
        const renamed = model.renamePreset(getPresets(), preset.id, name);
        await setUsage(model.moveUsage(getUsage(), preset.id, renamed.find((candidate) => candidate.name === name).id));
        await setPresets(renamed);
    }

    async function deletePresetFromContext(context) {
        const preset = savedPresetFromContext(context);
        const confirmed = await vscode.window.showWarningMessage(
            `Delete the preset "${preset.name}"?`,
            { modal: true },
            'Delete',
        );
        if (confirmed !== 'Delete') return;
        await setUsage(model.moveUsage(getUsage(), preset.id, null));
        await setPresets(model.removePreset(getPresets(), preset.id));
    }

    async function resetDefaults() {
        if (state.phase !== 'idle' || activeSession) {
            throw new Error('Stop the current session and close configuration before resetting defaults.');
        }
        const confirmed = await vscode.window.showWarningMessage(
            'Reset launcher defaults? This deletes this workspace\'s custom presets and launch history and resets your preset display preference. Application launcher configuration is not changed.',
            { modal: true },
            'Reset to defaults',
        );
        if (confirmed !== 'Reset to defaults') return;
        if (state.phase !== 'idle' || activeSession) {
            throw new Error('Stop the current session and close configuration before resetting defaults.');
        }
        await context.workspaceState.update(PRESETS_KEY, undefined);
        await context.workspaceState.update(USAGE_KEY, undefined);
        await vscode.workspace.getConfiguration('ccPortalLauncher').update(
            'presets.displayMode', undefined, vscode.ConfigurationTarget.Global,
        );
        state.error = null;
        render();
        await webviewView?.webview.postMessage({ type: 'reset', view: dashboardView() });
    }

    async function targetCommand(targetId, action) {
        if (!model.isAllowedTargetAction(state.snapshot, targetId, action)) return;
        if (action === 'logs') {
            output.show(true);
            return;
        }
        await requireRunningSession().client.request(`command.target.${action}`, { targetId });
    }

    const commands = {
        launchSaved: () => launch({ source: 'saved' }),
        configure: () => configure(),
        showSettings: async () => {
            await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
            await webviewView?.webview.postMessage({ type: 'settings', view: dashboardView() });
        },
        editSession,
        resetDefaults,
        restartAll: () => requireRunningSession().client.request('command.session.restart-all'),
        stopAll: () =>
            requireSession().client.request('command.session.shutdown', {
                cause: 'quit',
                reason: 'Stopped from VS Code',
            }),
        addBackend,
        savePreset: saveRunningPreset,
        showLogs: () => output.show(),
    };
    // Invoked from native webview/context menus; VS Code passes the element's data-vscode-context as the argument.
    const contextCommands = {
        'configuration.edit': () => configure(),
        'preset.launch': (context) => {
            const preset = presetFromContext(context);
            return launch({ source: 'selection', selection: preset.selection, name: preset.name, presetId: preset.id });
        },
        'preset.edit': (context) => {
            const preset = presetFromContext(context);
            const builtIn = model.BUILT_IN_PRESETS.includes(preset);
            return configure(structuredClone(preset.selection), builtIn ? '' : preset.name, builtIn ? null : preset.id);
        },
        'preset.rename': renamePresetFromContext,
        'preset.delete': deletePresetFromContext,
        ...Object.fromEntries(
            ['open', 'start', 'stop', 'restart', 'logs'].map((action) => [
                `target.${action}`,
                (context) => targetCommand(context?.targetId, action),
            ]),
        ),
    };

    async function handleWebviewMessage(message) {
        if (message?.type === 'ready') {
            render();
        } else if (message?.type === 'command' && WEBVIEW_COMMANDS.has(message.command)) {
            await commands[message.command]();
        } else if (message?.type === 'target' && typeof message.targetId === 'string') {
            await targetCommand(message.targetId, message.action);
        } else if (
            message?.type === 'setting' &&
            message.key === 'presets.displayMode' &&
            ['compact', 'full'].includes(message.value)
        ) {
            await vscode.workspace.getConfiguration('ccPortalLauncher').update(
                message.key,
                message.value,
                vscode.ConfigurationTarget.Global,
            );
        } else if (message?.type === 'preset' && typeof message.presetId === 'string') {
            if (['launch', 'edit', 'delete'].includes(message.action)) {
                await contextCommands[`preset.${message.action}`]({ presetId: message.presetId });
            }
        }
    }

    context.subscriptions.push(
        output,
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(PRESET_DISPLAY_SETTING)) render();
        }),
        vscode.window.registerWebviewViewProvider(VIEW_ID, {
            resolveWebviewView(view) {
                webviewView = view;
                const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
                view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
                view.webview.html = dashboardHtml(view.webview, webviewRoot);
                view.webview.onDidReceiveMessage((message) =>
                    handleWebviewMessage(message).catch((error) => showError(error)),
                );
                view.onDidChangeVisibility(render);
                view.onDidDispose(() => {
                    if (webviewView === view) webviewView = undefined;
                });
            },
        }),
        {
            dispose() {
                void shutdownActiveSession('VS Code extension disposed');
            },
        },
    );
    for (const [name, handler] of Object.entries({ ...commands, ...contextCommands })) {
        register(context, `ccPortalLauncher.${name}`, handler);
    }
    await setSessionContext('idle');

    // Read-only view of controller state for the integration tests (vscode.extensions.getExtension().exports).
    return {
        get phase() {
            return state.phase;
        },
        get snapshot() {
            return state.snapshot;
        },
        get dashboard() {
            return dashboardView();
        },
    };
}

export async function deactivate() {
    await shutdownActiveSession('VS Code extension deactivated');
}

function dashboardHtml(webview, root) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (file) => webview.asWebviewUri(vscode.Uri.joinPath(root, file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('dashboard.css')}">
<title>Care Continuity App Launcher</title>
</head>
<body>
<div class="brand"><img src="${asset('logo.svg')}" alt="Care Continuity" width="32" height="32"></div>
<main id="app" aria-label="Care Continuity App Launcher" aria-live="polite"></main>
<script nonce="${nonce}" src="${asset('dashboard.js')}"></script>
</body>
</html>`;
}

function resolveHostPath(context, workspace) {
    // Development-only escape hatch so the Extension Development Host can drive dev/mock-launcher-host.mjs.
    const override = process.env.CC_PORTAL_LAUNCHER_HOST;
    if (override && context.extensionMode === vscode.ExtensionMode.Development) return path.resolve(override);
    return path.join(workspace.uri.fsPath, HOST_RELATIVE_PATH);
}

async function findApplicationWorkspace() {
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const hostUri = vscode.Uri.joinPath(folder.uri, 'Portals', 'scripts', 'portal-launcher-host.mjs');
        try {
            await vscode.workspace.fs.stat(hostUri);
            return folder;
        } catch {
            // Continue through multi-root workspaces until the application repo is found.
        }
    }
    return null;
}

async function collectSelection(session, seed, { editing = false, relaunch = false } = {}) {
    const choices = session?.choices || {};
    const draft = structuredClone(seed || {});
    const fullStack = () => String(draft.stackMode).startsWith('fullstack-');
    const steps = [
        {
            title: 'Portals',
            many: true,
            choices: () => choices.portals || [],
            get: () => draft.portals || [],
            set: (value) => (draft.portals = value),
        },
        {
            title: 'Environment',
            choices: () => choices.stackModes || [],
            get: () => draft.stackMode,
            set: (value) => {
                draft.stackMode = value;
                if (!stackModeSupportsVisualStudio(choices.stackModes, value)) {
                    draft.backendRunMode = 'background';
                    draft.visualStudioModules = [];
                }
            },
        },
        {
            title: 'Backend execution',
            when: fullStack,
            choices: () =>
                (choices.backendRunModes || []).filter(
                    (choice) =>
                        !choice.disabled &&
                        (choice.value === 'background' || stackModeSupportsVisualStudio(choices.stackModes, draft.stackMode)),
                ),
            get: () => draft.backendRunMode,
            set: (value) => (draft.backendRunMode = value),
        },
        {
            title: 'Backend modules',
            many: true,
            allowEmpty: true,
            when: fullStack,
            choices: () => choices.backendModules || [],
            get: () => draft.backendModules || [],
            set: (value) => (draft.backendModules = value),
        },
        {
            title: 'Visual Studio modules',
            many: true,
            allowEmpty: true,
            when: () => fullStack() && draft.backendRunMode === 'mixed',
            choices: () => (choices.backendModules || []).filter((choice) => draft.backendModules?.includes(choice.value)),
            get: () => draft.visualStudioModules || [],
            set: (value) => (draft.visualStudioModules = value),
        },
        {
            title: 'Backend hot reload',
            many: true,
            allowEmpty: true,
            when: () => fullStack() && draft.backendRunMode !== 'vs',
            choices: () =>
                (choices.backendModules || []).filter(
                    (choice) =>
                        draft.backendModules?.includes(choice.value) &&
                        !(draft.backendRunMode === 'mixed' && draft.visualStudioModules?.includes(choice.value)),
                ),
            get: () => draft.backendWatchModules || [],
            set: (value) => (draft.backendWatchModules = value),
        },
        {
            title: 'Build mode',
            choices: () => [
                { label: 'Dev Server', icon: 'flame', value: 'dev' },
                { label: 'Build + Preview', icon: 'package', value: 'preview' },
            ],
            get: () => draft.buildMode,
            set: (value) => (draft.buildMode = value),
        },
        {
            title: 'Existing servers',
            choices: () => choices.existingServerModes || [],
            get: () => draft.existingServerMode,
            set: (value) => (draft.existingServerMode = value),
        },
        {
            title: 'Browser',
            choices: () => [
                { label: 'Open selected portals when ready', icon: 'globe', value: true },
                { label: 'Do not open portals', icon: 'eye-closed', value: false },
            ],
            get: () => draft.autoOpen,
            set: (value) => (draft.autoOpen = value),
        },
        {
            title: 'Finish',
            choices: () => relaunch
                ? [
                    { label: 'Apply and relaunch', icon: 'refresh', value: 'launch' },
                    { label: 'Save as preset only', icon: 'bookmark', value: 'save' },
                    { label: 'Save as preset and relaunch', icon: 'save', value: 'save-launch' },
                ]
                : editing
                ? [
                    { label: 'Save preset', icon: 'save', value: 'save' },
                    { label: 'Save preset and launch', icon: 'rocket', value: 'save-launch' },
                ]
                : [
                    { label: 'Launch', icon: 'rocket', value: 'launch' },
                    { label: 'Save as preset and launch', icon: 'save', value: 'save-launch' },
                    { label: 'Save as preset only', icon: 'bookmark', value: 'save' },
                ],
            get: () => editing ? 'save' : 'launch',
            set: (value) => (draft.finish = value),
        },
    ];

    const history = [];
    let index = 0;
    while (index < steps.length) {
        const step = steps[index];
        if (step.when && !step.when()) {
            index += 1;
            continue;
        }
        const active = steps.filter((candidate) => !candidate.when || candidate.when());
        const result = await quickStep({
            title: `${relaunch ? 'Edit session configuration' : 'Configure launch'} · ${step.title}`,
            step: active.indexOf(step) + 1,
            totalSteps: active.length,
            choices: step.choices(),
            many: step.many,
            allowEmpty: step.allowEmpty,
            selected: step.get(),
            canGoBack: history.length > 0,
        });
        if (result.kind === 'cancel') return null;
        if (result.kind === 'back') {
            index = history.pop();
            continue;
        }
        step.set(result.value);
        history.push(index);
        index += 1;
    }

    const { finish, ...selection } = draft;
    if (!fullStack()) {
        selection.backendModules = [];
        selection.visualStudioModules = [];
        selection.backendWatchModules = [];
    } else if (selection.backendRunMode === 'vs') {
        selection.visualStudioModules = [...selection.backendModules];
        selection.backendWatchModules = [];
    } else if (selection.backendRunMode !== 'mixed') {
        selection.visualStudioModules = [];
    }
    return { selection, launch: finish !== 'save', save: finish !== 'launch' };
}

function quickStep({ title, step, totalSteps, choices, many, allowEmpty, selected, canGoBack }) {
    return new Promise((resolve) => {
        const picker = vscode.window.createQuickPick();
        const items = quickPickItems(choices);
        const selectable = items.filter((item) => item.kind !== vscode.QuickPickItemKind.Separator);
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
            picker.dispose();
        };

        picker.title = title;
        picker.step = step;
        picker.totalSteps = totalSteps;
        picker.placeholder = many ? 'Type to filter · Space to toggle · Enter to continue' : 'Type to filter · Enter to continue';
        picker.canSelectMany = Boolean(many);
        picker.matchOnDescription = true;
        picker.ignoreFocusOut = true;
        picker.buttons = canGoBack ? [vscode.QuickInputButtons.Back] : [];
        picker.items = items;
        if (many) {
            const values = new Set(selected);
            picker.selectedItems = selectable.filter((item) => values.has(item.value));
        } else {
            const active = selectable.find((item) => item.value === selected);
            if (active) picker.activeItems = [active];
        }

        picker.onDidTriggerButton((button) => {
            if (button === vscode.QuickInputButtons.Back) done({ kind: 'back' });
        });
        picker.onDidAccept(() => {
            if (many) {
                const values = picker.selectedItems.map((item) => item.value);
                if (!allowEmpty && values.length === 0) {
                    picker.placeholder = 'Select at least one item to continue';
                    return;
                }
                done({ kind: 'value', value: values });
                return;
            }
            const item = picker.selectedItems[0] ?? picker.activeItems[0];
            if (item) done({ kind: 'value', value: item.value });
        });
        picker.onDidHide(() => done({ kind: 'cancel' }));
        picker.show();
    });
}

async function pickSimple(title, placeHolder, choices) {
    const picked = await vscode.window.showQuickPick(quickPickItems(choices), { title, placeHolder, matchOnDescription: true });
    return picked?.value;
}

function quickPickItems(choices) {
    return model
        .choiceEntries(choices)
        .map((entry) => (entry.separator ? { kind: vscode.QuickPickItemKind.Separator, label: entry.label } : entry));
}

async function promptPresetName(value = '', title = 'Save as preset') {
    const name = await vscode.window.showInputBox({
        title,
        prompt: 'A preset with the same name is replaced.',
        value,
        validateInput: (input) => (input.trim() ? undefined : 'Enter a preset name.'),
    });
    return name === undefined ? undefined : name.trim();
}

function requireSession() {
    if (!activeSession?.launched) throw new Error('No launcher session is running.');
    return activeSession;
}

function requireRunningSession() {
    const session = requireSession();
    if (session.client.lastSnapshot?.isShuttingDown) throw new Error('The launcher session is stopping.');
    return session;
}

function register(context, command, handler) {
    context.subscriptions.push(
        vscode.commands.registerCommand(command, async (...args) => {
            try {
                return await handler(...args);
            } catch (error) {
                showError(error);
                return undefined;
            }
        }),
    );
}

function showError(error) {
    void vscode.window.showErrorMessage(error?.message || String(error));
}

function writeLog(output, entry) {
    const label = entry?.targetLabel || entry?.targetId || 'Launcher';
    output.info(`[${label}] ${entry?.line || ''}`);
}

function releaseSession(session) {
    for (const dispose of session.disposables) dispose();
    session.disposables = [];
    if (activeSession === session) activeSession = undefined;
}

async function shutdownActiveSession(reason) {
    const session = activeSession;
    if (!session) return;
    if (session.launched) {
        try {
            await Promise.race([
                session.client.shutdown('quit', reason),
                new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
        } catch {
            session.client.close();
        }
    } else {
        session.client.close();
    }
}

function setSessionContext(value) {
    return vscode.commands.executeCommand('setContext', 'ccPortalLauncher.session', value);
}

