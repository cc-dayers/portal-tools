# CareContinuity Portal Tools

`@cc-dayers/portal-tools` provides the optional terminal UI for the
CareContinuity Portals development launcher. The TUI renders configuration,
status, logs, and process controls. The authoritative launch behavior remains
in the main CareContinuity repository.

## Using the TUI

From the `Portals` directory in `carecontinuity.app`:

```powershell
yarn start --install-tui
yarn start --tui
```

The first command installs the latest GitHub release globally. Rerun it to
update an existing installation. Use `yarn start --tui --config` to reopen the
configuration wizard. The standard `yarn start` launcher remains available
without installing this package.

From a running dashboard, press `a` to add a backend module without restarting
the existing session. The host offers background or Visual Studio execution
and optional hot reload when supported by the selected mode.

Do not normally invoke `cc-portals-tui` directly. The Portals launcher supplies
the matching host script and repository context.

## Repository boundary

This repository owns:

- Ink components, layout, keyboard and mouse interaction
- The configuration wizard and runtime dashboard presentation
- Client-side protocol handling
- Standalone mock-host development and terminal-layout tests

The `carecontinuity.app/Portals` repository owns:

- Available portals and backend modules
- Backend run modes, build targets, and dependency ordering
- PowerShell-derived environment configuration and Azure authentication
- Visual Studio integration
- Child-process ownership, readiness, restart, and shutdown behavior
- Saved launcher configuration and the protocol host

The host sends available choices to the TUI. Avoid duplicating module lists,
commands, ports, or environment logic here.

## Protocol compatibility

The current contract is `cc.portals.launcher.v1`, transported as newline-delimited
JSON over the launcher host's standard input and output. Presentation-only
changes can be released without changing the protocol.

Keep v1 compatible when changing:

- The handshake protocol name and supported version
- Session configuration fields and choice objects
- Command names and payloads
- State, log, error, and exit events
- Target status values and controller semantics

Additive optional fields can remain in v1 when both older clients and hosts can
safely ignore them. Breaking field, command, event, or behavior changes require
a new protocol version and coordinated changes in both repositories.

## Developing independently

Node.js 22 and the package-pinned Yarn version are required. The included mock
host allows UI work without cloning or starting backend modules:

```powershell
corepack yarn install
corepack yarn dev
corepack yarn dev:quick
corepack yarn visualize
```

See [dev/README.md](dev/README.md) for mock scenarios, terminal-size rendering,
and snapshot guidance. Before releasing, run:

```powershell
corepack yarn check
corepack yarn test
```

## Publishing a release

The Portals installer downloads an asset named `cc-dayers-portal-tools.tgz`
from the latest GitHub release. Releases are created by
`.github/workflows/release.yml` when a `v*` tag is pushed. Do not create the
GitHub release or upload the archive manually: creating a release also creates
the tag, which triggers the workflow and makes its final `gh release create`
step fail because the release already exists.

1. Update the version in `package.json` and `PACKAGE_VERSION` in `src/cli.mjs`.
2. Run `corepack yarn check` and `corepack yarn test`.
3. Merge or push the release commit to `main`.
4. Create the matching tag locally: `git tag vX.Y.Z`.
5. Push only the tag: `git push origin vX.Y.Z`.
6. Wait for the Release workflow to pass. It runs validation, creates the
   archive, publishes the GitHub release, and attaches the correctly named asset.
7. From `carecontinuity.app/Portals`, run `yarn start --install-tui` and verify
   `cc-portals-tui --protocol-info`.

If a release must be repaired, inspect the failed workflow before changing or
recreating tags. Never reuse or force-move a published release tag.
