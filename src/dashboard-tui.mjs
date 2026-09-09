import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import {
    DISABLE_MOUSE_REPORTING,
    ENABLE_MOUSE_REPORTING,
    MouseProvider,
    useClickable,
    useMouse,
} from './mouse.mjs';
import { createThrottledOutput } from './output.mjs';

const h = React.createElement;
const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';
const EXIT_ALTERNATE_SCREEN = '\u001b[?1049l';
const MAX_LOG_ENTRIES = 1000;
const MAX_PENDING_LOG_ENTRIES = 500;
const LOG_FLUSH_INTERVAL_MS = 100;
const ERROR_PATTERN = /\b(?:error|failed|failure|fatal|exception)\b/i;

export function getDashboardLayoutMode(width, height) {
    if (width < 40 || height < 8) return 'too-small';
    if (width < 72 || height < 13) return 'minimal';
    if (width < 110 || height < 22) return 'compact';
    return 'full';
}


export function getVisibleTargetWindow(targets, selectedIndex, maximumRows) {
    const items = Array.isArray(targets) ? targets : [];
    const rowCount = Math.max(1, Math.floor(maximumRows));
    if (items.length <= rowCount) return { items, start: 0 };

    const selected = Math.min(Math.max(0, selectedIndex), items.length - 1);
    const start = Math.min(
        Math.max(0, selected - Math.floor(rowCount / 2)),
        items.length - rowCount,
    );
    return { items: items.slice(start, start + rowCount), start };
}

function getDashboardRowBudget(height, layoutMode) {
    if (layoutMode === 'full') return Math.max(1, height - 15);
    if (layoutMode === 'compact') return Math.max(1, height - 6);
    return Math.max(1, height - 5);
}

function getVisibleLogRows(height, layoutMode) {
    if (layoutMode === 'full') return Math.max(1, height - 10);
    if (layoutMode === 'compact') return Math.max(1, height - 6);
    return 1;
}

export async function runPortalDashboard({
    launchOptions,
    launchPortals,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
}) {
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new Error('The portal dashboard requires an interactive terminal.');
    }

    let exitCode = 1;
    const throttledOutput = createThrottledOutput(stdout);
    stdout.write(`${ENTER_ALTERNATE_SCREEN}${ENABLE_MOUSE_REPORTING}`);

    try {
        const instance = render(
            h(PortalDashboardApp, {
                launchOptions,
                launchPortals,
                onExitCode(code) {
                    exitCode = normalizeExitCode(code);
                },
            }),
            {
                exitOnCtrlC: false,
                patchConsole: false,
                stdin,
                stdout: throttledOutput.stdout,
                stderr,
            },
        );

        await instance.waitUntilExit();
        return exitCode;
    } finally {
        throttledOutput.dispose();
        stdout.write(`${DISABLE_MOUSE_REPORTING}${EXIT_ALTERNATE_SCREEN}`);
    }
}

