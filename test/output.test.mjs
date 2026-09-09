import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';

import { createThrottledOutput } from '../src/output.mjs';

test('createThrottledOutput coalesces resize event storms', async () => {
    const output = new PassThrough();
    const throttled = createThrottledOutput(output, 10);
    const listener = vi.fn();
    throttled.stdout.on('resize', listener);

    for (let index = 0; index < 10_000; index += 1) output.emit('resize');

    expect(listener).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).toHaveBeenCalledTimes(1);

    throttled.dispose();
    output.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).toHaveBeenCalledTimes(1);
});
