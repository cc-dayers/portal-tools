import { createServer } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

// Mirrors the application's optional persistent transport without starting real servers.
export async function createPersistentMockTransport({ endpoint, token, input, output }) {
    if (!endpoint || !token || token.length < 32) throw new Error('Invalid persistent launcher connection.');
    const protocolInput = new PassThrough();
    let active = null;
    let hello = '';
    let launched = false;
    const connections = new Set();
    const protocolOutput = new Writable({
        write(chunk, _encoding, callback) {
            const message = JSON.parse(chunk.toString());
            if (message.type === 'server.hello') hello = chunk;
            if (message.type === 'event.state' ||
                (message.type === 'response.ok' && message.payload?.command === 'launch')) launched = true;
            if (active && (active.authenticated || message.type === 'server.hello') &&
                !active.output.destroyed && !active.output.writableEnded) {
                if (active.output.writableLength > 1_048_576) active.disconnect();
                else active.output.write(chunk);
            }
            callback();
        },
    });
    function attach(source, destination, socket = null) {
        if (active) return socket?.destroy();
        let buffer = '';
        let authenticated = false;
        const connection = {
            output: destination,
            get authenticated() { return authenticated; },
            disconnect(graceful = false) {
                clearTimeout(timer);
                source.off('data', onData);
                source.off('end', onEnd);
                source.off('close', onEnd);
                source.off('error', onEnd);
                destination.off('error', onEnd);
                connections.delete(connection);
                if (active === connection) {
                    active = null;
                    if (!launched && (authenticated || !socket)) protocolInput.end();
                }
                if (graceful) socket?.end();
                else socket?.destroy();
            },
        };
        const onEnd = () => connection.disconnect();
        const timer = setTimeout(onEnd, 10_000);
        function onData(chunk) {
            buffer += chunk.toString();
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                if (newline > 1_048_576) return connection.disconnect();
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (!authenticated) {
                    let message;
                    try { message = JSON.parse(line); } catch { return connection.disconnect(); }
                    const supplied = Buffer.from(String(message.payload?.sessionToken ?? ''));
                    const expected = Buffer.from(token);
                    if (message.type !== 'client.hello' || supplied.length !== expected.length ||
                        !timingSafeEqual(supplied, expected)) return connection.disconnect();
                    authenticated = true;
                    clearTimeout(timer);
                }
                protocolInput.write(`${line}\n`);
            }
            if (buffer.length > 1_048_576) connection.disconnect();
        }
        active = connection;
        connections.add(connection);
        source.setEncoding?.('utf8');
        source.on('data', onData);
        source.on('end', onEnd);
        source.on('close', onEnd);
        source.on('error', onEnd);
        destination.on('error', onEnd);
        if (hello) destination.write(hello);
    }
    const server = createServer(socket => attach(socket, socket, socket));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', error => protocolInput.destroy(error));
    attach(input, output);
    return {
        input: protocolInput, output: protocolOutput,
        close() {
            launched = true;
            for (const connection of connections) connection.disconnect(true);
            server.close();
            protocolInput.destroy();
            protocolOutput.destroy();
        },
    };
}