function PortalDashboardApp({ launchOptions, launchPortals, onExitCode }) {
    const { exit } = useApp();
    const terminal = useTerminalSize();
    const [activeTab, setActiveTab] = useState('dashboard');
    const [snapshot, setSnapshot] = useState(() => createInitialSnapshot(launchOptions));
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [logs, setLogs] = useState([]);
    const [logTop, setLogTop] = useState(0);
    const [followLogs, setFollowLogs] = useState(true);
    const [notice, setNotice] = useState('Starting portal launcher…');
    const [error, setError] = useState('');
    const [actionBusy, setActionBusy] = useState('');
    const [mouseEvent, setMouseEvent] = useState(null);
    const [shutdownRequested, setShutdownRequested] = useState(false);
    const controllerRef = useRef(null);
    const pendingLogsRef = useRef([]);
    const nextLogIdRef = useRef(0);
    const mountedRef = useRef(true);
    const shutdownRequestedRef = useRef(false);
    const shutdownReasonRef = useRef('');
    const launcherRejectedRef = useRef(false);
    const controllerUnavailableRef = useRef(false);
    const layoutMode = getDashboardLayoutMode(terminal.width, terminal.height);
    const visibleLogRows = getVisibleLogRows(terminal.height, layoutMode);
    const targets = snapshot.targets;
    const selectedTarget = targets[selectedIndex] ?? null;
    const targetWindow = getVisibleTargetWindow(
        targets,
        selectedIndex,
        getDashboardRowBudget(terminal.height, layoutMode),
    );
    const isShuttingDown = shutdownRequested || snapshot.isShuttingDown;

    const updateSnapshot = useCallback((value) => {
        try {
            const next = normalizeSnapshot(value);
            if (mountedRef.current) setSnapshot(next);
        } catch (snapshotError) {
            if (mountedRef.current) {
                setError(`Controller state error: ${formatError(snapshotError)}`);
            }
        }
    }, []);

    const stopController = useCallback((controller, reason) => {
        let result;

        try {
            result = controller.stopAll(reason);
        } catch (stopError) {
            if (mountedRef.current) {
                shutdownRequestedRef.current = false;
                setShutdownRequested(false);
                setError(`Unable to stop portals: ${formatError(stopError)}`);
            }
            return;
        }

        Promise.resolve(result).catch((stopError) => {
            if (!mountedRef.current) return;
            shutdownRequestedRef.current = false;
            setShutdownRequested(false);
            setError(`Unable to stop portals: ${formatError(stopError)}`);
        });
    }, []);

    const requestShutdown = useCallback(
        (reason) => {
            if (shutdownRequestedRef.current || snapshot.isShuttingDown) return;

            shutdownRequestedRef.current = true;
            shutdownReasonRef.current = reason;
            setShutdownRequested(true);
            setNotice(`Stopping portals (${reason})… waiting for child processes.`);

            if (controllerRef.current) {
                stopController(controllerRef.current, reason);
            } else if (launcherRejectedRef.current || controllerUnavailableRef.current) {
                onExitCode(1);
                exit();
            } else {
                setNotice(`Stop requested (${reason})… waiting for launcher controller.`);
            }
        },
        [exit, onExitCode, snapshot.isShuttingDown, stopController],
    );

    const invokeController = useCallback(async (label, method, ...args) => {
        const controller = controllerRef.current;
        if (!controller || typeof controller[method] !== 'function') {
            setError(`Controller action unavailable: ${label}.`);
            return;
        }

        setActionBusy(label);
        setError('');
        setNotice(`${label}…`);

        try {
            await controller[method](...args);
            if (mountedRef.current) setNotice(`${label} requested.`);
        } catch (actionError) {
            if (mountedRef.current) setError(`${label} failed: ${formatError(actionError)}`);
        } finally {
            if (mountedRef.current) setActionBusy('');
        }
    }, []);

    const clearDisplayedLogs = useCallback(() => {
        pendingLogsRef.current = [];
        setLogs([]);
        setLogTop(0);
        setNotice('Displayed logs cleared. The log file was not changed.');
    }, []);

    const scrollLogs = useCallback(
        (offset) => {
            const maximum = Math.max(0, logs.length - visibleLogRows);
            setFollowLogs(false);
            setLogTop((current) => clamp(current + offset, 0, maximum));
        },
        [logs.length, visibleLogRows],
    );

    const toggleFollow = useCallback(() => {
        setFollowLogs((current) => {
            const next = !current;
            if (next) setLogTop(Math.max(0, logs.length - visibleLogRows));
            setNotice(next ? 'Log follow enabled.' : 'Log follow paused.');
            return next;
        });
    }, [logs.length, visibleLogRows]);

    const selectTarget = useCallback(
        (offset) => {
            if (targets.length === 0) return;
            setSelectedIndex((current) => clamp(current + offset, 0, targets.length - 1));
        },
        [targets.length],
    );

    useEffect(() => {
        mountedRef.current = true;
        const flushTimer = setInterval(() => {
            if (pendingLogsRef.current.length === 0 || !mountedRef.current) return;

            const pending = pendingLogsRef.current;
            pendingLogsRef.current = [];
            setLogs((current) => current.concat(pending).slice(-MAX_LOG_ENTRIES));
        }, LOG_FLUSH_INTERVAL_MS);

        const handleControllerReady = (controller) => {
            if (!mountedRef.current) return;

            const missingMethods = validateController(controller);
            if (missingMethods.length > 0) {
                controllerUnavailableRef.current = !controller || typeof controller.stopAll !== 'function';
                setError(`Launcher controller is missing: ${missingMethods.join(', ')}.`);
            }

            if (!controller || typeof controller !== 'object') {
                if (shutdownRequestedRef.current) {
                    onExitCode(1);
                    exit();
                }
                return;
            }
            controllerRef.current = controller;
            setNotice('Portal launcher connected.');

            if (typeof controller.getSnapshot === 'function') {
                try {
                    updateSnapshot(controller.getSnapshot());
                } catch (controllerError) {
                    setError(`Unable to read launcher state: ${formatError(controllerError)}`);
                }
            }

            if (shutdownRequestedRef.current) {
                if (typeof controller.stopAll === 'function') {
                    stopController(controller, shutdownReasonRef.current || 'quit');
                } else {
                    onExitCode(1);
                    exit();
                }
            }
        };

        const handleLog = (entry) => {
            if (!mountedRef.current) return;
            pendingLogsRef.current.push({
                ...normalizeLogEntry(entry),
                id: ++nextLogIdRef.current,
            });
            if (pendingLogsRef.current.length > MAX_PENDING_LOG_ENTRIES) {
                pendingLogsRef.current.splice(
                    0,
                    pendingLogsRef.current.length - MAX_PENDING_LOG_ENTRIES,
                );
            }
        };

        let launcherPromise;
        try {
            launcherPromise = Promise.resolve(
                launchPortals({
                    ...(launchOptions ?? {}),
                    uiMode: 'external',
                    verbose: false,
                    debug: false,
                    onControllerReady: handleControllerReady,
                    onStateChange: updateSnapshot,
                    onLog: handleLog,
                }),
            );
        } catch (startupError) {
            launcherPromise = Promise.reject(startupError);
        }

        launcherPromise.then(
            (code) => {
                if (!mountedRef.current) return;
                onExitCode(code);
                exit();
            },
            (startupError) => {
                launcherRejectedRef.current = true;
                if (!mountedRef.current) return;
                onExitCode(1);
                if (shutdownRequestedRef.current) {
                    exit();
                    return;
                }
                setError(`Portal launcher failed: ${formatError(startupError)}`);
                setNotice('Launcher stopped before completion. Press q or Esc to close.');
            },
        );

        return () => {
            mountedRef.current = false;
            clearInterval(flushTimer);
            pendingLogsRef.current = [];
        };
    }, []);


    useEffect(() => {
        setSelectedIndex((current) => clamp(current, 0, Math.max(0, targets.length - 1)));
    }, [targets.length]);

    useEffect(() => {
        const maximum = Math.max(0, logs.length - visibleLogRows);
        setLogTop((current) => (followLogs ? maximum : clamp(current, 0, maximum)));
    }, [followLogs, logs.length, visibleLogRows]);

    useMouse((event) => {
        if (event.type === 'down' && event.button === 'wheel-up') {
            if (activeTab === 'logs') scrollLogs(-3);
            else selectTarget(-1);
            return;
        }
        if (event.type === 'down' && event.button === 'wheel-down') {
            if (activeTab === 'logs') scrollLogs(3);
            else selectTarget(1);
            return;
        }
        if (event.type === 'up') setMouseEvent(event);
    });

    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            requestShutdown('Ctrl+C');
            return;
        }
        if (key.escape) {
            requestShutdown('Escape');
            return;
        }
        if (input === 'q') {
            requestShutdown('q');
            return;
        }
        if (key.tab) {
            setActiveTab((current) => (current === 'dashboard' ? 'logs' : 'dashboard'));
            return;
        }
        if (input === '1') {
            setActiveTab('dashboard');
            return;
        }
        if (input === '2') {
            setActiveTab('logs');
            return;
        }

        if (activeTab === 'dashboard') {
            if (key.upArrow) selectTarget(-1);
            else if (key.downArrow) selectTarget(1);
            else if (input === 'r' && selectedTarget)
                invokeController(`Restarting ${selectedTarget.label}`, 'restart', selectedTarget.id);
            else if (input === 'R') invokeController('Restarting all targets', 'restartAll');
            else if (input === 'o' && selectedTarget)
                invokeController(`Opening ${selectedTarget.label}`, 'open', selectedTarget.id);
            else if (input === 's' && selectedTarget) {
                const method = isStoppedStatus(selectedTarget.status) ? 'start' : 'stop';
                const action = method === 'start' ? 'Starting' : 'Stopping';
                invokeController(`${action} ${selectedTarget.label}`, method, selectedTarget.id);
            }
            return;
        }

        if (key.upArrow) scrollLogs(-1);
        else if (key.downArrow) scrollLogs(1);
        else if (key.pageUp) scrollLogs(-visibleLogRows);
        else if (key.pageDown) scrollLogs(visibleLogRows);
        else if (input === 'f') toggleFollow();
        else if (input === 'c') clearDisplayedLogs();
    });

    const logWindow = logs.slice(logTop, logTop + visibleLogRows);
    const footerNotice = error || (isShuttingDown ? snapshot.shutdownReason || notice : notice);

    return h(
        MouseProvider,
        { event: mouseEvent },
        layoutMode === 'too-small'
            ? h(SmallTerminalNotice, { terminal })
            : h(
                  Box,
                  {
                      width: terminal.width,
                      height: terminal.height,
                      flexDirection: 'column',
                      borderStyle: layoutMode === 'full' ? 'round' : undefined,
                      borderColor: error ? 'red' : isShuttingDown ? 'yellow' : 'cyan',
                  },
                  h(Header, { snapshot, isShuttingDown, layoutMode, width: terminal.width }),
                  h(TabBar, { activeTab, onSelect: setActiveTab }),
                  h(
                      Box,
                      {
                          flexGrow: 1,
                          flexDirection: 'column',
                          paddingX: layoutMode === 'full' ? 1 : 0,
                      },
                      activeTab === 'dashboard'
                          ? h(DashboardView, {
                                targets: targetWindow.items,
                                totalTargets: targets.length,
                                targetIndexOffset: targetWindow.start,
                                selectedIndex: selectedIndex - targetWindow.start,
                                selectedTarget,
                                disabled: isShuttingDown || Boolean(actionBusy),
                                actionBusy,
                                controllerReady: Boolean(controllerRef.current),
                                width: terminal.width,
                                layoutMode,
                                onSelect: (index) => setSelectedIndex(targetWindow.start + index),
                                onStart: (target) =>
                                    invokeController(`Starting ${target.label}`, 'start', target.id),
                                onStop: (target) =>
                                    invokeController(`Stopping ${target.label}`, 'stop', target.id),
                                onRestart: (target) =>
                                    invokeController(`Restarting ${target.label}`, 'restart', target.id),
                                onOpen: (target) =>
                                    invokeController(`Opening ${target.label}`, 'open', target.id),
                                onRestartAll: () =>
                                    invokeController('Restarting all targets', 'restartAll'),
                                onStopAll: () => requestShutdown('Stop All'),
                            })
                          : h(LogsView, {
                                logs: logWindow,
                                total: logs.length,
                                top: logTop,
                                visibleRows: visibleLogRows,
                                follow: followLogs,
                                width: terminal.width,
                                layoutMode,
                                logPath: snapshot.logPath || launchOptions?.logPath,
                                onToggleFollow: toggleFollow,
                                onClear: clearDisplayedLogs,
                            }),
                  ),
                  h(Footer, {
                      activeTab,
                      notice: footerNotice,
                      error: Boolean(error),
                      width: terminal.width,
                      layoutMode,
                  }),
              ),
    );
}


