import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connectToLauncherHost, reconnectToLauncherHost } from './protocol-client.mjs';

export function launcherSessionPath(hostPath, directory = path.join(os.homedir(), '.cc-portals', 'tui-sessions')) {
    const resolved = path.resolve(hostPath);
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const key = createHash('sha256').update(identity).digest('hex');
    return path.join(directory, `${key}.json`);
}

async function readReference(filePath) {
    try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
            throw new Error('Launcher session file must be a private regular file.');
        }
        const reference = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
            throw new Error('Invalid launcher session reference.');
        }
        return reference;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

export async function forgetStoredLauncherSession({ hostPath, directory }) {
    await fs.rm(launcherSessionPath(hostPath, directory), { force: true });
}

export async function connectToStoredLauncherSession({ hostPath, directory, ...options }) {
    const filePath = launcherSessionPath(hostPath, directory);
    const clear = () => fs.rm(filePath, { force: true });
    let saved;
    try {
        saved = await readReference(filePath);
    } catch (error) {
        throw new Error(`Cannot read the saved launcher session: ${error.message} ` +
            'No replacement was launched. Use --forget-session only after stopping surviving processes.');
    }
    if (saved) {
        try {
            if (!saved.sessionId || !saved.endpoint || !saved.token) {
                throw new Error('The previous session did not finish connecting.');
            }
            const client = await reconnectToLauncherHost({ ...saved, clientInfo: options.clientInfo });
            return { client, persistent: true, clear };
        } catch (error) {
            throw new Error(`Cannot reconnect to the saved launcher session: ${error.message} ` +
                'No replacement was launched. Retry, or use --forget-session after stopping surviving processes.');
        }
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-portals-tui-${id}`
        : path.join(os.tmpdir(), `cc-portals-${id}.sock`);
    const reference = { endpoint, token: randomBytes(32).toString('hex'), sessionId: null };
    // Exclusive creation reserves this workspace before a host can be launched.
    try {
        await fs.writeFile(filePath, JSON.stringify(reference), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another TUI session is connecting. Retry after it detaches.');
        throw error;
    }
    let client;
    try {
        client = await connectToLauncherHost({
            ...options, hostPath, persistentSession: reference,
        });
        const persistent = client.hello?.capabilities?.persistentSession === true;
        if (persistent) {
            reference.sessionId = client.hello.sessionId;
            await fs.writeFile(filePath, JSON.stringify(reference), { mode: 0o600 });
        } else {
            await clear();
        }
        return { client, persistent, clear };
    } catch (error) {
        client?.close();
        await clear();
        throw error;
    }
}
