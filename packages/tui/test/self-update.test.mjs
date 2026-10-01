import { expect, test, vi } from 'vitest';

import {
    checkForUpdate,
    compareVersions,
    installLatestRelease,
    runSelfUpdate,
} from '../src/self-update.mjs';

function fakeFetch(tagName, ok = true, status = 200) {
    return vi.fn().mockResolvedValue({
        ok,
        status,
        json: async () => ({ tag_name: tagName }),
    });
}

test('compareVersions orders by numeric segments, not lexically', () => {
    expect(compareVersions('0.1.4', '0.1.5')).toBe(-1);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.5', '0.1.5')).toBe(0);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
});

test('checkForUpdate reports whether a newer release exists', async () => {
    await expect(
        checkForUpdate({ currentVersion: '0.1.4', fetchImpl: fakeFetch('v0.1.5') }),
    ).resolves.toEqual({ currentVersion: '0.1.4', latestVersion: '0.1.5', updateAvailable: true });

    await expect(
        checkForUpdate({ currentVersion: '0.1.5', fetchImpl: fakeFetch('v0.1.5') }),
    ).resolves.toEqual({ currentVersion: '0.1.5', latestVersion: '0.1.5', updateAvailable: false });
});

test('checkForUpdate surfaces GitHub API failures', async () => {
    await expect(
        checkForUpdate({ currentVersion: '0.1.4', fetchImpl: fakeFetch('v0.1.5', false, 503) }),
    ).rejects.toThrow('GitHub API responded with 503');
});

test('installLatestRelease reinstalls with --force in one call when it succeeds', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });

    expect(installLatestRelease({ spawn })).toEqual({ installed: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual([
        'install',
        '--global',
        'https://github.com/cc-dayers/portal-tools/releases/latest/download/cc-dayers-portal-tools.tgz',
        '--force',
    ]);
});

test('installLatestRelease falls back to uninstall-then-reinstall when the forced install fails', () => {
    const spawn = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 })
        .mockReturnValueOnce({ status: 0 });

    expect(installLatestRelease({ spawn })).toEqual({ installed: true });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[1][1]).toEqual(['uninstall', '--global', '@cc-dayers/portal-tools']);
});

test('installLatestRelease reports failure when the fallback also fails', () => {
    const spawn = vi.fn().mockReturnValue({ status: 1 });

    expect(installLatestRelease({ spawn })).toEqual({
        installed: false,
        message: 'npm install exited with code 1',
    });
});

test('runSelfUpdate skips installing when already current', async () => {
    const spawn = vi.fn();
    const log = vi.fn();

    const result = await runSelfUpdate({
        currentVersion: '0.1.5',
        fetchImpl: fakeFetch('v0.1.5'),
        spawn,
        log,
    });

    expect(result).toEqual({
        success: true,
        updated: false,
        currentVersion: '0.1.5',
        latestVersion: '0.1.5',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Already up to date (0.1.5).');
});

test('runSelfUpdate installs the newer release when one is available', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const log = vi.fn();

    const result = await runSelfUpdate({
        currentVersion: '0.1.4',
        fetchImpl: fakeFetch('v0.1.5'),
        spawn,
        log,
    });

    expect(result).toEqual({
        success: true,
        updated: true,
        currentVersion: '0.1.4',
        latestVersion: '0.1.5',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
});

test('runSelfUpdate reports a friendly message when the version check fails', async () => {
    const result = await runSelfUpdate({
        currentVersion: '0.1.4',
        fetchImpl: vi.fn().mockRejectedValue(new Error('network unreachable')),
        log: () => {},
    });

    expect(result).toEqual({
        success: false,
        message: 'unable to check for updates (network unreachable)',
    });
});

test('runSelfUpdate reports installation failures', async () => {
    const result = await runSelfUpdate({
        currentVersion: '0.1.4',
        fetchImpl: fakeFetch('v0.1.5'),
        spawn: vi.fn().mockReturnValue({ status: 1 }),
        log: () => {},
    });

    expect(result).toEqual({ success: false, message: 'npm install exited with code 1' });
});
