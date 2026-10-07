import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const mocks = vi.hoisted(() => ({
    commands: new Map(),
    executeCommand: vi.fn(),
    connect: vi.fn(),
    createQuickPick: vi.fn(),
    input: vi.fn(),
    information: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    mode: 'full',
    update: vi.fn(),
    onConfiguration: null,
    provider: null,
    pickers: [],
    finish: null,
}));

vi.mock('vscode', () => ({
    ConfigurationTarget: { Global: 1 },
    ExtensionMode: { Development: 2, Test: 3 },
    QuickPickItemKind: { Separator: -1 },
    QuickInputButtons: { Back: {} },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: `${base.fsPath}/${parts.join('/')}` }) },
    commands: {
        executeCommand: mocks.executeCommand,
        registerCommand: (name, handler) => {
            mocks.commands.set(name, handler);
            return { dispose() {} };
        },
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: '/app' } }],
        fs: { stat: vi.fn().mockResolvedValue({}) },
        getConfiguration: () => ({ get: (_key, fallback) => mocks.mode ?? fallback, update: mocks.update }),
        onDidChangeConfiguration: (handler) => {
            mocks.onConfiguration = handler;
            return { dispose() {} };
        },
    },
    window: {
        createOutputChannel: () => ({ info() {}, error() {}, dispose() {} }),
        createQuickPick: mocks.createQuickPick,
        showInputBox: mocks.input,
        showInformationMessage: mocks.information,
        showWarningMessage: mocks.warning,
        showErrorMessage: mocks.error,
        registerWebviewViewProvider: (_id, provider) => {
            mocks.provider = provider;
            return { dispose() {} };
        },
    },
}));

vi.mock('@cc-dayers/portal-protocol', async (importOriginal) => ({
    ...(await importOriginal()),
    connectToLauncherHost: mocks.connect,
}));

import { activate, deactivate } from '../src/extension.mjs';

const SELECTION = {
    portals: ['sso'], stackMode: 'frontend-dev-api', buildMode: 'dev',
    existingServerMode: 'reuse', autoOpen: false,
};
const PRESET = { id: 'daily', name: 'Daily', summary: 'Old summary', selection: SELECTION };

