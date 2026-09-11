# Developing the TUI without the Portals monorepo

`cc-portals-tui` talks to whatever launcher host it's pointed at over a
small newline-JSON protocol (`cc.portals.launcher.v1`) via stdin/stdout of a
child process — see `src/protocol-client.mjs`. In production that host is
`../../scripts/portal-launcher-host.mjs` in the main Portals repo, which
spawns real dev servers.

`dev/mock-launcher-host.mjs` speaks the exact same protocol but fakes
everything: no real Vite/dotnet processes, no dependency on the Portals repo
at all. Point the TUI at it to iterate on the config wizard or dashboard UI
in isolation:

```sh
corepack yarn dev          # launches straight into the config wizard
corepack yarn dev:quick    # skips the wizard, uses a canned saved config
```

Both just run `node src/bin.mjs --host dev/mock-launcher-host.mjs`.

## Scenarios

Set `MOCK_SCENARIO` to change what the fake dashboard does after you launch:

| Scenario     | Behavior                                              |
| ------------ | ------------------------------------------------------ |
| `happy`      | (default) every target starts and reaches `ready`     |
| `one-fails`  | the last target fails to start                        |
| `flaky`      | one target flickers through `rebuilding` a couple times |
| `slow`       | targets take longer to become ready                    |

```sh
MOCK_SCENARIO=one-fails corepack yarn dev:quick
```

## Keeping the mock honest

`test/mock-launcher-host.test.mjs` spawns the mock host as a real child
process and drives it with the real `protocol-client.mjs`, so a change that
breaks the protocol contract (in either the mock or the client) fails a
test instead of silently drifting. Extend that file's scenarios alongside
any change to `dev/mock-launcher-host.mjs`.

## Seeing the actual rendered UI without a real terminal

Both `config-tui.mjs` and `dashboard-tui.mjs` are Ink apps: they render text
by drawing to whatever `stdout` stream they're given, so you don't need an
interactive terminal at all to see their output — you need a fake stream of
the size you want to test, which is what `dev/render-frame.mjs` provides.

`dev/visualize.mjs` uses it to print both UIs at a matrix of terminal sizes:

```sh
corepack yarn visualize                    # the whole default size matrix
node dev/visualize.mjs config 33 28        # one config-wizard frame
node dev/visualize.mjs dashboard 46 22     # one dashboard frame
```

Width/height on the command line are what a real terminal pane reports
(`stdout.columns` / `stdout.rows`) — note this is one row TALLER than the
size the app itself displays in its UI, because `useTerminalSize()` in both
files applies `height: stdout.rows - 1`. If a user reports "33x28" from what
the app printed on screen, reproduce it with `stdout.rows = 29`.

This script also flags any rendered line that overflows the given width,
which is itself a bug (Ink should never emit a line longer than the
terminal).

**Use this whenever changing layout code, before considering the change
done** — hand-tracing Yoga/flexbox math is necessary but not sufficient; two
real bugs (a width-floor mismatch between the wizard and the dashboard, and
a `borderStyle` implicitly drawing all four sides instead of the one
intended) both went unnoticed by careful reading and were only visible once
actually rendered.

`test/layout-snapshots.test.mjs` runs the same rendering across a fixed
size matrix automatically on every `yarn test`, asserting no line overflow
and snapshotting each frame so a future visual regression shows up as a
diff in review. Extend its `CONFIG_SIZES` / `DASHBOARD_SIZES` when
investigating a new reported size, and run `corepack yarn test -u` to
accept an intentional layout change.
