import { PassThrough } from 'node:stream';
import React from 'react';
import { Text, render, useInput } from 'ink';
import { expect, test } from 'vitest';

import {
    ENABLE_MOUSE_REPORTING,
    hitTest,
    isPrimaryClick,
    measureElementRect,
    parseSgrMouse,
    useMouse,
} from '../src/mouse.mjs';

const h = React.createElement;

test('parseSgrMouse parses left click coordinates and release events', () => {
    const { events, rest } = parseSgrMouse('\u001b[<0;12;7M\u001b[<0;12;7m');

    expect(events).toEqual([
        {
            type: 'down',
            button: 'left',
            x: 12,
            y: 7,
            ctrl: false,
            shift: false,
            alt: false,
        },
        {
            type: 'up',
            button: 'left',
            x: 12,
            y: 7,
            ctrl: false,
            shift: false,
            alt: false,
        },
    ]);
    expect(rest).toBe('');
});

test('parseSgrMouse recognizes wheel events and modifier keys', () => {
    const { events } = parseSgrMouse('\u001b[<84;3;9M\u001b[<65;3;10M');

    expect(events).toMatchObject([
        { button: 'wheel-up', ctrl: true, shift: true, x: 3, y: 9 },
        { button: 'wheel-down', x: 3, y: 10 },
    ]);
});

test('parseSgrMouse discards unrelated keyboard escape sequences', () => {
    const { events, rest } = parseSgrMouse('\u001b[A'.repeat(10_000));

    expect(events).toEqual([]);
    expect(rest).toBe('');
});

test('parseSgrMouse marks unexpected drag reports as motion', () => {
    const { events } = parseSgrMouse('\u001b[<32;4;5M');

    expect(events).toMatchObject([{ type: 'move', button: 'left', x: 4, y: 5 }]);
    expect(ENABLE_MOUSE_REPORTING).not.toContain('?1002h');
});

test('parseSgrMouse retains an incomplete trailing escape sequence', () => {
    const { events, rest } = parseSgrMouse('\u001b[<0;2;3M\u001b[<0;4');

    expect(events).toHaveLength(1);
    expect(rest).toBe('\u001b[<0;4');
});

test('useMouse receives input from the Ink 5 input event stream', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = [];
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    stdout.columns = 80;
    stdout.rows = 24;

    function Probe() {
        useMouse((event) => events.push(event));
        useInput(() => {});
        return h(Text, null, 'mouse probe');
    }

    const instance = render(h(Probe), {
        stdin,
        stdout,
        stderr: stdout,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write('\u001b[<0;4;5M\u001b[<0;4;5m');
    await new Promise((resolve) => setTimeout(resolve, 0));
    instance.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    instance.cleanup();
    stdin.end();
    stdout.end();

    expect(events).toMatchObject([
        { type: 'down', button: 'left', x: 4, y: 5 },
        { type: 'up', button: 'left', x: 4, y: 5 },
    ]);
});

test('isPrimaryClick ignores modifier-assisted terminal gestures', () => {
    const click = { type: 'up', button: 'left', ctrl: false, shift: false, alt: false };

    expect(isPrimaryClick(click)).toBe(true);
    expect(isPrimaryClick({ ...click, ctrl: true })).toBe(false);
    expect(isPrimaryClick({ ...click, shift: true })).toBe(false);
    expect(isPrimaryClick({ ...click, alt: true })).toBe(false);
});

test('measureElementRect accumulates Ink 5 Yoga offsets from every parent', () => {
    const root = {
        parentNode: undefined,
        yogaNode: createYogaNode({ x: 0, y: 0, width: 80, height: 24 }),
    };
    const panel = {
        parentNode: root,
        yogaNode: createYogaNode({ x: 2, y: 3, width: 30, height: 18 }),
    };
    const button = {
        parentNode: panel,
        yogaNode: createYogaNode({ x: 4, y: 6, width: 12, height: 1 }),
    };

    expect(measureElementRect(button)).toEqual({ x: 6, y: 9, width: 12, height: 1 });
});

test('hitTest converts terminal coordinates before checking the element bounds', () => {
    const rect = { x: 10, y: 5, width: 8, height: 2 };

    expect(hitTest(rect, { x: 11, y: 6 })).toBe(true);
    expect(hitTest(rect, { x: 18, y: 7 })).toBe(true);
    expect(hitTest(rect, { x: 10, y: 6 })).toBe(false);
    expect(hitTest(rect, { x: 19, y: 7 })).toBe(false);
});

function createYogaNode({ x, y, width, height }) {
    return {
        getComputedLeft: () => x,
        getComputedTop: () => y,
        getComputedWidth: () => width,
        getComputedHeight: () => height,
    };
}