function SmallTerminalNotice({ terminal }) {
    return h(
        Box,
        {
            width: terminal.width,
            height: terminal.height,
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            borderStyle: 'round',
            borderColor: 'yellow',
        },
        h(Text, { bold: true, color: 'yellow' }, 'Terminal too small'),
        h(Text, { color: 'gray' }, `${terminal.width}×${terminal.height} · resize to at least 40×8`),
    );
}

function Header({ snapshot, isShuttingDown, layoutMode, width }) {
    const counts = useMemo(() => countStatuses(snapshot.targets), [snapshot.targets]);
    const summary = snapshot.targets.length
        ? layoutMode === 'minimal'
            ? `${counts.ready}/${snapshot.targets.length} ready · ${counts.failed} failed`
            : `${counts.ready} ready · ${counts.starting} starting · ${counts.failed} failed · ${counts.stopped} stopped`
        : 'Waiting for targets';
    const title = layoutMode === 'full' ? 'CareContinuity Portal Dashboard' : 'CareContinuity Portals';
    const titleWidth = Math.min(title.length, Math.max(8, Math.floor(width * 0.45)));
    const summaryWidth = Math.max(8, width - titleWidth - 4);

    return h(
        Box,
        { paddingX: 1, justifyContent: 'space-between' },
        h(Text, { bold: true, color: 'cyan' }, truncateText(title, titleWidth)),
        h(
            Text,
            { color: isShuttingDown ? 'yellow' : counts.failed ? 'red' : 'gray' },
            truncateText(isShuttingDown ? 'STOPPING' : summary, summaryWidth),
        ),
    );
}

