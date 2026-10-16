# Portal Launcher for VS Code

A VS Code sidebar for the CareContinuity Portals launcher. It starts the
launcher host in your `carecontinuity.app` workspace and shows every portal and
backend as a card with live status and the actions that state allows.

## Features

- **Dashboard.** Frontend and backend cards with progress indicators, ports,
  hot-reload tags, inline failure reasons, and Start, Stop, Restart, Open, and
  Show Logs actions, also available from each card's context menu.
- **Starter presets.** All portals or the core portals against the dev API, or
  all portals against a local API, matching `yarn start:all-dev-api`,
  `yarn start:core-dev-api`, and `yarn start:all`.
- **Your presets.** Save a running session or a new configuration as a preset
  for the workspace, then launch, edit, rename, or delete it.
- **Last used.** Named configurations keep their nickname; unnamed launches show
  a summary using the host's portal and stack labels. The name and details survive
  an extension restart. Older history without a stored name gains one on its next launch.
- **Preset settings.** Open the single gear in the extension's title bar to edit or delete custom
  presets and choose Compact or Full display. Compact uses rocket launch
  actions with descriptions on nickname hover; Full includes descriptions and
  a labeled Launch action. Edit launch cards through their right-click menus.
  The display preference is stored in the VS Code user setting
  `ccPortalLauncher.presets.displayMode` (default: `full`). Editing defaults to
  saving without launching; editing a starter saves a custom copy.
- **Reset to defaults.** In Preset settings, confirm Reset to defaults to clear
  this workspace's custom presets and launch history, restore the default display
  preference, and return to first-run helper text with search and filters cleared. Available
  only while idle; application launcher configuration and other workspaces' presets
  are unchanged. The display preference is a user setting shared across workspaces.
- **Configure.** A step-by-step Quick Pick with Back navigation.
- **Session configuration.** The edit icon in a running session opens its current
  configuration. Apply changes with a confirmed stop-and-relaunch, or save a
  preset without stopping the session. Cancelling leaves the session running.
- **Add backend.** Add a module to a running session in the background, with
  hot reload, or in Visual Studio.
- The Activity Bar badge counts failed targets, and logs go to the
  **CareContinuity Portal Launcher** output channel.

The extension activates only when its view is opened, starts no processes until
you launch, and requires a trusted workspace.

### Shadow DB Setup

With a launcher host advertising `setup.check`, missing Shadow DB prerequisites
are detected before targets start. Choose **Open Setup** to run the launcher's
existing setup flow in an integrated terminal. Installation still requires your
confirmation there; package licenses and administrator prompts are not bypassed.
After successful setup, the host refreshes its environment and rechecks the tools
before the requested launch continues. Cancelling leaves targets unstarted.
If setup fails or requires a restart, resolve it in the terminal and launch again.
Older hosts retain their existing launch behavior.

## Installing

Download `cc-portal-launcher-vscode.vsix` from a `vscode-v*` release on the
[releases page](https://github.com/cc-dayers/portal-tools/releases), then run
`code --install-extension cc-portal-launcher-vscode.vsix`.

## Developing

Open the `portal-tools` repository in VS Code. `.vscode/launch.json` has two
configurations, and both build the extension first:

- **Portal Launcher extension (mock host)** uses the mock host, so no real
  processes start.
- **Portal Launcher extension (real launcher)** opens a sibling
  `carecontinuity.app` checkout and uses its real launcher.

If the debugger cannot attach, use **Run Without Debugging** (`Ctrl+F5`).

From `packages/vscode`:

```powershell
corepack yarn build              # development bundle in dist/
corepack yarn test:integration   # build, then run the tests in VS Code Insiders
corepack yarn package            # production .vsix
```

Unit tests for the view model run with the repository's `corepack yarn test`.
Integration tests use `@vscode/test-cli` with the mock host as the workspace's
launcher. They run in a downloaded VS Code Insiders, because command-line test
runs cannot share a running VS Code Stable instance.
