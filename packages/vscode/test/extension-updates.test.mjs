import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    information: vi.fn(),
    executeCommand: vi.fn(),
    progress: vi.fn((_options, task) => task()),
}));

vi.mock('vscode', () => ({
    ProgressLocation: { Notification: 15 },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    window: { showInformationMessage: mocks.information, withProgress: mocks.progress },
    commands: { executeCommand: mocks.executeCommand },
}));

import { createUpdateCommand, findLatestRelease } from '../src/extension-updates.mjs';

const bytes = Buffer.from('test vsix');
const release = (version = '0.2.0', overrides = {}) => ({
    tag_name: `vscode-v${version}`, draft: false, prerelease: false,
    assets: [{
        name: 'cc-portal-launcher-vscode.vsix', size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        browser_download_url: `https://github.com/cc-dayers/portal-tools/releases/download/vscode-v${version}/cc-portal-launcher-vscode.vsix`,
    }],
    ...overrides,
});
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
let fetchMock;
let output;
let update;

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue(json([release()]));
    vi.stubGlobal('fetch', fetchMock);
    mocks.information.mockReset().mockResolvedValue('Install Update');
    mocks.executeCommand.mockReset().mockResolvedValue(undefined);
    output = { info: vi.fn(), error: vi.fn() };
    update = createUpdateCommand({ extension: { packageJSON: { version: '0.1.2' } } }, output);
});

afterEach(() => vi.unstubAllGlobals());

describe('stable extension release discovery', () => {
    test('selects the highest semantic version, not publication order or the repo latest release', async () => {
        fetchMock.mockResolvedValue(json([
            release('99.0.0', { tag_name: 'tui-v99.0.0' }),
            release('0.9.0'), release('0.10.0'), release('0.2.0'),
            release('8.0.0', { draft: true }), release('9.0.0', { prerelease: true }),
            release('10.0.0-beta.1'),
        ]));
        expect((await findLatestRelease()).version).toBe('0.10.0');
        expect(fetchMock.mock.calls[0][0]).toContain('/releases?per_page=100&page=1');
    });

    test('checks subsequent pages even when an extension release was already found', async () => {
        fetchMock.mockResolvedValueOnce(json(Array.from({ length: 100 }, () => release('0.2.0'))))
            .mockResolvedValueOnce(json([release('0.3.0')]));
        expect((await findLatestRelease()).version).toBe('0.3.0');
        expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    });

    test.each([
        ['no stable release', [], 'No stable'],
        ['invalid response', {}, 'invalid release list'],
        ['missing asset on newest release', [release(), release('0.3.0', { assets: [] })], 'valid'],
        ['unexpected download origin', [release('0.2.0', { assets: [{
            ...release().assets[0], browser_download_url: 'https://example.com/other.vsix',
        }] })], 'valid'],
        ['oversized asset', [release('0.2.0', { assets: [{ ...release().assets[0], size: 101 * 1024 * 1024 }] })], 'valid'],
    ])('rejects %s', async (_name, value, message) => {
        fetchMock.mockResolvedValue(json(value));
        await expect(findLatestRelease()).rejects.toThrow(message);
    });

    test('reports rate limits rather than claiming the extension is up to date', async () => {
        fetchMock.mockResolvedValue(new Response('', { status: 403 }));
        await expect(update()).rejects.toThrow('HTTP 403');
        expect(output.error).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'));
        expect(mocks.information).not.toHaveBeenCalled();
    });

    test('reports an incomplete release search rather than returning a possibly stale version', async () => {
        fetchMock.mockImplementation(async () => json(Array.from({ length: 100 }, () => release())));
        await expect(findLatestRelease()).rejects.toThrow('too large to check completely');
        expect(fetchMock).toHaveBeenCalledTimes(10);
    });
});

describe('confirmed native VSIX installation', () => {
    test.each(['0.1.2', '0.1.1'])('does not install an equal or older version (%s)', async (version) => {
        fetchMock.mockResolvedValue(json([release(version)]));
        await update();
        expect(mocks.information).toHaveBeenCalledWith('Portal Launcher 0.1.2 is up to date.');
        expect(mocks.executeCommand).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('cancellation does not download or install', async () => {
        mocks.information.mockResolvedValue(undefined);
        await update();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mocks.executeCommand).not.toHaveBeenCalled();
    });

    test('downloads, verifies, installs a local URI, and cleans up without reloading', async () => {
        fetchMock.mockResolvedValueOnce(json([release()])).mockResolvedValueOnce(new Response(bytes));
        let downloadedPath;
        mocks.executeCommand.mockImplementation(async (command, uri) => {
            expect(command).toBe('workbench.extensions.installExtension');
            expect(uri.scheme).toBe('file');
            downloadedPath = uri.fsPath;
            expect(await readFile(downloadedPath)).toEqual(bytes);
        });
        await update();
        expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
        await expect(access(downloadedPath)).rejects.toThrow();
        expect(mocks.information).toHaveBeenLastCalledWith(expect.stringContaining('was installed'));
    });

    test('supports older GitHub assets without a digest', async () => {
        const older = release();
        delete older.assets[0].digest;
        fetchMock.mockResolvedValueOnce(json([older])).mockResolvedValueOnce(new Response(bytes));
        await update();
        expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['checksum mismatch', Buffer.from('bad bytes'), 'SHA-256'],
        ['truncated download', Buffer.from('short'), 'incomplete'],
        ['oversized download', Buffer.from('too many bytes'), 'expected size'],
    ])('rejects %s before installing', async (_name, data, message) => {
        fetchMock.mockResolvedValueOnce(json([release()])).mockResolvedValueOnce(new Response(data));
        await expect(update()).rejects.toThrow(message);
        expect(mocks.executeCommand).not.toHaveBeenCalled();
        expect(output.error).toHaveBeenCalled();
    });

    test('cleans up and reports native installation failures, without claiming success', async () => {
        fetchMock.mockResolvedValueOnce(json([release()])).mockResolvedValueOnce(new Response(bytes));
        mocks.executeCommand.mockRejectedValue(new Error('VS Code rejected the VSIX'));
        await expect(update()).rejects.toThrow('VS Code rejected');
        const file = mocks.executeCommand.mock.calls[0][1].fsPath;
        await expect(access(file)).rejects.toThrow();
        expect(output.error).toHaveBeenCalled();
        expect(mocks.information).toHaveBeenCalledTimes(1);
    });

    test('reports download HTTP failures without invoking the installer', async () => {
        fetchMock.mockResolvedValueOnce(json([release()]))
            .mockResolvedValueOnce(new Response('', { status: 404 }));
        await expect(update()).rejects.toThrow('HTTP 404');
        expect(mocks.executeCommand).not.toHaveBeenCalled();
        expect(mocks.information).toHaveBeenCalledTimes(1);
    });

    test('coalesces concurrent checks and allows retry after failure', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        const first = update();
        expect(update()).toBe(first);
        await expect(first).rejects.toThrow('offline');
        fetchMock.mockResolvedValue(json([release('0.1.2')]));
        await update();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