function TabBar({ activeTab, onSelect }) {
    return h(
        Box,
        { paddingX: 1, gap: 1 },
        h(Tab, {
            label: '1 Dashboard',
            active: activeTab === 'dashboard',
            onPress: () => onSelect('dashboard'),
        }),
        h(Tab, {
            label: '2 Logs',
            active: activeTab === 'logs',
            onPress: () => onSelect('logs'),
        }),
    );
}

function Tab({ label, active, onPress }) {
    const ref = useClickable(onPress);
    return h(
        Box,
        { ref },
        h(
            Text,
            { bold: active, color: active ? 'black' : 'gray', backgroundColor: active ? 'cyan' : undefined },
            ` ${label} `,
        ),
    );
}

function DashboardView({
    targets,
    totalTargets,
    targetIndexOffset,
    selectedIndex,
    selectedTarget,
    disabled,
    actionBusy,
    controllerReady,
    width,
    layoutMode,
    onSelect,
    onStart,
    onStop,
    onRestart,
    onOpen,
    onRestartAll,
    onStopAll,
}) {
    const full = layoutMode === 'full';
    const minimal = layoutMode === 'minimal';
    const windowLabel =
        totalTargets > targets.length
            ? `${targetIndexOffset + 1}-${targetIndexOffset + targets.length} of ${totalTargets}`
            : '';

    return h(
        Box,
        {
            flexGrow: 1,
            flexDirection: 'column',
            borderStyle: 'single',
            borderColor: 'gray',
            borderLeft: full,
            borderRight: full,
            borderBottom: full,
            borderTop: true,
        },
        minimal
            ? null
            : h(
                  Box,
                  { paddingX: 1, justifyContent: 'space-between' },
                  h(
                      Text,
                      { bold: true, color: 'gray' },
                      full
                          ? '  TARGET                 KIND       STATUS        URL'
                          : '  TARGET                     STATUS        URL',
                  ),
                  windowLabel ? h(Text, { color: 'gray' }, windowLabel) : null,
              ),
        targets.length === 0
            ? h(Box, { paddingX: 1 }, h(Text, { color: 'yellow' }, 'Waiting for launcher state…'))
            : targets.map((target, index) =>
                  h(TargetRow, {
                      key: target.id,
                      target,
                      selected: index === selectedIndex,
                      width,
                      layoutMode,
                      onPress: () => onSelect(index),
                  }),
              ),
        h(Box, { flexGrow: 1 }),
        full && selectedTarget
            ? h(TargetDetails, {
                  target: selectedTarget,
                  disabled: disabled || !controllerReady,
                  onStart,
                  onStop,
                  onRestart,
                  onOpen,
              })
            : null,
        full
            ? h(
                  Box,
                  { paddingX: 1, paddingBottom: 1, gap: 1, justifyContent: 'flex-end' },
                  actionBusy ? h(Text, { color: 'yellow' }, `${actionBusy}…`) : null,
                  h(ActionButton, {
                      label: 'Restart All',
                      color: 'cyan',
                      disabled: disabled || !controllerReady || totalTargets === 0,
                      onPress: onRestartAll,
                  }),
                  h(ActionButton, {
                      label: 'Stop All',
                      color: 'yellow',
                      disabled: disabled || !controllerReady,
                      onPress: onStopAll,
                  }),
              )
            : h(CompactDashboardActions, {
                  target: selectedTarget,
                  disabled: disabled || !controllerReady,
                  actionBusy,
                  width,
                  onStart,
                  onStop,
                  onRestart,
                  onOpen,
                  onRestartAll,
                  onStopAll,
              }),
    );
}

