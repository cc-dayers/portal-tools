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

test('createThrottledOutput detects dimension changes when resize events are missed', async () => {
    const output = new PassThrough();
    output.columns = 80;
    output.rows = 24;
    const throttled = createThrottledOutput(output, 5, 10);
    const listener = vi.fn();
    throttled.stdout.on('resize', listener);

    output.columns = 100;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(listener).toHaveBeenCalledTimes(1);
    throttled.dispose();
});

test('createThrottledOutput synchronizes dimensions on native resize to avoid duplicate events', async () => {
    const output = new PassThrough();
    output.columns = 80;
    output.rows = 24;
    const throttled = createThrottledOutput(output, 10, 20);
    const listener = vi.fn();
    throttled.stdout.on('resize', listener);

    output.columns = 100;
    output.emit('resize');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listener).toHaveBeenCalledTimes(1);

    throttled.dispose();
});

test('createThrottledOutput ignores a late native event after polling reported the same size', async () => {
    const output = new PassThrough();
    output.columns = 80;
    output.rows = 24;
    const throttled = createThrottledOutput(output, 25, 10);
    const listener = vi.fn();
    throttled.stdout.on('resize', listener);

    output.columns = 100;
    await new Promise((resolve) => setTimeout(resolve, 15));
    output.emit('resize');

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(listener).toHaveBeenCalledTimes(1);

    throttled.dispose();
});
