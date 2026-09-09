import process from 'node:process';
import { spawnSync } from 'node:child_process';

export const RELEASE_API_URL = 'https://api.github.com/repos/cc-dayers/portal-tools/releases/latest';
export const INSTALL_TARBALL_URL =
    'https://github.com/cc-dayers/portal-tools/releases/latest/download/cc-dayers-portal-tools.tgz';
const PACKAGE_NAME = '@cc-dayers/portal-tools';

/**
 * Compares two `x.y.z` version strings. Returns -1, 0, or 1, the same
 * convention as Array.prototype.sort comparators.
 */
export function compareVersions(a, b) {
    const partsA = String(a).split('.').map(Number);
    const partsB = String(b).split('.').map(Number);
    const length = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < length; i++) {
        const numA = partsA[i] ?? 0;
        const numB = partsB[i] ?? 0;
        if (numA !== numB) return numA < numB ? -1 : 1;
    }
    return 0;
}

export async function fetchLatestVersion({ fetchImpl = fetch } = {}) {
    const response = await fetchImpl(RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cc-portals-tui' },
    });
    if (!response.ok) {
        throw new Error(`GitHub API responded with ${response.status}`);
    }
    const data = await response.json();
    const tag = String(data?.tag_name ?? '').trim();
    if (!tag) throw new Error('release response is missing a tag_name');
    return tag.replace(/^v/i, '');
}

export async function checkForUpdate({ currentVersion, fetchImpl } = {}) {
    const latestVersion = await fetchLatestVersion({ fetchImpl });
    return {
        currentVersion,
        latestVersion,
        updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
    };
}

/**
 * Installs the latest release over the current global install. Tries a
 * forced reinstall first; if npm refuses to overwrite the existing global
 * package (a known source of "uninstall then reinstall" friction on
 * Windows), falls back to an explicit uninstall before retrying once.
 */
export function installLatestRelease({ env = process.env, cwd = process.cwd(), spawn = spawnSync } = {}) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const spawnOptions = { cwd, env, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' };
    const install = () => spawn(npmCommand, ['install', '--global', INSTALL_TARBALL_URL, '--force'], spawnOptions);

    let result = install();
    if (result.error || result.status !== 0) {
        spawn(npmCommand, ['uninstall', '--global', PACKAGE_NAME], spawnOptions);
        result = install();
    }

    if (result.error || result.status !== 0) {
        return {
            installed: false,
            message: result.error
                ? sanitizeMessage(result.error.message)
                : `npm install exited with code ${result.status ?? 'unknown'}`,
        };
    }
    return { installed: true };
}

export async function runSelfUpdate({
    currentVersion,
    env,
    cwd,
    spawn,
    fetchImpl,
    log = () => {},
} = {}) {
    log(`Checking for updates (current: ${currentVersion})...`);

    let update;
    try {
        update = await checkForUpdate({ currentVersion, fetchImpl });
    } catch (error) {
        return { success: false, message: `unable to check for updates (${sanitizeMessage(error.message)})` };
    }

    if (!update.updateAvailable) {
        log(`Already up to date (${currentVersion}).`);
        return { success: true, updated: false, currentVersion, latestVersion: update.latestVersion };
    }

    log(`Updating ${currentVersion} -> ${update.latestVersion}...`);
    const installation = installLatestRelease({ env, cwd, spawn });
    if (!installation.installed) {
        return { success: false, message: installation.message };
    }

    log(`Updated to ${update.latestVersion}.`);
    return { success: true, updated: true, currentVersion, latestVersion: update.latestVersion };
}

function sanitizeMessage(value) {
    return String(value ?? 'Unknown error')
        .replace(/[\r\n\t]+/g, ' ')
        .slice(0, 300);
}