function TargetRow({ target, selected, width, layoutMode, onPress }) {
    const ref = useClickable(onPress);
    const status = truncateText(target.status || 'unknown', 12).padEnd(12);
    const color = target.color || (target.kind === 'backend' ? 'magenta' : 'white');

    if (layoutMode === 'minimal') {
        const labelWidth = Math.max(8, width - 18);
        const label = truncateText(target.label || target.id, labelWidth).padEnd(labelWidth);
        return h(
            Box,
            { ref, paddingX: 1 },
            h(Text, { color: selected ? 'cyan' : 'gray', bold: selected }, selected ? '› ' : '  '),
            h(Text, { color, bold: true }, label),
            h(Text, { color: statusColor(target.status), bold: true }, status),
        );
    }

    if (layoutMode === 'compact') {
        const label = truncateText(target.label || target.id, 24).padEnd(24);
        const url = truncateText(target.url || '—', Math.max(8, width - 43));
        return h(
            Box,
            { ref, paddingX: 1 },
            h(Text, { color: selected ? 'cyan' : 'gray', bold: selected }, selected ? '› ' : '  '),
            h(Text, { color, bold: true }, label),
            h(Text, { color: statusColor(target.status), bold: true }, ` ${status}`),
            h(Text, { color: target.url ? 'blueBright' : 'gray' }, ` ${url}`),
        );
    }

    const label = truncateText(target.label || target.id, 20).padEnd(20);
    const kind = truncateText(target.kind || 'target', 10).padEnd(10);
    const url = truncateText(target.url || '—', Math.max(8, width - 54));
    return h(
        Box,
        { ref, paddingX: 1 },
        h(Text, { color: selected ? 'cyan' : 'gray', bold: selected }, selected ? '› ' : '  '),
        h(Text, { color, bold: true }, label),
        h(Text, { color: 'gray' }, ` ${kind} `),
        h(Text, { color: statusColor(target.status), bold: true }, status),
        h(Text, { color: target.url ? 'blueBright' : 'gray' }, ` ${url}`),
    );
}

