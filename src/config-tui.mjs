import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import {
    DISABLE_MOUSE_REPORTING,
    ENABLE_MOUSE_REPORTING,
    MouseProvider,
    useClickable,
    useMouse,
} from './mouse.mjs';
import { createThrottledOutput } from './output.mjs';
import { truncateText } from './text.mjs';

const h = React.createElement;

export function getConfigLayoutMode(width, height) {
    if (width < 48 || height < 12) return 'too-small';
    if (width < 72 || height < 14) return 'minimal';
    if (width < 100 || height < 26) return 'compact';
    return 'full';
}

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';
const EXIT_ALTERNATE_SCREEN = '\u001b[?1049l';

export function createInitialTuiDraft(config, defaultBackendModules = []) {
    const portals = Array.isArray(config.portals) && config.portals.length > 0
        ? config.portals
        : ['sso', 'provider'];
    const backendModules = Array.isArray(config.backendModules)
        ? config.backendModules
        : defaultBackendModules;
    const stackMode =
        config.environment === 'dev-api'
            ? 'dev-api'
            : config.environment === 'local' && backendModules.length === 0
              ? 'local-frontend'
              : 'local-full';

    return {
        portals,
        stackMode,
        backendModules,
        buildMode: config.buildMode === 'preview' ? 'preview' : 'dev',
        existingServerMode: config.existingServerMode ?? 'auto-restart',
        verbose: config.verbose ?? false,
        autoOpen: config.autoOpen ?? true,
    };
}

export function toLauncherConfig(draft) {
    const environment = draft.stackMode === 'dev-api' ? 'dev-api' : 'local';

    return {
        portals: draft.portals,
        environment,
        backendModules: draft.stackMode === 'local-full' ? draft.backendModules : [],
        buildMode: draft.buildMode,
        existingServerMode: draft.existingServerMode,
        verbose: draft.verbose,
        autoOpen: draft.autoOpen,
    };
}

export async function runPortalConfigTui({
    config,
    defaultBackendModules,
    portalChoices,
    backendChoices,
    existingServerChoices,
}) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('The --tui option requires an interactive terminal.');
    }

    let result = null;
    const throttledOutput = createThrottledOutput(process.stdout);
    process.stdout.write(`${ENTER_ALTERNATE_SCREEN}${ENABLE_MOUSE_REPORTING}`);

    try {
        const instance = render(
            h(PortalConfigApp, {
                initialDraft: createInitialTuiDraft(config, defaultBackendModules),
                portalChoices,
                backendChoices,
                existingServerChoices,
                onSubmit(value) {
                    result = toLauncherConfig(value);
                },
            }),
            {
                exitOnCtrlC: false,
                patchConsole: false,
                stdin: process.stdin,
                stdout: throttledOutput.stdout,
                stderr: process.stderr,
            },
        );

        await instance.waitUntilExit();
        return result;
    } finally {
        throttledOutput.dispose();
        process.stdout.write(DISABLE_MOUSE_REPORTING);
        process.stdout.write(EXIT_ALTERNATE_SCREEN);
    }
}

