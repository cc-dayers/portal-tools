# CareContinuity Portal Tools

Optional clients for the CareContinuity Portals development launcher. The
launcher in `carecontinuity.app/Portals` owns every launch decision; these
tools only present it and send commands through its `cc.portals.launcher.v1`
protocol. You never need them to run `yarn start`.

| Package | What it is | Install |
| --- | --- | --- |
| [`packages/tui`](packages/tui/README.md) | `cc-portals-tui`, a terminal UI | npm, from a GitHub release |
| [`packages/vscode`](packages/vscode/README.md) | Portal Launcher, a VS Code sidebar | `.vsix`, from a GitHub release |
| [`packages/protocol`](packages/protocol) | Protocol client and mock host shared by both | Not published; bundled into each tool |

## Installing

Each tool is released separately. Pick a version from the
[releases page](https://github.com/cc-dayers/portal-tools/releases): TUI
releases are tagged `tui-vX.Y.Z` and extension releases `vscode-vX.Y.Z`.

Terminal UI:

```powershell
npm install --global https://github.com/cc-dayers/portal-tools/releases/download/tui-vX.Y.Z/cc-dayers-portal-tui.tgz
cd L:\src\carecontinuity.app
cc-portals-tui
```

Try it without installing: `npx --package <the same URL> cc-portals-tui`.
Once installed, `cc-portals-tui --update` moves to the newest TUI release.

VS Code extension: download `cc-portal-launcher-vscode.vsix` from a
`vscode-v*` release, then run:

```powershell
code --install-extension cc-portal-launcher-vscode.vsix
```

Open `carecontinuity.app` in VS Code and choose **Portal Launcher** in the
Activity Bar.

## Repository boundary

This repository owns presentation, interaction, the protocol client, the mock
host, and each tool's packaging. `carecontinuity.app/Portals` owns the
portals and backend modules on offer, run modes, build and environment setup,
Visual Studio integration, child-process ownership, saved configuration, and
the protocol host. The host sends its choices to the clients; do not copy
module lists, commands, ports, or environment logic into this repository.

## Protocol compatibility

The current contract is `cc.portals.launcher.v1`: newline-delimited JSON over
the launcher host's standard input and output. Presentation changes can ship
without changing the protocol.

Keep v1 compatible when changing the handshake, session configuration and
choices, command names and payloads, state, log, error and exit events, or
target status values. Optional fields that older clients and hosts can ignore
may stay in v1. Breaking changes need a new protocol version and coordinated
changes in both repositories. Keep the mock host in `packages/protocol` aligned
with the real host.

## Developing

Node.js 22 and the Yarn version pinned in `package.json` are required.

```powershell
corepack yarn install
corepack yarn check     # syntax checks for every package
corepack yarn test      # Vitest suites for every package
corepack yarn build     # TUI and extension bundles
```

Each package README covers its own development loop: the TUI's mock-host and
layout tooling, and the extension's debug configurations and VS Code
integration tests.

## Releasing

Releases are created only by the tag-triggered workflows in
`.github/workflows`. Do not create a GitHub release or upload an asset by hand:
creating a release also creates its tag, which starts the workflow, and the
workflow then fails because the release already exists.

1. Update `version` in the tool's `package.json` (`packages/tui` or
   `packages/vscode`).
2. Run `corepack yarn check`, `corepack yarn test`, and, for the extension,
   `corepack yarn workspace cc-portal-launcher-vscode test:integration`.
3. Push the release commit to `main`.
4. Tag it as `tui-vX.Y.Z` or `vscode-vX.Y.Z` and push only that tag. The
   workflow fails if the tag does not match the package version.
5. Wait for the release workflow to pass, then install the published asset
   as described above.

Never reuse or force-move a published release tag. If a release fails, read
the workflow log before changing tags.