describe('preset settings and actions', () => {
    let storage;
    let receive;
    let posted;
    let client;
    let api;
    let context;
    let webview;

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.commands.clear();
        mocks.pickers = [];
        mocks.finish = null;
        mocks.mode = 'full';
        mocks.input.mockResolvedValue('Daily updated');
        mocks.warning.mockResolvedValue('Delete');
        mocks.update.mockImplementation(async (_key, value) => {
            mocks.mode = value;
            mocks.onConfiguration({ affectsConfiguration: (key) => key === 'ccPortalLauncher.presets.displayMode' });
        });
        mocks.createQuickPick.mockImplementation(() => {
            let accept;
            const picker = {
                onDidAccept: (handler) => { accept = handler; },
                onDidHide() {},
                onDidTriggerButton() {},
                dispose() {},
                show() {
                    queueMicrotask(() => {
                        picker.initialSelectedValues = (picker.selectedItems ?? []).map((item) => item.value);
                        if (picker.canSelectMany) {
                            picker.selectedItems = picker.items.filter((item) => item.value === 'coordinator');
                        } else if (picker.title.endsWith('Finish') && mocks.finish) {
                            picker.selectedItems = picker.items.filter((item) => item.value === mocks.finish);
                        } else {
                            picker.selectedItems = picker.activeItems ?? [picker.items.find((item) => item.value !== undefined)];
                        }
                        accept();
                    });
                },
            };
            mocks.pickers.push(picker);
            return picker;
        });
        const exit = Promise.withResolvers();
        client = {
            session: {
                initialSelection: SELECTION,
                choices: {
                    portals: [{ label: 'SSO', value: 'sso' }, { label: 'Coordinator', value: 'coordinator' }],
                    stackModes: [{ label: 'Dev API', value: 'frontend-dev-api' }],
                    existingServerModes: [{ label: 'Reuse', value: 'reuse' }],
                },
            },
            exitPromise: exit.promise,
            onState: () => () => {},
            onLog: () => () => {},
            onError: () => () => {},
            request: vi.fn().mockResolvedValue({}),
            close: vi.fn(() => exit.resolve(0)),
            shutdown: vi.fn(async () => exit.resolve(0)),
        };
        mocks.connect.mockResolvedValue(client);
        storage = new Map([
            ['ccPortalLauncher.presets', [structuredClone(PRESET)]],
            ['ccPortalLauncher.usage', { last: { presetId: 'daily', at: 10 }, used: { daily: 10 } }],
        ]);
        context = {
            subscriptions: [], extensionUri: { fsPath: '/extension' }, extensionMode: 3,
            workspaceState: {
                get: (key, fallback) => storage.get(key) ?? fallback,
                update: async (key, value) => {
                    if (value === undefined) storage.delete(key);
                    else storage.set(key, value);
                },
            },
        };
        api = await activate(context);
        posted = vi.fn();
        webview = {
            asWebviewUri: (uri) => uri.fsPath,
            cspSource: 'test', postMessage: posted,
            onDidReceiveMessage: (handler) => { receive = handler; },
        };
        mocks.provider.resolveWebviewView({
            visible: true,
            webview,
            onDidChangeVisibility() {},
            onDidDispose() {},
        });
    });

    afterEach(async () => {
        await deactivate();
        for (const subscription of context.subscriptions) subscription.dispose();
    });

    test('keeps the native title and a centered 32px colored logo before the dashboard', () => {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const title = 'Care Continuity App Launcher';
        expect(manifest.contributes.viewsContainers.activitybar[0].title).toBe(title);
        expect(manifest.contributes.views.ccPortalLauncher[0]).toMatchObject({
            name: title, contextualTitle: title, icon: 'resources/portal-launcher.svg',
        });
        expect(webview.html).toContain(`<title>${title}</title>`);
        expect(webview.html).toContain(`aria-label="${title}"`);
        expect(webview.html).not.toContain('<header');
        expect(webview.html).toContain('<div class="brand"><img src="/extension/dist/webview/logo.svg" alt="Care Continuity" width="32" height="32"></div>');
        expect(webview.html.indexOf('class="brand"')).toBeLessThan(webview.html.indexOf('<main'));
        const stylesheet = readFileSync(new URL('../resources/webview/dashboard.css', import.meta.url), 'utf8');
        expect(stylesheet).toMatch(/\.brand\s*\{[^}]*justify-content:\s*center;/);
    });

    test('updates user settings and rerenders the dashboard without connecting a host', async () => {
        await receive({ type: 'setting', key: 'presets.displayMode', value: 'compact' });
        expect(mocks.update).toHaveBeenCalledWith('presets.displayMode', 'compact', 1);
        expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'render', view: expect.objectContaining({ presetDisplay: 'compact' }),
        }));
        expect(mocks.connect).not.toHaveBeenCalled();
        expect(api.dashboard.presetDisplay).toBe('compact');
    });

    test.each(['idle', 'running'])('the title-bar gear opens display settings without configuring or disrupting a session (%s)', async (phase) => {
        if (phase === 'running') await mocks.commands.get('ccPortalLauncher.launchSaved')();
        const connections = mocks.connect.mock.calls.length;
        const requests = client.request.mock.calls.length;
        await mocks.commands.get('ccPortalLauncher.showSettings')();
        expect(mocks.executeCommand).toHaveBeenLastCalledWith('ccPortalLauncher.dashboard.focus');
        expect(posted).toHaveBeenLastCalledWith({ type: 'settings', view: api.dashboard });
        expect(mocks.connect).toHaveBeenCalledTimes(connections);
        expect(client.request).toHaveBeenCalledTimes(requests);
        expect(mocks.createQuickPick).not.toHaveBeenCalled();
        expect(api.phase).toBe(phase);
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        expect(manifest.contributes.menus['view/title']).toContainEqual({
            command: 'ccPortalLauncher.showSettings',
            when: 'view == ccPortalLauncher.dashboard',
            group: 'navigation@1',
        });
        expect(manifest.contributes.menus['view/title'].some((item) => item.command === 'ccPortalLauncher.configure')).toBe(false);
        expect(manifest.contributes.commands.filter((command) => command.icon === '$(settings-gear)').map((command) => command.command)).toEqual(['ccPortalLauncher.showSettings']);
    });

    test('rejects unknown settings and invalid display values', async () => {
        await receive({ type: 'setting', key: 'other.setting', value: 'compact' });
        await receive({ type: 'setting', key: 'presets.displayMode', value: 'invalid' });
        expect(mocks.update).not.toHaveBeenCalled();
    });

    test('the last-configuration context menu opens the existing wizard and can save without launching', async () => {
        mocks.finish = 'save';
        await mocks.commands.get('ccPortalLauncher.configuration.edit')();
        expect(mocks.pickers[0].initialSelectedValues).toEqual(['sso']);
        expect(storage.get('ccPortalLauncher.presets').find((preset) => preset.id === 'daily-updated').selection.portals).toEqual(['coordinator']);
        expect(client.request).not.toHaveBeenCalled();
        expect(client.close).toHaveBeenCalledOnce();
    });

    test('confirmed reset restores the fresh-user dashboard without affecting unrelated state or launching', async () => {
        mocks.mode = 'compact';
        storage.set('other.extension', { keep: true });
        mocks.warning.mockResolvedValueOnce('Reset to defaults');
        await receive({ type: 'command', command: 'resetDefaults' });
        expect(mocks.warning).toHaveBeenCalledWith(
            expect.stringContaining('custom presets and launch history'), { modal: true }, 'Reset to defaults',
        );
        expect(storage.has('ccPortalLauncher.presets')).toBe(false);
        expect(storage.has('ccPortalLauncher.usage')).toBe(false);
        expect(storage.get('other.extension')).toEqual({ keep: true });
        expect(mocks.update).toHaveBeenCalledExactlyOnceWith('presets.displayMode', undefined, 1);
        expect(api.dashboard).toMatchObject({ phase: 'idle', presetDisplay: 'full', hasLaunched: false, lastUsedId: null });
        expect(api.dashboard.presets).toHaveLength(3);
        expect(api.dashboard.presets.every((preset) => preset.kind === 'canned' && preset.lastUsedAt === null)).toBe(true);
        expect(posted).toHaveBeenLastCalledWith({ type: 'reset', view: api.dashboard });
        expect(mocks.connect).not.toHaveBeenCalled();
    });

    test('cancelling reset keeps presets, history, and display preference', async () => {
        mocks.mode = 'compact';
        mocks.warning.mockResolvedValueOnce(undefined);
        await receive({ type: 'command', command: 'resetDefaults' });
        expect(storage.get('ccPortalLauncher.presets')).toEqual([PRESET]);
        expect(storage.get('ccPortalLauncher.usage').last.presetId).toBe('daily');
        expect(mocks.update).not.toHaveBeenCalled();
        expect(posted).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'reset' }));
        expect(mocks.connect).not.toHaveBeenCalled();
    });

    test('reset is blocked during an active session and rechecks after confirmation', async () => {
        mocks.warning.mockImplementationOnce(async () => {
            await receive({ type: 'preset', presetId: 'daily', action: 'launch' });
            return 'Reset to defaults';
        });
        await receive({ type: 'command', command: 'resetDefaults' });
        expect(mocks.error).toHaveBeenCalledWith('Stop the current session and close configuration before resetting defaults.');
        expect(storage.get('ccPortalLauncher.presets')).toEqual([PRESET]);
        expect(storage.get('ccPortalLauncher.usage').last.presetId).toBe('daily');
        expect(mocks.update).not.toHaveBeenCalled();
        expect(client.shutdown).not.toHaveBeenCalled();
        expect(api.phase).toBe('running');
        mocks.warning.mockClear();
        await receive({ type: 'command', command: 'resetDefaults' });
        expect(mocks.warning).not.toHaveBeenCalled();
    });

    test('edits a preset without launching or leaving a duplicate, preserving its history', async () => {
        await receive({ type: 'preset', presetId: 'daily', action: 'edit' });
        const presets = storage.get('ccPortalLauncher.presets');
        expect(presets).toHaveLength(1);
        expect(presets[0]).toMatchObject({
            id: 'daily-updated', name: 'Daily updated',
            selection: { portals: ['coordinator'] }, summary: 'Coordinator · Dev API',
        });
        expect(storage.get('ccPortalLauncher.usage')).toEqual({
            last: { presetId: 'daily-updated', at: 10 }, used: { 'daily-updated': 10 },
        });
        expect(mocks.pickers.at(-1).activeItems[0].value).toBe('save');
        expect(client.request).not.toHaveBeenCalled();
        expect(client.close).toHaveBeenCalledOnce();
        expect(api.phase).toBe('idle');
    });

    test('copies edited built-in presets instead of replacing them', async () => {
        await receive({ type: 'preset', presetId: 'builtin-all-dev-api', action: 'edit' });
        expect(storage.get('ccPortalLauncher.presets')).toHaveLength(2);
        expect(api.dashboard.presets.find((preset) => preset.id === 'builtin-all-dev-api').kind).toBe('canned');
        expect(client.request).not.toHaveBeenCalled();
    });

    test('cancelling the nickname leaves the preset unchanged and closes the idle host', async () => {
        mocks.input.mockResolvedValueOnce(undefined);
        await receive({ type: 'preset', presetId: 'daily', action: 'edit' });
        expect(storage.get('ccPortalLauncher.presets')).toEqual([PRESET]);
        expect(client.close).toHaveBeenCalledOnce();
    });

    test('deletes custom presets after confirmation and forgets their usage', async () => {
        await receive({ type: 'preset', presetId: 'daily', action: 'delete' });
        expect(mocks.warning).toHaveBeenCalledWith('Delete the preset "Daily"?', { modal: true }, 'Delete');
        expect(storage.get('ccPortalLauncher.presets')).toEqual([]);
        expect(storage.get('ccPortalLauncher.usage')).toEqual({ last: { presetId: null, at: 10 }, used: {} });
        expect(mocks.connect).not.toHaveBeenCalled();
    });

    test('cancelling deletion keeps the preset and built-ins cannot be deleted', async () => {
        mocks.warning.mockResolvedValueOnce(undefined);
        await receive({ type: 'preset', presetId: 'daily', action: 'delete' });
        await receive({ type: 'preset', presetId: 'builtin-all-dev-api', action: 'delete' });
        expect(storage.get('ccPortalLauncher.presets')).toEqual([PRESET]);
        expect(mocks.error).toHaveBeenCalledWith('Starter presets cannot be renamed or deleted.');
    });

    test('launch buttons still launch the requested preset', async () => {
        await receive({ type: 'preset', presetId: 'daily', action: 'launch' });
        expect(client.request).toHaveBeenCalledWith('command.launch', { source: 'selection', selection: SELECTION });
        expect(api.phase).toBe('running');
    });

    test('unnamed saved launches show a host-derived name and retain it after restarting the extension', async () => {
        await receive({ type: 'command', command: 'launchSaved' });
        expect(client.request).toHaveBeenCalledWith('command.launch', { source: 'saved' });
        expect(api.dashboard.session.name).toBe('SSO · Dev API');
        expect(storage.get('ccPortalLauncher.usage').last).toMatchObject({
            presetId: null, name: 'SSO · Dev API', summary: 'SSO · Dev API',
        });
        await deactivate();
        const reopened = await activate(context);
        expect(reopened.dashboard).toMatchObject({
            phase: 'idle', lastUsedId: null,
            lastConfiguration: { name: 'SSO · Dev API', summary: 'SSO · Dev API' },
        });
        expect(mocks.connect).toHaveBeenCalledOnce();
    });

    test('unsaved configurations get a descriptive name rather than a generic saved label', async () => {
        mocks.finish = 'launch';
        await receive({ type: 'command', command: 'configure' });
        expect(api.dashboard.session.name).toBe('Coordinator · Dev API');
        expect(storage.get('ccPortalLauncher.usage').last).toMatchObject({
            presetId: null, name: 'Coordinator · Dev API', summary: 'Coordinator · Dev API',
        });
    });

    test('last-used configuration keeps its nickname and details after deleting its preset', async () => {
        await receive({ type: 'preset', presetId: 'daily', action: 'launch' });
        await deactivate();
        await receive({ type: 'preset', presetId: 'daily', action: 'delete' });
        expect(api.dashboard).toMatchObject({
            phase: 'idle', lastUsedId: null,
            lastConfiguration: { name: 'Daily', summary: 'SSO · Dev API' },
        });
    });

    test('the session gear edits the active selection without stopping when application is cancelled', async () => {
        client.session.initialSelection = { ...SELECTION, portals: ['coordinator'] };
        await receive({ type: 'preset', presetId: 'daily', action: 'launch' });
        mocks.warning.mockResolvedValueOnce(undefined);
        client.request.mockClear();
        await receive({ type: 'command', command: 'editSession' });
        expect(mocks.pickers[0].initialSelectedValues).toEqual(['sso']);
        expect(mocks.pickers[0].title).toContain('Edit session configuration');
        expect(mocks.warning).toHaveBeenCalledWith(
            'Applying this configuration will stop the current session and launch it again.',
            { modal: true },
            'Apply and relaunch',
        );
        expect(client.shutdown).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(api.phase).toBe('running');
    });

    test('can save an edited session as a preset without stopping the session', async () => {
        await receive({ type: 'preset', presetId: 'daily', action: 'launch' });
        mocks.finish = 'save';
        client.request.mockClear();
        await receive({ type: 'command', command: 'editSession' });
        expect(storage.get('ccPortalLauncher.presets').find((preset) => preset.id === 'daily-updated').selection.portals).toEqual(['coordinator']);
        expect(client.shutdown).not.toHaveBeenCalled();
        expect(client.request).not.toHaveBeenCalled();
        expect(api.phase).toBe('running');
    });

    test('applies edited session configuration by shutting down before relaunching', async () => {
        await receive({ type: 'preset', presetId: 'daily', action: 'launch' });
        const replacementExit = Promise.withResolvers();
        const replacement = {
            ...client,
            exitPromise: replacementExit.promise,
            request: vi.fn().mockResolvedValue({}),
            close: vi.fn(() => replacementExit.resolve(0)),
            shutdown: vi.fn(async () => replacementExit.resolve(0)),
        };
        mocks.connect.mockResolvedValueOnce(replacement);
        mocks.warning.mockResolvedValueOnce('Apply and relaunch');
        await receive({ type: 'command', command: 'editSession' });
        expect(client.shutdown).toHaveBeenCalledWith('quit', 'Configuration changed from VS Code');
        expect(replacement.request).toHaveBeenCalledWith('command.launch', {
            source: 'selection', selection: expect.objectContaining({ portals: ['coordinator'] }),
        });
        expect(client.shutdown.mock.invocationCallOrder[0]).toBeLessThan(replacement.request.mock.invocationCallOrder[0]);
        expect(storage.get('ccPortalLauncher.presets')).toEqual([PRESET]);
        expect(storage.get('ccPortalLauncher.usage').last.presetId).toBeNull();
        expect(api.phase).toBe('running');
    });
});