function PortalConfigApp({
    initialDraft,
    portalChoices,
    backendChoices,
    existingServerChoices,
    onSubmit,
}) {
    const { exit } = useApp();
    const terminal = useTerminalSize();
    const [draft, setDraft] = useState(initialDraft);
    const [sectionIndex, setSectionIndex] = useState(0);
    const [choiceIndex, setChoiceIndex] = useState(0);
    const [notice, setNotice] = useState('');
    const [mouseEvent, setMouseEvent] = useState(null);

    const sections = useMemo(
        () => buildSections(draft, portalChoices, backendChoices, existingServerChoices),
        [draft, portalChoices, backendChoices, existingServerChoices],
    );
    const activeSection = sections[sectionIndex] ?? sections[0];
    const activeChoice = activeSection.choices?.[choiceIndex];
    const layoutMode = getConfigLayoutMode(terminal.width, terminal.height);

    function selectSection(index) {
        setSectionIndex(index);
        setChoiceIndex(0);
        setNotice('');
    }

    function moveSection(offset) {
        selectSection((sectionIndex + offset + sections.length) % sections.length);
    }

    function moveChoice(offset) {
        const choices = activeSection.choices ?? [];
        if (choices.length === 0) return;
        setChoiceIndex((current) => (current + offset + choices.length) % choices.length);
        setNotice('');
    }

    function launch() {
        if (draft.portals.length === 0) {
            setNotice('Select at least one portal before launching.');
            return;
        }
        onSubmit(draft);
        exit();
    }

    function chooseChoice(section, choice, { advance = false } = {}) {
        if (section.id === 'review') {
            launch();
            return;
        }
        if (!choice) return;

        setDraft((current) => updateDraft(current, section, choice));
        setNotice('');

        if (advance && section.kind === 'single') moveSection(1);
    }

    function choose(options) {
        chooseChoice(activeSection, activeChoice, options);
    }

    useMouse((event) => {
        if (event.type === 'down' && event.button === 'wheel-up') {
            moveChoice(-1);
            return;
        }
        if (event.type === 'down' && event.button === 'wheel-down') {
            moveChoice(1);
            return;
        }
        if (event.type === 'up') setMouseEvent(event);
    });

    useInput((input, key) => {
        if ((key.ctrl && input === 'c') || key.escape || input === 'q') {
            exit();
            return;
        }

        if (key.tab || key.rightArrow) {
            moveSection(key.shift ? -1 : 1);
        } else if (key.leftArrow) {
            moveSection(-1);
        } else if (key.upArrow) {
            moveChoice(-1);
        } else if (key.downArrow) {
            moveChoice(1);
        } else if (input === ' ') {
            choose();
        } else if (key.return) {
            choose({ advance: true });
        }
    });

    return h(
        MouseProvider,
        { event: mouseEvent },
        layoutMode === 'too-small'
            ? h(SmallTerminalNotice, { terminal })
            : h(ConfigLayout, {
                  layoutMode,
                  terminal,
                  draft,
                  sections,
                  sectionIndex,
                  activeSection,
                  choiceIndex,
                  notice,
                  portalChoices,
                  backendChoices,
                  onSelectSection: selectSection,
                  onChoose(index, choice) {
                      setChoiceIndex(index);
                      chooseChoice(activeSection, choice);
                  },
                  onNext: () => moveSection(1),
                  onLaunch: launch,
                  onCancel: exit,
              }),
    );
}

function ConfigLayout({
    layoutMode,
    terminal,
    draft,
    sections,
    sectionIndex,
    activeSection,
    choiceIndex,
    notice,
    portalChoices,
    backendChoices,
    onSelectSection,
    onChoose,
    onNext,
    onLaunch,
    onCancel,
}) {
    const sharedDetails = {
        section: activeSection,
        activeChoiceIndex: choiceIndex,
        draft,
        portalChoices,
        backendChoices,
        onChoose,
        onNext,
        nextTitle: sections[sectionIndex + 1]?.title,
        onLaunch,
    };

    if (layoutMode === 'full') {
        return h(
            Box,
            {
                width: terminal.width,
                height: terminal.height,
                flexDirection: 'column',
                borderStyle: 'round',
                borderColor: 'cyan',
            },
            h(Header, { draft }),
            h(
                Box,
                { flexGrow: 1, paddingX: 1, paddingY: 1 },
                h(SectionList, {
                    sections,
                    activeIndex: sectionIndex,
                    onSelect: onSelectSection,
                }),
                h(SectionDetails, sharedDetails),
            ),
            h(Footer, {
                notice,
                reviewActive: activeSection.id === 'review',
                onCancel,
            }),
        );
    }

    return h(
        Box,
        {
            width: terminal.width,
            height: terminal.height,
            flexDirection: 'column',
        },
        h(CompactHeader, { draft, sectionIndex, sectionCount: sections.length }),
        h(CompactSectionTabs, {
            sections,
            activeIndex: sectionIndex,
            width: terminal.width,
            onSelect: onSelectSection,
        }),
        h(CompactSectionDetails, {
            ...sharedDetails,
            width: terminal.width,
            showDescription: layoutMode === 'compact' && terminal.height >= 16,
        }),
        h(CompactFooter, {
            notice,
            reviewActive: activeSection.id === 'review',
            width: terminal.width,
            onCancel,
        }),
    );
}

