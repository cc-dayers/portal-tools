(() => {
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    let view = null;

    // Codicon names, so the dashboard uses the same icon set as the rest of VS Code.
    const ICONS = {
        play: 'play',
        stop: 'debug-stop',
        restart: 'debug-restart',
        open: 'link-external',
        logs: 'output',
        plus: 'add',
        gear: 'settings-gear',
        more: 'ellipsis',
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

    function presetCard(preset, builtIn) {
        return `<div class="preset" ${menuContext({ ccSection: 'preset', presetId: preset.id, ccBuiltIn: builtIn })}>
            <span class="p-name">${escape(preset.name)}</span>
            <span class="sub">${escape(preset.summary)}</span>
            <span class="acts">
                <button class="btn" data-key="p:${escape(preset.id)}:launch" data-preset="${escape(preset.id)}" data-preset-action="launch">Launch</button>
                <button class="ibtn" data-key="p:${escape(preset.id)}:menu" data-preset="${escape(preset.id)}" data-menu title="More actions" aria-label="More actions for ${escape(preset.name)}">${icon('more')}</button>
            </span>
        </div>`;
    }

    function renderIdle(state) {
        const saved = state.presets.length
            ? state.presets.map((preset) => presetCard(preset, false)).join('')
            : '<p class="empty">Save a running session from the title bar, or choose "Save as preset" at the end of Configure.</p>';

        return `${errorBanner(state.error)}
            <div class="section">
                <div class="section-head"><span>Launch</span></div>
                <div class="preset default">
                    <span class="p-name">Saved configuration</span>
                    <span class="sub">The setup the launcher used last</span>
                    <span class="acts">${commandButton('launchSaved', 'Launch', { primary: true })}</span>
                </div>
                <button class="add" data-key="c:configure" data-command="configure">${icon('gear')}Configure new launch…</button>
            </div>
            <div class="section">
                <div class="section-head"><span>Starter presets</span></div>
                ${state.starters.map((preset) => presetCard(preset, true)).join('')}
            </div>
            <div class="section">
                <div class="section-head"><span>Your presets</span><span class="count">${state.presets.length || ''}</span></div>
                ${saved}
            </div>`;
    }

    function renderSession(state) {
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
                    <span class="meta" role="status">${escape(session.label)}</span>
                </div>
                <div class="segbar" aria-hidden="true">${targets.map((target) => `<i data-s="${escape(target.status)}"></i>`).join('')}</div>
                <div class="row">
                    ${commandButton('restartAll', 'Restart all', { disabled: !running })}
                    ${commandButton('stopAll', session.isShuttingDown ? 'Stopping…' : 'Stop all', { disabled: session.isShuttingDown })}
                </div>
                ${busy ? '<span class="bar" aria-hidden="true"></span>' : ''}
            </div>
            ${groups}`;
    }

    function render() {
        if (!view) return;
        const focusedKey = document.activeElement?.getAttribute('data-key');
        app.innerHTML = view.phase === 'idle' ? renderIdle(view) : renderSession(view);
        if (focusedKey) app.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
    }

    app.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-menu')) {
            // Opens the native context menu for the enclosing preset, as the webview guide recommends for split buttons.
            const rect = button.getBoundingClientRect();
            button.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left, clientY: rect.bottom }),
            );
            event.stopPropagation();
        } else if (button.dataset.target) {
            vscode.postMessage({ type: 'target', targetId: button.dataset.target, action: button.dataset.action });
        } else if (button.dataset.command) {
            vscode.postMessage({ type: 'command', command: button.dataset.command });
        } else if (button.dataset.preset) {
            vscode.postMessage({ type: 'preset', presetId: button.dataset.preset, action: button.dataset.presetAction });
        }
    });

    window.addEventListener('message', (event) => {
        if (event.data?.type !== 'render') return;
        view = event.data.view;
        vscode.setState({ view });
        render();
    });

    setInterval(() => {
        for (const element of app.querySelectorAll('[data-since]')) {
            element.textContent = clock(Date.now() - Number(element.getAttribute('data-since')));
        }
    }, 1000);

    document.body.setAttribute('data-vscode-context', JSON.stringify({ preventDefaultContextMenuItems: true }));
    view = vscode.getState()?.view ?? null;
    render();
    vscode.postMessage({ type: 'ready' });
})();
