# cc-portals-tui

A terminal UI for the CareContinuity Portals launcher. It shows the launcher's
configuration wizard, live target status, and logs, and controls the session
through the `cc.portals.launcher.v1` protocol.

## Using it

Install it as described in the [repository README](../../README.md#installing),
then run it from anywhere inside a `carecontinuity.app` checkout. It finds
`Portals/scripts/portal-launcher-host.mjs` by walking up from the current
folder.

```powershell
cc-portals-tui            # launch the saved configuration
cc-portals-tui --config   # reopen the configuration wizard first
cc-portals-tui --update   # install the newest tui-v* release
cc-portals-tui --help
```

Launcher flags such as `--config`, `--reset`, and `--verbose` are passed to the
host. Use `--host <path>` to point at a specific host script.

While the dashboard is running, press `a` to add a backend module without
restarting the session. The host offers background or Visual Studio execution,
and hot reload where the chosen mode supports it.

## Developing

Run these from `packages/tui`. The mock host in `packages/protocol` lets you
work on the UI without the Portals repository.

```powershell
corepack yarn dev         # mock host, starting in the configuration wizard
corepack yarn dev:quick   # mock host, launching a canned saved configuration
corepack yarn visualize   # render both UIs at a matrix of terminal sizes
corepack yarn build       # bundle into dist/bin.mjs
```

See [dev/README.md](dev/README.md) for mock scenarios, terminal-size rendering,
and layout snapshots. Intentional layout changes need reviewed snapshot updates
with `corepack yarn test -u` from the repository root.

The package is bundled with esbuild so it can carry the private protocol
package; Ink and React remain ordinary dependencies.