function CompactHeader({ draft, sectionIndex, sectionCount }) {
    const environment = draft.stackMode === 'dev-api' ? 'DEV API' : 'LOCAL';
    return h(
        Box,
        { paddingX: 1, justifyContent: 'space-between' },
        h(Text, { bold: true, color: 'cyan' }, 'CareContinuity Portals'),
        h(
            Text,
            { color: 'gray' },
            `${sectionIndex + 1}/${sectionCount} · ${environment} · ${draft.portals.length} portal${draft.portals.length === 1 ? '' : 's'}`,
        ),
    );
}

function CompactSectionTabs({ sections, activeIndex, width, onSelect }) {
    if (width < 90) {
        const previous = sections[activeIndex - 1];
        const current = sections[activeIndex];
        const next = sections[activeIndex + 1];
        return h(
            Box,
            { paddingX: 1, justifyContent: 'space-between' },
            previous
                ? h(CompactTab, {
                      label: `← ${compactSectionTitle(previous)}`,
                      onPress: () => onSelect(activeIndex - 1),
                  })
                : h(Text, null, ''),
            h(Text, { bold: true, color: 'cyan' }, compactSectionTitle(current)),
            next
                ? h(CompactTab, {
                      label: `${compactSectionTitle(next)} →`,
                      onPress: () => onSelect(activeIndex + 1),
                  })
                : h(Text, null, ''),
        );
    }

    return h(
        Box,
        { paddingX: 1, gap: 1 },
        ...sections.map((section, index) =>
            h(CompactTab, {
                key: section.id,
                label: compactSectionTitle(section),
                active: index === activeIndex,
                onPress: () => onSelect(index),
            }),
        ),
    );
}

function CompactTab({ label, active = false, onPress }) {
    const ref = useClickable(onPress);
    return h(
        Box,
        { ref },
        h(
            Text,
            {
                bold: active,
                color: active ? 'black' : 'gray',
                backgroundColor: active ? 'cyan' : undefined,
            },
            ` ${label} `,
        ),
    );
}

function CompactSectionDetails({
    section,
    activeChoiceIndex,
    draft,
    portalChoices,
    backendChoices,
    onChoose,
    onNext,
    nextTitle,
    onLaunch,
    width,
    showDescription,
}) {
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
        h(Text, { bold: true, color: 'cyan' }, section.title),
        showDescription ? h(Text, { color: 'gray' }, truncateText(section.description, width - 4)) : null,
        h(
            Box,
            { flexGrow: 1, flexDirection: 'column' },
            section.id === 'review'
                ? h(Review, { draft, portalChoices, backendChoices, width: width - 4 })
                : h(ChoiceList, {
                      section,
                      activeChoiceIndex,
                      onChoose,
                      compact: true,
                  }),
        ),
        h(
            Box,
            { justifyContent: 'flex-end' },
            section.id === 'review'
                ? h(CompactActionButton, { label: '▶ LAUNCH PORTALS', color: 'green', onPress: onLaunch })
                : h(CompactActionButton, {
                      label: `NEXT: ${compactSectionTitle({ title: nextTitle })} →`,
                      color: 'cyan',
                      onPress: onNext,
                  }),
        ),
    );
}

function CompactActionButton({ label, color, onPress }) {
    const ref = useClickable(onPress);
    return h(
        Box,
        { ref },
        h(Text, { bold: true, color: 'black', backgroundColor: color }, ` ${label} `),
    );
}

