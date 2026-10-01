import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The VS Code integration tests run inside VS Code via @vscode/test-cli, not Vitest.
        exclude: [...configDefaults.exclude, '**/.vscode-test/**', 'packages/vscode/test/integration/**'],
    },
});