function CompactDashboardActions({
    target,
    disabled,
    actionBusy,
    width,
    onStart,
    onStop,
    onRestart,
    onOpen,
    onRestartAll,
    onStopAll,
}) {
    if (!target) return null;
    const stopped = isStoppedStatus(target.status);
    const canOpen = target.openable !== false && Boolean(target.url) && target.status === 'ready';

    return h(
        Box,
        { paddingX: 1, gap: 1, justifyContent: 'flex-end' },
        actionBusy && width >= 80
            ? h(Text, { color: 'yellow' }, truncateText(`${actionBusy}…`, 18))
            : null,
        h(CompactDashboardButton, {
            label: stopped ? 'Start' : 'Stop',
            color: stopped ? 'green' : 'yellow',
            disabled,
            onPress: () => (stopped ? onStart(target) : onStop(target)),
        }),
        h(CompactDashboardButton, {
            label: 'Restart',
            color: 'cyan',
            disabled: disabled || stopped,
            onPress: () => onRestart(target),
        }),
        h(CompactDashboardButton, {
            label: 'Open',
            color: 'blueBright',
            disabled: disabled || !canOpen,
            onPress: () => onOpen(target),
        }),
        width >= 60
            ? h(CompactDashboardButton, {
                  label: 'Restart All',
                  color: 'cyan',
                  disabled,
                  onPress: onRestartAll,
              })
            : null,
        h(CompactDashboardButton, {
            label: 'Stop All',
            color: 'yellow',
            disabled,
            onPress: onStopAll,
        }),
    );
}

function CompactDashboardButton({ label, color, disabled, onPress }) {
    const ref = useClickable(() => {
        if (!disabled) onPress();
    });
    return h(
        Box,
        { ref },
        h(
            Text,
            {
                color: disabled ? 'gray' : 'black',
                backgroundColor: disabled ? undefined : color,
                dimColor: disabled,
                bold: !disabled,
            },
            ` ${label} `,
        ),
    );
}