function CompactFooter({ notice, reviewActive, width, onCancel }) {
    const fallback = reviewActive
        ? 'Enter/click launch · ←/→ step · q cancel'
        : '↑/↓ choose · Space select · Enter next · ←/→ step · q cancel';
    const ref = useClickable(onCancel);
    return h(
        Box,
        { paddingX: 1, justifyContent: 'space-between' },
        h(Text, { color: notice ? 'yellow' : 'gray' }, truncateText(notice || fallback, width - 14)),
        h(Box, { ref }, h(Text, { color: 'gray' }, 'q cancel')),
    );
}

function compactSectionTitle(section) {
    if (!section) return 'Done';
    const titles = {
        Environment: 'Env',
        'Backend modules': 'Backend',
        'Build mode': 'Build',
        'Existing servers': 'Servers',
        'Review + launch': 'Launch',
    };
    return titles[section.title] ?? section.title;
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
        h(Text, { color: 'gray' }, `${terminal.width}×${terminal.height} · need 48×12`),
    );
}

function Header({ draft }) {
    const environment = draft.stackMode === 'dev-api' ? 'DEV API' : 'LOCAL';

    return h(
        Box,
        { paddingX: 2, paddingTop: 1, justifyContent: 'space-between' },
        h(
            Box,
            { flexDirection: 'column' },
            h(Text, { bold: true, color: 'cyan' }, 'CareContinuity Portal Launcher'),
            h(Text, { color: 'gray' }, 'Configure the frontend development workspace'),
        ),
        h(
            Box,
            { gap: 1 },
            h(Text, { color: 'black', backgroundColor: 'cyan', bold: true }, ` ${environment} `),
            h(
                Text,
                { color: 'black', backgroundColor: 'green', bold: true },
                ` ${draft.portals.length} PORTAL${draft.portals.length === 1 ? '' : 'S'} `,
            ),
        ),
    );
}

function SectionList({ sections, activeIndex, onSelect }) {
    return h(
        Box,
        {
            width: 30,
            flexShrink: 0,
            flexDirection: 'column',
            borderStyle: 'single',
            borderColor: 'gray',
            paddingX: 1,
            marginRight: 1,
        },
        h(Text, { bold: true, color: 'gray' }, 'SETUP'),
        h(Box, { height: 1 }),
        ...sections.map((section, index) =>
            h(SectionItem, {
                key: section.id,
                section,
                active: index === activeIndex,
                onPress: () => onSelect(index),
            }),
        ),
    );
}

function SectionItem({ section, active, onPress }) {
    const ref = useClickable(onPress);

    return h(
        Box,
        { ref, flexDirection: 'column' },
        h(
            Text,
            { bold: active, color: active ? 'cyan' : 'white' },
            `${active ? '›' : ' '} ${section.title}`,
        ),
        h(
            Box,
            { marginLeft: 3 },
            h(Text, { color: 'gray', dimColor: true }, section.summary),
        ),
    );
}

function SectionDetails({
    section,
    activeChoiceIndex,
    draft,
    portalChoices,
    backendChoices,
    onChoose,
    onNext,
    nextTitle,
    onLaunch,
}) {
    return h(
        Box,
        {
            flexGrow: 1,
            flexDirection: 'column',
            borderStyle: 'single',
            borderColor: 'gray',
            paddingX: 2,
            paddingY: 1,
        },
        h(Text, { bold: true, color: 'cyan' }, section.title),
        h(Text, { color: 'gray' }, section.description),
        h(Box, { height: 1 }),
        h(
            Box,
            { flexGrow: 1, flexDirection: 'column' },
            section.id === 'review'
                ? h(Review, { draft, portalChoices, backendChoices })
                : h(ChoiceList, {
                      section,
                      activeChoiceIndex,
                      onChoose,
                  }),
        ),
        h(
            Box,
            { justifyContent: 'flex-end' },
            section.id === 'review'
                ? h(LaunchButton, { onPress: onLaunch })
                : h(NextButton, { nextTitle, onPress: onNext }),
        ),
    );
}

