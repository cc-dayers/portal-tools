import React, { useCallback, useContext, useEffect, useRef } from 'react';
import { measureElement, useStdin, useStdout } from 'ink';

export const ENABLE_MOUSE_REPORTING = '\u001b[?1000h\u001b[?1006h';
export const DISABLE_MOUSE_REPORTING = '\u001b[?1000l\u001b[?1006l';
const MAX_PARTIAL_SEQUENCE_LENGTH = 64;
const MAX_MOUSE_INPUT_LENGTH = 4096;
const SGR_SEQUENCE = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
const h = React.createElement;
const MouseBusContext = React.createContext(() => () => {});

export function parseSgrMouse(buffer) {
    const events = [];
    let lastEnd = 0;
    SGR_SEQUENCE.lastIndex = 0;

    let match;
    while ((match = SGR_SEQUENCE.exec(buffer)) !== null) {
        const [, buttonCode, column, row, kind] = match;
        const code = Number(buttonCode);
        const isRelease = kind === 'm';
        const isWheel = (code & 64) !== 0;
        const isMotion = (code & 32) !== 0;
        let button;

        if (isWheel) {
            button = (code & 1) === 0 ? 'wheel-up' : 'wheel-down';
        } else {
            button = ['left', 'middle', 'right'][code & 3] ?? 'left';
        }

        events.push({
            type: isMotion ? 'move' : isRelease ? 'up' : 'down',
            button,
            x: Number(column),
            y: Number(row),
            ctrl: (code & 16) !== 0,
            shift: (code & 4) !== 0,
            alt: (code & 8) !== 0,
        });
        lastEnd = SGR_SEQUENCE.lastIndex;
    }

    const unmatched = lastEnd > 0 ? buffer.slice(lastEnd) : buffer;
    return { events, rest: getPartialSequence(unmatched) };
}

export function measureElementRect(node) {
    const dimensions = measureElement(node);
    let x = 0;
    let y = 0;
    let current = node;

    while (current) {
        if (current.yogaNode) {
            x += current.yogaNode.getComputedLeft();
            y += current.yogaNode.getComputedTop();
        }
        current = current.parentNode;
    }

    return { x, y, width: dimensions.width, height: dimensions.height };
}

export function hitTest(rect, event) {
    if (rect.width === 0 || rect.height === 0) return false;

    const mouseX = event.x - 1;
    const mouseY = event.y - 1;
    return (
        mouseX >= rect.x &&
        mouseX < rect.x + rect.width &&
        mouseY >= rect.y &&
        mouseY < rect.y + rect.height
    );
}

export function useMouse(onEvent) {
    const { stdin, internal_eventEmitter: inputEmitter } = useStdin();
    const { stdout } = useStdout();
    const callbackRef = useRef(onEvent);
    callbackRef.current = onEvent;

    useEffect(() => {
        const eventSource = inputEmitter ?? stdin;
        const eventName = inputEmitter ? 'input' : 'data';
        if (!eventSource) return undefined;

        let buffer = '';
        const handleInput = (chunk) => {
            buffer = `${buffer}${chunk.toString()}`.slice(-MAX_MOUSE_INPUT_LENGTH);
            const parsed = parseSgrMouse(buffer);
            parsed.events.forEach((event) => callbackRef.current(event));
            buffer = parsed.rest.slice(-MAX_PARTIAL_SEQUENCE_LENGTH);
        };

        stdout.write(ENABLE_MOUSE_REPORTING);
        eventSource.on(eventName, handleInput);

        return () => {
            eventSource.removeListener(eventName, handleInput);
            stdout.write(DISABLE_MOUSE_REPORTING);
        };
    }, [inputEmitter, stdin, stdout]);
}

export function MouseProvider({ event, children }) {
    const handlersRef = useRef(new Set());
    const subscribe = useCallback((handler) => {
        handlersRef.current.add(handler);
        return () => handlersRef.current.delete(handler);
    }, []);

    useEffect(() => {
        if (!event) return;
        handlersRef.current.forEach((handler) => handler(event));
    }, [event]);

    return h(MouseBusContext.Provider, { value: subscribe }, children);
}

export function isPrimaryClick(event) {
    return (
        event.type === 'up' &&
        event.button === 'left' &&
        !event.ctrl &&
        !event.shift &&
        !event.alt
    );
}

export function useClickable(onPress) {
    const ref = useRef(null);
    const subscribe = useContext(MouseBusContext);
    const onPressRef = useRef(onPress);
    onPressRef.current = onPress;

    useEffect(
        () =>
            subscribe((event) => {
                if (!isPrimaryClick(event) || !ref.current) return;

                if (hitTest(measureElementRect(ref.current), event)) onPressRef.current();
            }),
        [subscribe],
    );

    return ref;
}

function getPartialSequence(value) {
    const markerIndex = value.lastIndexOf('\u001b[<');
    if (markerIndex >= 0) {
        const candidate = value.slice(markerIndex);
        if (/^\u001b\[<[\d;]*$/.test(candidate)) return candidate;
    }

    if (value.endsWith('\u001b[')) return '\u001b[';
    if (value.endsWith('\u001b')) return '\u001b';
    return '';
}
