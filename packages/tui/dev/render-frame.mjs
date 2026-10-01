// Shared helper for rendering the real Ink UIs (config wizard, dashboard)
// against fake terminal streams and capturing clean text frames.
//
// This exists so nobody has to reinvent this plumbing in a throwaway script
// every time a layout bug needs reproducing — use it directly for ad-hoc
// investigation (see dev/visualize.mjs) and it backs the layout snapshot
// tests in test/layout-snapshots.test.mjs, which is what actually catches
// regressions like a size becoming "too small" or a border being drawn
// where it shouldn't be.

import { PassThrough } from 'node:stream';

export function stripAnsi(value) {
    return value.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}

export function makeFakeStdout(columns, rows) {
    const stream = new PassThrough();
    stream.columns = columns;
    stream.rows = rows;
    stream.isTTY = true;
    let buffer = '';
    const chunks = [];
    stream.on('data', (chunk) => {
        const text = chunk.toString();
        buffer += text;
        chunks.push(text);
    });
    return { stream, getBuffer: () => buffer, getChunks: () => chunks };
}

export function makeFakeStdin() {
    const stream = new PassThrough();
    stream.isTTY = true;
    stream.setRawMode = () => stream;
    stream.ref = () => stream;
    stream.unref = () => stream;
    return stream;
}

/**
 * Strips ANSI codes from a captured stdout buffer. Ink repaints in place
 * (cursor movement, not a literal screen clear per frame), so the cleaned
 * text is every repaint's lines concatenated in order — which is exactly
 * what you want for "did ANY frame ever render a bad line" checks. For a
 * human to eyeball, print it directly: each repaint reads top-to-bottom
 * like a filmstrip of the session.
 *
 * Do NOT snapshot this directly — the number of intermediate repaints
 * before the UI settles is a timing race (React's update batching), so it
 * varies between machines/CI and made an earlier version of this file's
 * snapshot tests flaky. Use lastFrame() for anything you snapshot.
 */
export function cleanFrames(rawBuffer) {
    return stripAnsi(rawBuffer);
}

/**
 * Returns only the LAST repaint Ink wrote, stripped of ANSI codes. Each
 * call to Ink's internal log-update writes one full repaint in a single
 * stream.write(), so the last captured chunk (see makeFakeStdout's
 * getChunks) is deterministically "the state the terminal was left in" —
 * unlike the full concatenated buffer, this is safe to snapshot.
 */
export function lastFrame(chunks) {
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const clean = stripAnsi(chunks[index]);
        if (clean.trim().length > 0) return clean;
    }
    return '';
}

/**
 * Finds every rendered line, across every repaint, that overflows the
 * given terminal width. Ink should never emit a line longer than the
 * terminal — if this returns anything, that's a real bug: text overflow
 * wraps unpredictably in a real terminal and is exactly what produces
 * "crammed" or corrupted-looking output.
 */
export function findOverflowingLines(frameText, width) {
    return frameText
        .split('\n')
        .map((line, index) => ({ index, line }))
        .filter(({ line }) => line.length > width);
}

/**
 * Finds lines containing box-drawing characters — useful for asserting a
 * region renders as a plain divider (no border) versus a boxed panel,
 * since Ink silently defaults every side of a `borderStyle` to enabled
 * unless you explicitly disable the ones you don't want.
 */
export function findBorderedLines(frameText) {
    return frameText.split('\n').filter((line) => /[┌┐└┘│─╭╮╰╯]/.test(line));
}
