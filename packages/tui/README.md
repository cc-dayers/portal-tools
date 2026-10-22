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
cc-portals-tui --forget-session # discard a stale connection, NOT stop processes
```

Launcher flags such as `--config`, `--reset`, and `--verbose` are passed to the
host. Use `--host <path>` to point at a specific host script.

While the dashboard is running, press `a` to add a backend module without
restarting the session. The host offers background or Visual Studio execution,
and hot reload where the chosen mode supports it.

### Shadow DB Setup

With a launcher host advertising `setup.check`, prerequisites are checked before
the dashboard starts. Missing tools open the launcher's setup flow in your terminal;
installation requires explicit confirmation, and licenses and administrator prompts
remain interactive. After successful setup, the host refreshes its environment and
rechecks prerequisites before launching. Declining or cancelling starts no targets.
If setup fails or needs a restart, resolve it and run the TUI again. Noninteractive
performance runs report the setup guide without installing anything. Older hosts
retain their existing launch behavior.

## Persistent sessions

With an updated application host, the TUI reconnects automatically to its previous
session for that host path. Press **d** to detach without stopping portals, then
run `cc-portals-tui` again to recover live status, controls, the host's active
configuration, and up to 500 recent log entries. Closing a terminal unexpectedly
also leaves the session recoverable if its host survives. **q**, **Esc**,
**Ctrl+C**, and **Stop All** still request shutdown.

Startup flags such as `--config` do not reconfigure a recovered running session;
stop it first to configure a new one. Older hosts do not offer Detach and retain
their previous lifecycle. Internal performance measurements remain nonpersistent.

Connection references and keys are local to your OS account under
`~/.cc-portals/tui-sessions` (not the repository). Files use owner-only permissions
on Unix and inherit your user-profile access controls on Windows. Do not copy,
share, or commit these files. A stale or already-connected session blocks a new
launch: retry after the other TUI detaches, or stop surviving processes separately
and explicitly run `--forget-session` before starting replacements. Forgetting
does not shut anything down. Sessions cannot survive a host crash or reboot.

TUI session discovery is separate from the VS Code extension's SecretStorage.
This does not attach to extension-owned sessions, and one host accepts only one
connected client at a time.

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
