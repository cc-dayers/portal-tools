import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

const REPOSITORY = 'cc-dayers/portal-tools';
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases`;
const ASSET_NAME = 'cc-portal-launcher-vscode.vsix';
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

function versionParts(version) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    return match ? match.slice(1).map(BigInt) : null;
}

function compareVersions(left, right) {
    for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
}

async function request(url, accept) {
    const response = await fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'cc-portal-launcher-vscode' },
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(`GitHub update request failed (HTTP ${response.status}). Check your network access and GitHub rate limit, then try again.`);
    }
    return response;
}

export async function findLatestRelease() {
    let latest;
    // TUI and extension releases share this repository, so /releases/latest is not suitable.
    for (let page = 1; page <= 10; page++) {
        const response = await request(`${RELEASES_URL}?per_page=100&page=${page}`, 'application/vnd.github+json');
        const releases = await response.json();
        if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list.');
        for (const release of releases) {
            if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') continue;
            const version = release.tag_name.startsWith('vscode-v') ? release.tag_name.slice('vscode-v'.length) : '';
            const parts = versionParts(version);
            if (parts && (!latest || compareVersions(parts, latest.parts) > 0)) {
                latest = { ...release, version, parts };
            }
        }
        if (releases.length < 100) {
            if (!latest) throw new Error('No stable VS Code extension release was found on GitHub.');
            const asset = latest.assets?.find((candidate) => candidate.name === ASSET_NAME);
            const downloadUrl = `https://github.com/${REPOSITORY}/releases/download/${latest.tag_name}/${ASSET_NAME}`;
            if (!asset || asset.browser_download_url !== downloadUrl || !Number.isSafeInteger(asset.size) ||
                asset.size <= 0 || asset.size > MAX_DOWNLOAD_BYTES) {
                throw new Error(`Release ${latest.tag_name} does not contain a valid ${ASSET_NAME} asset.`);
            }
            return { version: latest.version, parts: latest.parts, asset, downloadUrl };
        }
    }
    throw new Error('The GitHub release history is too large to check completely. Open the repository releases page to update manually.');
}

async function downloadRelease(release) {
    const response = await request(release.downloadUrl, 'application/octet-stream');
    if (!response.body) throw new Error('The extension download returned an empty body.');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > release.asset.size) throw new Error('The extension download exceeded its expected size.');
        chunks.push(chunk);
    }
    if (length !== release.asset.size) throw new Error('The extension download was incomplete. Please try again.');
    const bytes = Buffer.concat(chunks);
    if (release.asset.digest) {
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (digest !== release.asset.digest) throw new Error('The extension download failed its SHA-256 integrity check.');
    }
    return bytes;
}

export function createUpdateCommand(context, output) {
    let running;
    return () => {
        if (running) return running;
        running = runUpdate(context, output).catch((error) => {
            output.error(`Extension update failed: ${error.message}`);
            throw error;
        }).finally(() => { running = undefined; });
        return running;
    };
}

async function runUpdate(context, output) {
    const installedVersion = context.extension.packageJSON.version;
    const installedParts = versionParts(installedVersion);
    if (!installedParts) throw new Error(`Cannot check updates for extension version ${installedVersion}.`);
    const release = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Checking Portal Launcher updates',
    }, findLatestRelease);
    if (compareVersions(release.parts, installedParts) <= 0) {
        await vscode.window.showInformationMessage(`Portal Launcher ${installedVersion} is up to date.`);
        return;
    }
    const choice = await vscode.window.showInformationMessage(
        `Update Portal Launcher from ${installedVersion} to ${release.version}?`,
        { modal: true, detail: 'Download the official GitHub release and install it using VS Code. A window reload may be required; reloading stops running launcher sessions.' },
        'Install Update',
    );
    if (choice !== 'Install Update') return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Installing Portal Launcher ${release.version}`,
    }, async () => {
        const bytes = await downloadRelease(release);
        const directory = await mkdtemp(path.join(tmpdir(), 'cc-portal-update-'));
        try {
            const file = path.join(directory, ASSET_NAME);
            await writeFile(file, bytes);
            await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
            output.info(`Installed Portal Launcher ${release.version} using VS Code.`);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    await vscode.window.showInformationMessage(
        `Portal Launcher ${release.version} was installed. If VS Code requests a reload, finish your launcher session before reloading.`,
    );
}