function ChoiceList({ section, activeChoiceIndex, onChoose, compact = false }) {
    return h(
        Box,
        { flexDirection: 'column' },
        ...section.choices.map((choice, index) =>
            h(ChoiceItem, {
                key: String(choice.value),
                section,
                choice,
                active: index === activeChoiceIndex,
                compact,
                onPress: () => onChoose(index, choice),
            }),
        ),
    );
}

function ChoiceItem({ section, choice, active, compact, onPress }) {
    const ref = useClickable(onPress);
    const marker = section.kind === 'multi'
        ? choice.selected
            ? '[●]'
            : '[ ]'
        : choice.selected
          ? '(●)'
          : '( )';

    return h(
        Box,
        { ref, flexDirection: 'column', marginBottom: compact ? 0 : 1 },
        h(
            Box,
            null,
            h(Text, { color: active ? 'cyan' : 'gray', bold: active }, `${active ? '›' : ' '} ${marker} `),
            h(
                Text,
                {
                    color: choice.color ?? (choice.selected ? 'green' : 'white'),
                    bold: active || choice.selected,
                },
                choice.label,
            ),
        ),
        choice.description && !compact
            ? h(Text, { color: 'gray', dimColor: true }, `      ${choice.description}`)
            : null,
    );
}

function Review({ draft, portalChoices, backendChoices, width = Number.POSITIVE_INFINITY }) {
    const portalNames = labelsFor(draft.portals, portalChoices);
    const backendNames = labelsFor(draft.backendModules, backendChoices);
    const rows = [
        ['Portals', portalNames.join(', ') || 'None'],
        ['Environment', stackModeLabel(draft.stackMode)],
        ['Backend', draft.stackMode === 'local-full' ? backendNames.join(', ') || 'None' : 'Skipped'],
        ['Build', draft.buildMode === 'preview' ? 'Build + Preview' : 'Dev Server'],
        ['Output', draft.verbose ? 'Live terminal stream' : 'Quiet log file'],
        ['Browser', draft.autoOpen ? 'Open when ready' : 'Do not open'],
    ];

    return h(
        Box,
        { flexDirection: 'column' },
        ...rows.map(([label, value]) =>
            h(
                Box,
                { key: label },
                h(Text, { color: 'gray' }, `${label.padEnd(13)} `),
                h(Text, { color: 'green' }, truncateText(value, Math.max(8, width - 15))),
            ),
        ),
    );
}

function NextButton({ nextTitle, onPress }) {
    const ref = useClickable(onPress);
    return h(
        Box,
        { ref, borderStyle: 'round', borderColor: 'cyan', paddingX: 2 },
        h(Text, { bold: true, color: 'cyan' }, `NEXT: ${nextTitle} →`),
    );
}

function LaunchButton({ onPress }) {
    const ref = useClickable(onPress);
    return h(
        Box,
        { ref, borderStyle: 'double', borderColor: 'green', paddingX: 4, paddingY: 1 },
        h(Text, { bold: true, color: 'green' }, '▶  LAUNCH PORTALS'),
    );
}

function Footer({ notice, reviewActive, onCancel }) {
    return h(
        Box,
        { paddingX: 2, paddingBottom: 1, justifyContent: 'space-between' },
        h(
            Text,
            { color: notice ? 'yellow' : 'gray' },
            notice ||
                (reviewActive
                    ? 'Enter/click launches'
                    : 'Click an option · ↑/↓ choose · Space select · ←/→ section'),
        ),
        h(CancelButton, { onPress: onCancel }),
    );
}

function CancelButton({ onPress }) {
    const ref = useClickable(onPress);
    return h(Box, { ref }, h(Text, { color: 'gray' }, 'Esc/q/click cancel'));
}