function TargetDetails({ target, disabled, onStart, onStop, onRestart, onOpen }) {
    const stopped = isStoppedStatus(target.status);
    const canRestart = !stopped;
    const canOpen = target.openable !== false && Boolean(target.url) && target.status === 'ready';
    const details = target.failureReason
        ? target.failureReason
        : target.lastRebuildDurationMs != null
          ? `Last rebuild: ${formatDuration(target.lastRebuildDurationMs)}`
          : target.readySignal || (target.adopted ? 'Existing server adopted' : '');

    return h(
        Box,
        { flexDirection: 'column', borderTop: true, borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
        details
            ? h(Text, { color: target.failureReason ? 'red' : 'gray' }, truncateText(details, 120))
            : null,
        h(
            Box,
            { gap: 1, paddingY: 1 },
            h(ActionButton, {
                label: stopped ? 'Start' : 'Stop',
                color: stopped ? 'green' : 'yellow',
                disabled,
                onPress: () => (stopped ? onStart(target) : onStop(target)),
            }),
            h(ActionButton, {
                label: 'Restart',
                color: 'cyan',
                disabled: disabled || !canRestart,
                onPress: () => onRestart(target),
            }),
            h(ActionButton, {
                label: 'Open',
                color: 'blueBright',
                disabled: disabled || !canOpen,
                onPress: () => onOpen(target),
            }),
        ),
    );
}

function ActionButton({ label, color, disabled, onPress }) {
    const ref = useClickable(() => {
        if (!disabled) onPress();
    });

    return h(
        Box,
        { ref, borderStyle: 'round', borderColor: disabled ? 'gray' : color, paddingX: 1 },
        h(Text, { color: disabled ? 'gray' : color, dimColor: disabled, bold: !disabled }, label),
    );
}

function LogsView({
    logs,
    total,
    top,
    visibleRows,
    follow,
    width,
    layoutMode,
    logPath,
    onToggleFollow,
    onClear,
}) {
    const position = total === 0 ? 'empty' : `${top + 1}-${Math.min(total, top + visibleRows)} of ${total}`;

    if (layoutMode === 'minimal') {
        return h(
            Box,
            {
                flexGrow: 1,
                flexDirection: 'column',
                borderTop: true,
                borderBottom: false,
                borderLeft: false,
                borderRight: false,
                borderStyle: 'single',
                borderColor: 'gray',
                paddingX: 1,
            },
            h(Text, { bold: true, color: 'cyan' }, 'Logs continue in the background'),
            h(Text, { color: 'blueBright' }, truncateText(logPath || 'scripts/logs/portals.log', width - 4)),
            h(Text, { color: 'gray' }, `${total} buffered entries · resize for the live viewer`),
        );
    }

    const full = layoutMode === 'full';
    return h(
        Box,
        {
            flexGrow: 1,
            flexDirection: 'column',
            borderStyle: 'single',
            borderColor: 'gray',
            borderLeft: full,
            borderRight: full,
            borderBottom: full,
            borderTop: true,
        },
        h(
            Box,
            { paddingX: 1, justifyContent: 'space-between' },
            h(Text, { bold: true, color: 'gray' }, 'TIME      TARGET         SOURCE   MESSAGE'),
            h(
                Box,
                { gap: 1 },
                h(Text, { color: follow ? 'green' : 'yellow' }, `${follow ? 'FOLLOW' : 'PAUSED'} · ${position}`),
                h(InlineButton, {
                    label: follow ? 'Pause' : 'Follow',
                    color: follow ? 'yellow' : 'green',
                    onPress: onToggleFollow,
                }),
                h(InlineButton, { label: 'Clear', color: 'gray', onPress: onClear }),
            ),
        ),
        logs.length === 0
            ? h(Box, { paddingX: 1 }, h(Text, { color: 'gray' }, 'No log entries to display.'))
            : logs.map((entry) => h(LogRow, { key: entry.id, entry, width })),
    );
}

function InlineButton({ label, color, onPress }) {
    const ref = useClickable(onPress);
    return h(Box, { ref }, h(Text, { color, inverse: true }, ` ${label} `));
}

function LogRow({ entry, width }) {
    const timestamp = formatTimestamp(entry.timestamp).padEnd(9);
    const target = truncateText(entry.targetLabel || entry.targetId || 'launcher', 14).padEnd(14);
    const source = truncateText(entry.source || 'stdout', 8).padEnd(8);
    const prefixWidth = timestamp.length + target.length + source.length + 5;
    const message = truncateText(entry.line, Math.max(10, width - prefixWidth));
    const isError = entry.source.toLowerCase() === 'stderr' || ERROR_PATTERN.test(entry.line);

    return h(
        Box,
        { paddingX: 1 },
        h(Text, { color: 'gray' }, timestamp),
        h(Text, { color: entry.targetColor || 'cyan' }, ` ${target}`),
        h(Text, { color: isError ? 'red' : 'gray' }, ` ${source}`),
        h(Text, { color: isError ? 'red' : 'white' }, ` ${message}`),
    );
}

function Footer({ activeTab, notice, error, width, layoutMode }) {
    const controls =
        layoutMode === 'minimal'
            ? activeTab === 'logs'
                ? '1 dashboard · q stop'
                : '↑/↓ select · s stop/start · r restart · 2 logs · q stop'
            : activeTab === 'logs'
              ? 'Tab/1/2 switch · ↑/↓ PgUp/PgDn scroll · f follow · c clear · q stop'
              : 'Tab/1/2 switch · ↑/↓ select · s start/stop · r restart · o open · q stop all';
    const controlsWidth = Math.min(controls.length, Math.max(20, Math.floor(width * 0.65)));
    const available = Math.max(5, width - controlsWidth - 6);

    return h(
        Box,
        { paddingX: 1, justifyContent: 'space-between' },
        h(Text, { color: error ? 'red' : 'gray' }, truncateText(notice, available)),
        h(Text, { color: 'gray', dimColor: true }, truncateText(controls, controlsWidth)),
    );
}

function useTerminalSize() {
    const { stdout } = useStdout();
    const getSize = useCallback(
        () => ({
            width: Number.isFinite(stdout.columns) ? Math.max(20, stdout.columns) : 80,
            height: Number.isFinite(stdout.rows) ? Math.max(8, stdout.rows - 1) : 23,
        }),
        [stdout],
    );
    const [size, setSize] = useState(getSize);

    useEffect(() => {
        let resizeTimer = null;
        const handleResize = () => {
            if (resizeTimer) return;
            resizeTimer = setTimeout(() => {
                resizeTimer = null;
                setSize(getSize());
            }, 50);
        };
        stdout.on?.('resize', handleResize);
        return () => {
            clearTimeout(resizeTimer);
            stdout.off?.('resize', handleResize);
        };
    }, [getSize, stdout]);

    return size;
}

function createInitialSnapshot(launchOptions) {
    const targets = Array.isArray(launchOptions?.targets)
        ? launchOptions.targets.map((target) => ({
              id: String(target.id),
              label: target.label ?? String(target.id),
              color: target.color ?? null,
              kind: target.kind ?? (target.backendAlias ? 'backend' : 'portal'),
              url: target.url ?? '',
              openable: target.openable !== false && Boolean(target.url),
              status: 'starting',
              startedAt: null,
              readyAt: null,
              failedAt: null,
              endedAt: null,
              failureReason: '',
              readySignal: '',
              lastRebuildDurationMs: null,
              adopted: false,
          }))
        : [];

    return {
        targets,
        isShuttingDown: false,
        shutdownReason: '',
        logPath: launchOptions?.logPath ?? '',
    };
}

function normalizeSnapshot(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.targets)) {
        throw new Error('Expected a snapshot with a targets array');
    }

    return {
        targets: value.targets.map((target, index) => ({
            ...target,
            id: String(target?.id ?? index),
            label: String(target?.label ?? target?.id ?? `Target ${index + 1}`),
            color: target?.color ? String(target.color) : null,
            kind: String(target?.kind ?? 'target'),
            url: target?.url ? String(target.url) : '',
            openable: target?.openable !== false && Boolean(target?.url),
            status: String(target?.status ?? 'unknown'),
            failureReason: cleanText(target?.failureReason),
            readySignal: cleanText(target?.readySignal),
            adopted: Boolean(target?.adopted),
        })),
        isShuttingDown: Boolean(value.isShuttingDown),
        shutdownReason: cleanText(value.shutdownReason),
        logPath: value.logPath ? String(value.logPath) : '',
    };
}

