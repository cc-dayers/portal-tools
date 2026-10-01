import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    label: 'integration',
    files: 'test/integration/**/*.integration.cjs',
    // Command-line test runs cannot share a running Stable instance, so tests use Insiders.
    version: 'insiders',
    workspaceFolder: './test/fixtures/app',
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    mocha: { ui: 'bdd', timeout: 20_000 },
});