function buildSections(draft, portalChoices, backendChoices, existingServerChoices) {
    const sections = [
        {
            id: 'portals',
            title: 'Portals',
            description: 'Choose one or more React applications to start.',
            summary: `${draft.portals.length} selected`,
            kind: 'multi',
            field: 'portals',
            choices: withSelection(portalChoices, draft.portals),
        },
        {
            id: 'stackMode',
            title: 'Environment',
            description: 'Choose where APIs run and whether local backend modules are included.',
            summary: stackModeLabel(draft.stackMode),
            kind: 'single',
            field: 'stackMode',
            choices: withSelection(
                [
                    {
                        label: 'Local — full-stack',
                        value: 'local-full',
                        description: 'Local API and selected .NET backend modules',
                    },
                    {
                        label: 'Local — frontend only',
                        value: 'local-frontend',
                        description: 'Local frontend portals without backend modules',
                    },
                    {
                        label: 'Dev API',
                        value: 'dev-api',
                        description: 'Remote development environment API',
                    },
                ],
                draft.stackMode,
            ),
        },
    ];

    if (draft.stackMode === 'local-full') {
        sections.push({
            id: 'backendModules',
            title: 'Backend modules',
            description: 'Choose the local .NET services to run. An empty selection is allowed.',
            summary: `${draft.backendModules.length} selected`,
            kind: 'multi',
            field: 'backendModules',
            choices: withSelection(backendChoices, draft.backendModules),
        });
    }

    sections.push(
        {
            id: 'buildMode',
            title: 'Build mode',
            description: 'Use fast development servers or production-style preview builds.',
            summary: draft.buildMode === 'preview' ? 'Build + Preview' : 'Dev Server',
            kind: 'single',
            field: 'buildMode',
            choices: withSelection(
                [
                    { label: 'Dev Server', value: 'dev' },
                    { label: 'Build + Preview', value: 'preview' },
                ],
                draft.buildMode,
            ),
        },
        {
            id: 'existingServerMode',
            title: 'Existing servers',
            description: 'Choose how occupied portal ports should be handled.',
            summary: existingServerChoices.find((choice) => choice.value === draft.existingServerMode)?.label,
            kind: 'single',
            field: 'existingServerMode',
            choices: withSelection(existingServerChoices, draft.existingServerMode),
        },
        {
            id: 'verbose',
            title: 'Output',
            description: 'Choose between the status board and a live child-process stream.',
            summary: draft.verbose ? 'Live' : 'Quiet',
            kind: 'single',
            field: 'verbose',
            choices: withSelection(
                [
                    { label: 'Quiet — status board + log file', value: false },
                    { label: 'Live — stream child output', value: true },
                ],
                draft.verbose,
            ),
        },
        {
            id: 'autoOpen',
            title: 'Browser',
            description: 'Open selected portals after every target reports ready.',
            summary: draft.autoOpen ? 'Open when ready' : 'Do not open',
            kind: 'single',
            field: 'autoOpen',
            choices: withSelection(
                [
                    { label: 'Open browser on launch', value: true },
                    { label: 'Do not open browser', value: false },
                ],
                draft.autoOpen,
            ),
        },
        {
            id: 'review',
            title: 'Review + launch',
            description: 'Confirm the launch plan before saving the configuration.',
            summary: 'Ready',
            kind: 'action',
            choices: [],
        },
    );

    return sections;
}

function withSelection(choices, selected) {
    const selectedValues = Array.isArray(selected) ? new Set(selected) : null;
    return choices.map((choice) => ({
        ...choice,
        selected: selectedValues ? selectedValues.has(choice.value) : selected === choice.value,
    }));
}

function updateDraft(draft, section, choice) {
    if (section.kind === 'multi') {
        const selected = new Set(draft[section.field]);
        if (selected.has(choice.value)) {
            if (section.field === 'portals' && selected.size === 1) return draft;
            selected.delete(choice.value);
        } else {
            selected.add(choice.value);
        }
        return { ...draft, [section.field]: [...selected] };
    }

    return { ...draft, [section.field]: choice.value };
}

function labelsFor(values, choices) {
    return values.map((value) => choices.find((choice) => choice.value === value)?.label ?? value);
}

function stackModeLabel(stackMode) {
    if (stackMode === 'dev-api') return 'Dev API';
    if (stackMode === 'local-frontend') return 'Local frontend only';
    return 'Local full-stack';
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