describe('dashboard settings and action routing', () => {
    const script = readFileSync(new URL('../resources/webview/dashboard.js', import.meta.url), 'utf8');

    function renderDashboard(phase, ui = {}) {
        const messages = [];
        const listeners = {};
        const saved = vi.fn();
        const app = { innerHTML: '', querySelector: () => null, addEventListener: (event, handler) => { listeners[event] = handler; } };
        class Button {
            dataset = { command: 'editSession' };
            closest() { return this; }
        }
        runInNewContext(script, {
            document: { getElementById: () => app, body: { setAttribute() {} } },
            window: { addEventListener: (event, handler) => { listeners[event] = handler; } },
            Element: Button,
            setInterval() {},
            acquireVsCodeApi: () => ({
                getState: () => ({ view: { phase, presets: [], groups: [], session: { name: 'Daily', label: 'Ready' } }, ui }),
                setState: saved,
                postMessage: (message) => messages.push(message),
            }),
        });
        return {
            app, messages, saved,
            click: (dataset) => listeners.click({ target: Object.assign(new Button(), { dataset }) }),
            message: (data) => listeners.message({ data }),
        };
    }

    test('the running-session edit icon still opens the configuration editor', () => {
        const { app, messages, click } = renderDashboard('running');
        expect(app.innerHTML).toContain('data-command="editSession"');
        expect(app.innerHTML).toContain('title="Edit session configuration"');
        expect(app.innerHTML).toContain('codicon-edit');
        expect(app.innerHTML).not.toContain('codicon-settings-gear');
        expect(app.innerHTML).not.toContain('data-page="settings"');
        click({ command: 'editSession' });
        expect(messages.at(-1)).toEqual({ type: 'command', command: 'editSession' });
    });

    test('the dashboard has no redundant settings gear and the session editor is disabled during startup', () => {
        const { app } = renderDashboard('idle');
        expect(app.innerHTML).not.toContain('data-page="settings"');
        expect(app.innerHTML).not.toContain('codicon-settings-gear');
        expect(app.innerHTML).toMatch(/data-command="configure"><i class="codicon codicon-add"/);
        expect(renderDashboard('launching').app.innerHTML).toMatch(/data-command="editSession"[^>]* disabled/);
    });

    test.each(['idle', 'launching', 'running'])('title-bar settings navigation preserves display options, cached filters, and back navigation (%s)', (phase) => {
        const { app, message, click, saved, messages } = renderDashboard(phase, { query: 'Daily', filter: 'recent' });
        const state = { phase, presets: [], groups: [], session: { name: 'Daily', label: 'Ready' }, presetDisplay: 'compact' };
        message({ type: 'settings', view: state });
        expect(app.innerHTML).toContain('<h2>Preset settings</h2>');
        expect(app.innerHTML).toContain('aria-label="Preset display"');
        expect(app.innerHTML).toContain('data-display-mode="compact" aria-pressed="true"');
        expect(app.innerHTML).toContain('data-command="resetDefaults"');
        expect(app.innerHTML).not.toContain('codicon-settings-gear');
        click({ displayMode: 'full' });
        expect(messages.at(-1)).toEqual({ type: 'setting', key: 'presets.displayMode', value: 'full' });
        message({ type: 'render', view: { ...state, presetDisplay: 'full' } });
        expect(app.innerHTML).toContain('<h2>Preset settings</h2>');
        click({ page: 'dashboard' });
        expect(app.innerHTML).not.toContain('<h2>Preset settings</h2>');
        expect(app.innerHTML).toContain(phase === 'idle' ? 'data-command="configure"' : 'data-command="editSession"');
        expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ ui: { page: 'dashboard', query: 'Daily', filter: 'recent' } }));
    });

    test.each(['full', 'compact'])('launch cards have no inline edit control but preserve preset context menus in %s display', (presetDisplay) => {
        const { app, message, messages, click } = renderDashboard('idle');
        const presets = [
            { id: 'daily', name: 'Daily', summary: 'SSO', kind: 'custom' },
            { id: 'starter', name: 'All portals', summary: 'Dev API', kind: 'canned' },
        ];
        message({ type: 'render', view: { phase: 'idle', presets, lastUsedId: 'daily', hasLaunched: true, presetDisplay } });
        expect([...app.innerHTML.matchAll(/data-preset-action="launch"/g)]).toHaveLength(2);
        expect(app.innerHTML).not.toContain('data-preset-action="edit"');
        expect(app.innerHTML).not.toContain('codicon-edit');
        expect(app.innerHTML).toContain('&#34;presetId&#34;:&#34;daily&#34;');
        expect(app.innerHTML).toContain('&#34;presetId&#34;:&#34;starter&#34;');
        expect(app.innerHTML).toContain('&#34;ccBuiltIn&#34;:true');
        click({ preset: 'daily', presetAction: 'launch' });
        expect(messages.at(-1)).toEqual({ type: 'preset', presetId: 'daily', action: 'launch' });
    });

    test('settings retain edit and delete controls while right-click Edit remains contributed for all launch cards', () => {
        const { app, message } = renderDashboard('idle', { page: 'settings' });
        message({ type: 'render', view: { phase: 'idle', presets: [{ id: 'daily', name: 'Daily', summary: 'SSO', kind: 'custom' }] } });
        expect(app.innerHTML).toContain('data-preset-action="edit"');
        expect(app.innerHTML).toContain('data-preset-action="delete"');
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const menu = manifest.contributes.menus['webview/context'];
        expect(menu).toContainEqual(expect.objectContaining({
            command: 'ccPortalLauncher.preset.edit',
            when: "webviewId == 'ccPortalLauncher.dashboard' && ccSection == 'preset'",
        }));
        expect(menu).toContainEqual(expect.objectContaining({
            command: 'ccPortalLauncher.configuration.edit',
            when: "webviewId == 'ccPortalLauncher.dashboard' && ccSection == 'configuration'",
        }));
    });

    test.each([false, true])('shows helper text without a last-used placeholder when no launch item exists (history flag: %s)', (hasLaunched) => {
        const { app, message } = renderDashboard('idle');
        message({ type: 'render', view: {
            phase: 'idle', hasLaunched, lastUsedId: null, lastConfiguration: null,
            presets: [{ id: 'starter', name: 'All portals', summary: 'Dev API', kind: 'canned', lastUsedAt: null }],
        } });
        expect(app.innerHTML).toContain('<ol class="help">');
        expect(app.innerHTML).toContain('Launch a <b>canned</b> preset');
        expect(app.innerHTML).not.toContain('<span>Last used</span>');
        expect(app.innerHTML).not.toContain('<span>Get started</span>');
        expect(app.innerHTML).not.toContain('preset default');
        expect(app.innerHTML).not.toContain('data-command="launchSaved"');
        expect(app.innerHTML).toContain('data-command="configure"');
        expect(app.innerHTML).toContain('All portals</span>');
    });

    test('shows last used only after an actual configuration is available', () => {
        const { app, message } = renderDashboard('idle');
        message({ type: 'render', view: {
            phase: 'idle', hasLaunched: true, presets: [],
            lastConfiguration: { name: 'Daily', summary: 'SSO' },
        } });
        expect(app.innerHTML).toContain('<span>Last used</span>');
        expect(app.innerHTML).toContain('Daily</span>');
        expect(app.innerHTML).not.toContain('<ol class="help">');
        message({ type: 'render', view: {
            phase: 'idle', hasLaunched: true, lastUsedId: 'daily',
            presets: [{ id: 'daily', name: 'Daily', summary: 'SSO', kind: 'custom' }],
        } });
        expect(app.innerHTML).toContain('<span>Last used</span>');
        expect(app.innerHTML).toContain('data-preset="daily"');
        expect(app.innerHTML).not.toContain('<ol class="help">');
    });

    test('last-used cards render the configuration name and summary in full and compact modes', () => {
        const { app, message } = renderDashboard('idle');
        const state = {
            phase: 'idle', presets: [], hasLaunched: true,
            lastConfiguration: { name: 'Patients & API', summary: 'Tasks <watch>' },
        };
        message({ type: 'render', view: { ...state, presetDisplay: 'full' } });
        expect(app.innerHTML).toContain('Patients &#38; API</span>');
        expect(app.innerHTML).toContain('<span class="sub">Tasks &#60;watch&#62;</span>');
        expect(app.innerHTML).toContain('aria-label="Launch Patients &#38; API"');
        expect(app.innerHTML).not.toContain('Saved configuration');
        expect(app.innerHTML).not.toContain('codicon-edit');
        expect(app.innerHTML).toContain('&#34;ccSection&#34;:&#34;configuration&#34;');
        message({ type: 'render', view: { ...state, presetDisplay: 'compact' } });
        expect(app.innerHTML).toContain('title="Tasks &#60;watch&#62;" tabindex="0">Patients &#38; API</span>');
        expect(app.innerHTML).not.toContain('<span class="sub">');
        expect(app.innerHTML).toContain('data-command="launchSaved"');
        expect(app.innerHTML).not.toContain('codicon-edit');
        expect(app.innerHTML).toContain('&#34;ccSection&#34;:&#34;configuration&#34;');
    });

    test('reset in settings routes to the controller and clears cached navigation, search, and filters', () => {
        const { app, messages, saved, click, message } = renderDashboard('idle', { page: 'settings', query: 'Daily', filter: 'recent' });
        expect(app.innerHTML).toContain('data-command="resetDefaults"');
        expect(app.innerHTML).toContain('codicon-discard');
        click({ command: 'resetDefaults' });
        expect(messages.at(-1)).toEqual({ type: 'command', command: 'resetDefaults' });
        message({ type: 'reset', view: { phase: 'idle', presets: [], presetDisplay: 'full', hasLaunched: false } });
        expect(app.innerHTML).toContain('<ol class="help">');
        expect(app.innerHTML).not.toContain('<span>Last used</span>');
        expect(app.innerHTML).not.toContain('data-command="resetDefaults"');
        expect(saved).toHaveBeenLastCalledWith(expect.objectContaining({ ui: { page: 'dashboard', query: '', filter: '' } }));
        const restored = renderDashboard('idle', saved.mock.calls.at(-1)[0].ui);
        expect(restored.app.innerHTML).toContain('<ol class="help">');
        expect(restored.app.innerHTML).not.toContain('<span>Last used</span>');
        expect(renderDashboard('running', { page: 'settings' }).app.innerHTML).toMatch(/data-command="resetDefaults"[^>]* disabled/);
    });
});