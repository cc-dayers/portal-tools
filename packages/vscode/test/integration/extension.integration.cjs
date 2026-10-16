const assert = require('node:assert/strict');
const vscode = require('vscode');
const path = require('node:path');

const EXTENSION_ID = 'cc-dayers.cc-portal-launcher-vscode';

async function waitFor(predicate, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Timed out waiting for ${description}.`);
}

describe('Portal Launcher extension', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    it('stays inactive until the dashboard is opened', () => {
        assert.ok(extension, `${EXTENSION_ID} should be installed in the test instance`);
        assert.equal(extension.isActive, false);
    });

    it('activates idle when the dashboard view is focused', async () => {
        await vscode.commands.executeCommand('ccPortalLauncher.dashboard.focus');
        await waitFor(() => extension.isActive, 'extension activation');
        assert.equal(extension.exports.phase, 'idle');
        assert.equal(extension.exports.snapshot, null);
    });

    it('reads compact/full display from VS Code user settings without launching', async () => {
        await vscode.commands.executeCommand('ccPortalLauncher.showSettings');
        assert.equal(extension.exports.phase, 'idle');
        assert.equal(extension.exports.snapshot, null);
        const config = vscode.workspace.getConfiguration('ccPortalLauncher');
        const previous = config.inspect('presets.displayMode').globalValue;
        try {
            await config.update('presets.displayMode', 'compact', vscode.ConfigurationTarget.Global);
            assert.equal(extension.exports.dashboard.presetDisplay, 'compact');
            assert.equal(extension.exports.phase, 'idle');
            await config.update('presets.displayMode', 'full', vscode.ConfigurationTarget.Global);
            assert.equal(extension.exports.dashboard.presetDisplay, 'full');
        } finally {
            await config.update('presets.displayMode', previous, vscode.ConfigurationTarget.Global);
        }
    });

    it('runs host-provided setup in a real terminal task and observes process completion', async () => {
        const { runSetupTask } = require(path.join(extension.extensionPath, extension.packageJSON.main));
        const terminal = { command: 'node', args: ['-e', 'console.log("Mock setup complete")'], cwd: extension.extensionPath };
        assert.equal(await runSetupTask(terminal), true);
        assert.equal(await runSetupTask({ ...terminal, args: ['-e', 'process.exit(1)'] }), false);
        assert.equal(extension.exports.phase, 'idle');
        assert.equal(extension.exports.snapshot, null);
    });

    it('launches the saved configuration, reaches ready, and returns to idle after Stop All', async () => {
        await vscode.commands.executeCommand('ccPortalLauncher.launchSaved');
        assert.equal(extension.exports.phase, 'running');

        await waitFor(() => {
            const targets = extension.exports.snapshot?.targets ?? [];
            return targets.length > 0 && targets.every((target) => target.status === 'ready');
        }, 'every mock target to become ready');

        await vscode.commands.executeCommand('ccPortalLauncher.showSettings');
        assert.equal(extension.exports.phase, 'running');
        assert.ok(extension.exports.snapshot.targets.every((target) => target.status === 'ready'));

        await vscode.commands.executeCommand('ccPortalLauncher.stopAll');
        await waitFor(() => extension.exports.phase === 'idle', 'the session to exit');
        assert.equal(extension.exports.snapshot, null);
    });

    it('launches a starter preset with every portal the host offers', async () => {
        await vscode.commands.executeCommand('ccPortalLauncher.preset.launch', { presetId: 'builtin-all-dev-api' });
        assert.equal(extension.exports.phase, 'running');

        await waitFor(() => (extension.exports.snapshot?.targets?.length ?? 0) > 0, 'the first state snapshot');
        const portals = extension.exports.snapshot.targets.filter((target) => target.kind !== 'backend');
        assert.ok(portals.length > 1, 'expected every host portal, not a single default');
        assert.ok(extension.exports.snapshot.targets.every((target) => target.kind !== 'backend'));

        await vscode.commands.executeCommand('ccPortalLauncher.stopAll');
        await waitFor(() => extension.exports.phase === 'idle', 'the session to exit');
    });
});
