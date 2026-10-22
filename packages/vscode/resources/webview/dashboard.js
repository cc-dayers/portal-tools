(() => {
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    let view = null;
    const DEFAULT_UI = { query: '', filter: '', page: 'dashboard' };
    let ui = { ...DEFAULT_UI };

    const FILTERS = [
        { id: 'recent', label: 'Recent' },
        { id: 'custom', label: 'Custom' },
        { id: 'canned', label: 'Canned' },
    ];

    // Codicon names, so the dashboard uses the same icon set as the rest of VS Code.
    const ICONS = {
        play: 'play',
        stop: 'debug-stop',
        restart: 'debug-restart',
        open: 'link-external',
        logs: 'output',
        plus: 'add',
        rocket: 'rocket',
        edit: 'edit',
        delete: 'trash',
        back: 'arrow-left',
        reset: 'discard',
        lock: 'lock',
        person: 'account',
    };
    const ACTION_META = {
        open: { icon: 'open', title: 'Open in browser' },
        restart: { icon: 'restart', title: 'Restart' },
        stop: { icon: 'stop', title: 'Stop' },
        start: { icon: 'play', title: 'Start' },
        logs: { icon: 'logs', title: 'Show logs' },
    };

    const icon = (name) => `<i class="codicon codicon-${ICONS[name]}" aria-hidden="true"></i>`;
    const escape = (value) =>
        String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    // Native webview/context menus read this attribute; keys are matched by `when` clauses in package.json.
    const menuContext = (context) =>
        `data-vscode-context="${escape(JSON.stringify({ ...context, preventDefaultContextMenuItems: true }))}"`;

    function duration(ms) {
        if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
        const seconds = Math.round(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
    }

    function clock(ms) {
        const seconds = Math.max(0, Math.floor(ms / 1000));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function subText(target) {
        switch (target.status) {
            case 'ready':
                if (target.adopted) return 'already running';
                return target.readyAt && target.startedAt
                    ? `ready in ${duration(target.readyAt - target.startedAt)}`
                    : 'ready';
            case 'starting':
            case 'restarting':
                return target.startedAt
                    ? `${target.status} · <span data-since="${target.startedAt}">${clock(Date.now() - target.startedAt)}</span>`
                    : `${target.status}…`;
            case 'rebuilding':
                return target.lastRebuildDurationMs
                    ? `rebuilding · last ${duration(target.lastRebuildDurationMs)}`
                    : 'rebuilding';
            case 'stopping':
                return 'stopping…';
            default:
                return escape(target.status);
        }
    }

    function card(target) {
        const acts = target.actions
            .map((action) => {
                const meta = ACTION_META[action];
                const label = `${meta.title} ${target.label}`;
                return `<button class="ibtn" data-key="t:${escape(target.id)}:${action}" data-target="${escape(target.id)}" data-action="${action}" title="${meta.title}" aria-label="${escape(label)}">${icon(meta.icon)}</button>`;
            })
            .join('');
        const port = target.port ? `<span class="port">:${escape(target.port)}</span>` : '';
        const watch = target.watch ? '<span class="tag">hot reload</span>' : '';
        const adopted = target.adopted ? '<span class="tag muted">external</span>' : '';
        const failure =
            target.status === 'failed' && target.failureReason
                ? `<div class="fail">${escape(target.failureReason)}</div>`
                : '';
        const context = menuContext({ ccSection: 'target', targetId: target.id, ccActions: target.actions.join(' ') });
        return `<div class="card" data-s="${escape(target.status)}" ${context}>
            <span class="dot" aria-hidden="true"></span>
            <span class="name">${escape(target.label)}${port}${watch}${adopted}</span>
            <span class="sub">${subText(target)}</span>
            <span class="acts">${acts}</span>${failure}<span class="bar" aria-hidden="true"></span>
        </div>`;
    }

    function commandButton(command, label, { primary = false, disabled = false } = {}) {
        return `<button class="btn${primary ? ' primary' : ''}" data-key="c:${command}" data-command="${command}"${disabled ? ' disabled' : ''}>${escape(label)}</button>`;
    }

    function errorBanner(error) {
        return error ? `<div class="error" role="alert">${escape(error)}</div>` : '';
    }

    function kindTag(kind) {
        return kind === 'canned'
            ? `<span class="tag muted" title="Built-in starter. Edit and launch to save your own copy.">${icon('lock')}Canned</span>`
            : `<span class="tag custom" title="Saved by you">${icon('person')}Custom</span>`;
    }

    function presetCard(preset, { pinned = false } = {}) {
        const builtIn = preset.kind === 'canned';
        const compact = view?.presetDisplay === 'compact';
        return `<div class="preset${pinned ? ' default' : ''}${compact ? ' compact' : ''}" ${menuContext({ ccSection: 'preset', presetId: preset.id, ccBuiltIn: builtIn })}>
            <span class="p-name"${compact ? ` title="${escape(preset.summary)}" tabindex="0"` : ''}>${escape(preset.name)}</span>
            ${compact ? '' : kindTag(preset.kind)}
            ${compact ? '' : `<span class="sub">${escape(preset.summary)}</span>`}
            <span class="acts">
                ${presetAction(preset, 'launch', 'rocket', 'Launch', { compact, primary: pinned })}
            </span>
        </div>`;
    }

    function presetAction(preset, action, glyph, label, { compact, primary = false }) {
        const disabled = action === 'edit' && view?.phase !== 'idle';
        return `<button class="${compact ? 'ibtn' : 'btn'}${primary ? ' primary' : ''}" data-key="p:${escape(preset.id)}:${action}" data-preset="${escape(preset.id)}" data-preset-action="${action}" title="${disabled ? 'Stop the current session before editing' : `${label} ${escape(preset.name)}`}" aria-label="${label} ${escape(preset.name)}"${disabled ? ' disabled' : ''}>${icon(glyph)}${compact ? '' : escape(label)}</button>`;
    }

    function lastConfigurationCard(state) {
        const compact = view?.presetDisplay === 'compact';
        const { name = 'Last launch', summary = '' } = state.lastConfiguration ?? {};
        return `<div class="preset default${compact ? ' compact' : ''}" ${menuContext({ ccSection: 'configuration' })}>
            <span class="p-name" title="${escape(summary || name)}"${compact ? ' tabindex="0"' : ''}>${escape(name)}</span>
            ${compact || !summary || summary === name ? '' : `<span class="sub">${escape(summary)}</span>`}
            <span class="acts">
                <button class="${compact ? 'ibtn' : 'btn'} primary" data-key="c:launchSaved" data-command="launchSaved" title="Launch ${escape(name)}" aria-label="Launch ${escape(name)}">${icon('rocket')}${compact ? '' : 'Launch'}</button>
            </span>
        </div>`;
    }

    function renderPresetSettings(state) {
        const presets = state.presets.filter((preset) => preset.kind === 'custom');
        return `${errorBanner(state.error)}
            <div class="section">
                <div class="settings-head"><button class="ibtn" data-key="nav:dashboard" data-page="dashboard" title="Back to dashboard" aria-label="Back to dashboard">${icon('back')}</button><h2>Preset settings</h2></div>
                <div class="setting-row"><span>Display</span><div class="display-modes" role="group" aria-label="Preset display">
                    ${['compact', 'full'].map((mode) => `<button data-key="display:${mode}" data-display-mode="${mode}" aria-pressed="${(state.presetDisplay ?? 'full') === mode}">${mode === 'compact' ? 'Compact' : 'Full'}</button>`).join('')}
                </div></div>
            </div>
            <div class="section">
                <div class="section-head"><span>Custom presets</span><span class="count">${presets.length}</span></div>
                <div class="list">${presets.length ? presets.map((preset) => `<div class="managed-preset"><span class="p-name" title="${escape(preset.summary)}">${escape(preset.name)}</span><span class="acts">
                    ${presetAction(preset, 'edit', 'edit', 'Edit', { compact: true })}
                    ${presetAction(preset, 'delete', 'delete', 'Delete', { compact: true })}
                </span></div>`).join('') : '<p class="empty">No custom presets.</p>'}</div>
            </div>
            <div class="section">
                <div class="setting-row"><span>Defaults</span><button class="btn" data-key="c:resetDefaults" data-command="resetDefaults" title="Reset to defaults"${state.phase === 'idle' ? '' : ' disabled'}>${icon('reset')}Reset to defaults</button></div>
            </div>`;
    }

    function visiblePresets(state) {
        const query = ui.query.trim().toLowerCase();
        return state.presets.filter((preset) => {
            if (preset.id === state.lastUsedId) return false;
            if (ui.filter === 'recent' && preset.lastUsedAt === null) return false;
            if ((ui.filter === 'custom' || ui.filter === 'canned') && preset.kind !== ui.filter) return false;
            return !query || `${preset.name} ${preset.summary}`.toLowerCase().includes(query);
        });
    }

    function presetListHtml(state) {
        const visible = visiblePresets(state);
        if (visible.length > 0) return visible.map((preset) => presetCard(preset)).join('');
        const none = ui.filter === 'custom' && !ui.query && !state.presets.some((preset) => preset.kind === 'custom');
        return `<p class="empty">${
            none
                ? 'Save a running session from the title bar, or choose "Save as preset" at the end of Configure.'
                : 'No presets match.'
        }</p>`;
    }

    function gettingStarted() {
        return `<ol class="help">
            <li>Launch a <b>canned</b> preset below to start right away.</li>
            <li>Or choose <b>Configure new launch…</b> to pick portals and backend modules, then save it as a <b>custom</b> preset.</li>
            <li>Your latest launch is pinned here so you can run it again in one click.</li>
        </ol>`;
    }

    function renderIdle(state) {
        const last = state.presets.find((preset) => preset.id === state.lastUsedId);
        const hasLast = Boolean(last || (state.hasLaunched && state.lastConfiguration));
        const pills = FILTERS.map(
            ({ id, label }) =>
                `<button class="pill" data-key="f:${id}" data-filter="${id}" aria-pressed="${ui.filter === id}">${label}</button>`,
        ).join('');

        return `${errorBanner(state.error)}
            <div class="section">
                ${hasLast ? `<div class="section-head"><span>Last used</span></div>${last ? presetCard(last, { pinned: true }) : lastConfigurationCard(state)}` : gettingStarted()}
                <button class="add" data-key="c:configure" data-command="configure">${icon('plus')}Configure new launch…</button>
            </div>
            <div class="section">
                <div class="section-head"><span>Presets</span><span class="count">${state.presets.length}</span></div>
                <input class="search" type="search" data-key="search" placeholder="Search presets" aria-label="Search presets" value="${escape(ui.query)}">
                <div class="pills" role="group" aria-label="Filter presets">${pills}</div>
                <div class="list" id="preset-list">${presetListHtml(state)}</div>
            </div>`;
    }

    function renderSession(state) {
        if (state.phase === 'disconnected') {
            return `${errorBanner(state.error)}
                <div class="panel">
                    <div class="panel-top"><span class="panel-name">Launcher disconnected</span></div>
                    <p>Processes may still be running. Reconnect to restore live status and controls.</p>
                    <div class="row">
                        ${commandButton('reconnect', 'Reconnect')}
                        ${commandButton('forgetSession', 'Forget session')}
                    </div>
                </div>`;
        }
        const { session } = state;
        const running = state.phase === 'running' && !session.isShuttingDown;
        const targets = state.groups.flatMap((group) => group.targets);
        const busy = state.phase !== 'running' || session.isShuttingDown;
        const groups = state.groups
            .filter((group) => group.id === 'frontend' || group.targets.length > 0 || state.canAddBackend)
            .map((group) => {
                const add =
                    group.id === 'backend'
                        ? `<button class="add" data-key="c:addBackend" data-command="addBackend"${state.canAddBackend ? '' : ' disabled'}>${icon('plus')}Add backend module</button>`
                        : `<button class="add" disabled title="The launcher can only add portals by relaunching.">${icon('plus')}Add portal (relaunch)</button>`;
                return `<div class="section">
                    <div class="section-head"><span>${escape(group.label)}</span><span class="count">${group.targets.length}</span></div>
                    <div class="cards">${group.targets.map(card).join('')}</div>
                    ${add}
                </div>`;
            })
            .join('');

        return `${errorBanner(state.error)}
            <div class="panel${busy ? ' busy' : ''}">
                <div class="panel-top">
                    <span class="panel-name">${escape(session.name)}</span>
                    <span class="head-actions"><span class="meta" role="status">${escape(session.label)}</span><button class="ibtn" data-key="c:editSession" data-command="editSession" title="Edit session configuration" aria-label="Edit session configuration"${running ? '' : ' disabled'}>${icon('edit')}</button></span>
                </div>
                <div class="segbar" aria-hidden="true">${targets.map((target) => `<i data-s="${escape(target.status)}"></i>`).join('')}</div>
                <div class="row">
                    ${commandButton('restartAll', 'Restart all', { disabled: !running })}
                    ${commandButton('stopAll', session.isShuttingDown ? 'Stopping…' : 'Stop all', { disabled: !running })}
                </div>
                ${busy ? '<span class="bar" aria-hidden="true"></span>' : ''}
            </div>
            ${groups}`;
    }

    function render() {
        if (!view) return;
        const focusedKey = document.activeElement?.getAttribute('data-key');
        app.innerHTML = ui.page === 'settings' ? renderPresetSettings(view) : view.phase === 'idle' ? renderIdle(view) : renderSession(view);
        if (focusedKey) {
            const focused = app.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
            focused?.focus();
            if (focused instanceof HTMLInputElement) focused.setSelectionRange(focused.value.length, focused.value.length);
        }
    }

    const saveState = () => vscode.setState({ view, ui });

    app.addEventListener('input', (event) => {
        if (!(event.target instanceof HTMLInputElement) || !event.target.classList.contains('search')) return;
        ui = { ...ui, query: event.target.value };
        saveState();
        const list = document.getElementById('preset-list');
        if (list && view) list.innerHTML = presetListHtml(view);
    });

    app.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (!button || button.disabled) return;
        if (button.dataset.filter) {
            ui = { ...ui, filter: ui.filter === button.dataset.filter ? '' : button.dataset.filter };
            saveState();
            render();
        } else if (button.dataset.page) {
            ui = { ...ui, page: button.dataset.page };
            saveState();
            render();
            app.querySelector(`[data-page="${ui.page === 'settings' ? 'dashboard' : 'settings'}"]`)?.focus();
        } else if (button.dataset.displayMode) {
            vscode.postMessage({ type: 'setting', key: 'presets.displayMode', value: button.dataset.displayMode });
        } else if (button.dataset.target) {
            vscode.postMessage({ type: 'target', targetId: button.dataset.target, action: button.dataset.action });
        } else if (button.dataset.command) {
            vscode.postMessage({ type: 'command', command: button.dataset.command });
        } else if (button.dataset.preset) {
            vscode.postMessage({ type: 'preset', presetId: button.dataset.preset, action: button.dataset.presetAction });
        }
    });

    window.addEventListener('message', (event) => {
        if (!['render', 'reset', 'settings'].includes(event.data?.type)) return;
        if (event.data.type === 'reset') ui = { ...DEFAULT_UI };
        if (event.data.type === 'settings') ui = { ...ui, page: 'settings' };
        view = event.data.view;
        saveState();
        render();
    });

    setInterval(() => {
        for (const element of app.querySelectorAll('[data-since]')) {
            element.textContent = clock(Date.now() - Number(element.getAttribute('data-since')));
        }
    }, 1000);

    document.body.setAttribute('data-vscode-context', JSON.stringify({ preventDefaultContextMenuItems: true }));
    view = vscode.getState()?.view ?? null;
    ui = { ...ui, ...vscode.getState()?.ui };
    render();
    vscode.postMessage({ type: 'ready' });
})();
