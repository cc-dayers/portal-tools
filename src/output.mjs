import { EventEmitter } from 'node:events';

export function createThrottledOutput(output, intervalMs = 25, pollIntervalMs = 50) {
    const resizeEvents = new EventEmitter();
    let resizeTimer = null;
    let disposed = false;
    let lastColumns = output.columns;
    let lastRows = output.rows;

    const emitResize = () => {
        lastColumns = output.columns;
        lastRows = output.rows;
        resizeEvents.emit('resize');
    };

    const handleResize = () => {
        if (disposed || resizeTimer) return;
        const dimensionsKnown = output.columns != null || output.rows != null;
        if (
            dimensionsKnown &&
            output.columns === lastColumns &&
            output.rows === lastRows
        ) {
            return;
        }

        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (!disposed) emitResize();
        }, intervalMs);
    };

    output.on?.('resize', handleResize);

    // Some terminals/multiplexers deliver (or forward) the native 'resize'
    // event late or not at all, which otherwise leaves the UI stuck at the
    // old size until something unrelated happens to trigger a re-render.
    // Poll the reported dimensions as a fallback so a resize is never missed
    // for longer than pollIntervalMs.
    const pollTimer = setInterval(() => {
        if (disposed) return;
        if (output.columns !== lastColumns || output.rows !== lastRows) {
            if (resizeTimer) return;
            emitResize();
        }
    }, pollIntervalMs);
    pollTimer.unref?.();

    let facade;
    facade = new Proxy(output, {
        get(target, property) {
            if (property === 'on' || property === 'addListener') {
                return (eventName, listener) => {
                    if (eventName === 'resize') resizeEvents.on(eventName, listener);
                    else target.on?.(eventName, listener);
                    return facade;
                };
            }

            if (property === 'off' || property === 'removeListener') {
                return (eventName, listener) => {
                    if (eventName === 'resize') resizeEvents.removeListener(eventName, listener);
                    else target.off?.(eventName, listener);
                    return facade;
                };
            }

            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });

    return {
        stdout: facade,
        dispose() {
            disposed = true;
            clearTimeout(resizeTimer);
            resizeTimer = null;
            clearInterval(pollTimer);
            resizeEvents.removeAllListeners();
            output.off?.('resize', handleResize);
        },
    };
}
