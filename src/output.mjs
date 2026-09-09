import { EventEmitter } from 'node:events';

export function createThrottledOutput(output, intervalMs = 50) {
    const resizeEvents = new EventEmitter();
    let resizeTimer = null;
    let disposed = false;

    const handleResize = () => {
        if (disposed || resizeTimer) return;

        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (!disposed) resizeEvents.emit('resize');
        }, intervalMs);
    };

    output.on?.('resize', handleResize);

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
            resizeEvents.removeAllListeners();
            output.off?.('resize', handleResize);
        },
    };
}
