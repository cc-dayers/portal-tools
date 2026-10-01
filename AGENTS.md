# AGENTS.md — CareContinuity Portal Tools

Instructions for coding agents working in this repository.

## Project scope

This repository owns optional clients for the CareContinuity Portals launcher,
as Yarn workspaces:

- `packages/protocol`: the `cc.portals.launcher.v1` client and the mock
  launcher host. Private; bundled into each tool, never published.
- `packages/tui`: `@cc-dayers/portal-tui`, the Ink terminal UI
  (`cc-portals-tui`), its dev tooling, and layout snapshots.
- `packages/vscode`: `cc-portal-launcher-vscode`, the VS Code sidebar
  extension (webview dashboard, presets, integration tests).

The authoritative launcher configuration, module catalog, environment setup,
build graph, Visual Studio integration, and process lifecycle live in
`carecontinuity.app/Portals`, which exposes them only through its protocol
host. That repository does not install, discover, or launch these clients.

Do not duplicate backend commands, module paths, ports, or environment logic in
this repository. Consume choices and runtime state sent by the launcher host.
Code shared by both tools belongs in `packages/protocol`, not in one tool that
the other imports from.

## Protocol compatibility

The current contract is `cc.portals.launcher.v1`, using newline-delimited JSON
over the host process's standard input and output.

- Presentation, layout, and interaction changes may ship independently.
- Add optional commands or fields only when older clients and hosts can safely
  ignore them, and advertise optional commands through host capabilities.
- Changes to existing handshake fields, commands, payloads, events, target
  statuses, or their semantics are breaking. Coordinate those changes with
  `carecontinuity.app/Portals` and introduce a new protocol version.
- Keep `packages/protocol/src/mock-launcher-host.mjs` and the protocol tests
  aligned with the real host.

## Development and validation

Use Node.js 22 and the Yarn version pinned in the root `package.json`.

```powershell
corepack yarn install
corepack yarn check
corepack yarn test
corepack yarn build
```

- TUI: from `packages/tui`, use `corepack yarn dev` or `corepack yarn dev:quick`
  against the mock host and `corepack yarn visualize` when changing terminal
  layout. Intentional layout changes require reviewing and updating snapshots
  with `corepack yarn test -u`.
- VS Code extension: run `corepack yarn test:integration` from
  `packages/vscode` when changing extension or webview behaviour. It runs in a
  downloaded VS Code Insiders, which works while VS Code Stable is open.

Keep changes scoped and match the existing JavaScript/ES module style. Do not
commit generated `node_modules/`, `dist/`, `.vscode-test/`, coverage, logs,
`.vsix` files, temporary package archives, or other build output.

## Release workflow

Each tool is released separately by a tag-triggered workflow:

| Tool | Tag | Workflow | Asset |
| --- | --- | --- | --- |
| TUI | `tui-vX.Y.Z` | `release-tui.yml` | `cc-dayers-portal-tui.tgz` |
| VS Code extension | `vscode-vX.Y.Z` | `release-vscode.yml` | `cc-portal-launcher-vscode.vsix` |

For a new release:

1. Update `version` in the tool's `package.json`. It is the only copy; the TUI
   reads its version from it.
2. Run `corepack yarn check` and `corepack yarn test`, plus the extension's
   integration tests when releasing it.
3. Commit and push the release code to `main`.
4. Tag the commit with the tool's prefix and push only that tag. The workflow
   fails if the tag does not match the package version.
5. Verify the release workflow passes before installing the published asset.

Do not run `gh release create`, manually upload an asset, or create a release
in the GitHub UI. Those actions create the release before the tag-driven
workflow reaches its own `gh release create` step, causing the workflow to fail
with “a release with the same tag name already exists.” Never reuse or
force-move a published release tag. Never rely on GitHub's "latest release":
the repository publishes several tools, so resolve releases by tag prefix.

Do not commit or push unless the user asks. Do not delete releases or tags
without explicit confirmation.