function normalizeLogEntry(entry) {
    return {
        targetId: entry?.targetId ? String(entry.targetId) : '',
        targetLabel: cleanText(entry?.targetLabel),
        targetColor: entry?.targetColor ? String(entry.targetColor) : null,
        source: cleanText(entry?.source) || 'stdout',
        line: cleanText(entry?.line),
        timestamp: entry?.timestamp ?? Date.now(),
    };
}

function validateController(controller) {
    const methods = ['getSnapshot', 'restart', 'stop', 'start', 'open', 'restartAll', 'stopAll'];
    if (!controller || typeof controller !== 'object') return methods;
    return methods.filter((method) => typeof controller[method] !== 'function');
}

function countStatuses(targets) {
    return targets.reduce(
        (counts, target) => {
            if (target.status === 'ready') counts.ready += 1;
            else if (target.status === 'failed') counts.failed += 1;
            else if (isStoppedStatus(target.status)) counts.stopped += 1;
            else counts.starting += 1;
            return counts;
        },
        { ready: 0, starting: 0, failed: 0, stopped: 0 },
    );
}

function isStoppedStatus(status) {
    return ['stopped', 'failed', 'exited', 'idle'].includes(status);
}

function statusColor(status) {
    if (status === 'ready') return 'green';
    if (status === 'failed') return 'red';
    if (status === 'rebuilding') return 'cyan';
    if (isStoppedStatus(status)) return 'gray';
    return 'yellow';
}

function formatDuration(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value)) return '—';
    if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
    return `${(value / 1000).toFixed(1)}s`;
}

function formatTimestamp(timestamp) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString([], { hour12: false }).slice(0, 8);
}

function formatError(error) {
    return cleanText(error instanceof Error ? error.message : error) || 'Unknown error';
}

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\r?\n/g, ' ')
        .trim();
}


function truncateText(value, maximum) {
    const text = cleanText(value);
    if (text.length <= maximum) return text;
    return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}


function normalizeExitCode(code) {
    const numeric = Number(code);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : 1;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
