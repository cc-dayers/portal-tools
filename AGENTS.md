# AGENTS.md — CareContinuity Portal Tools

Instructions for coding agents working in this repository.

## Project scope

This repository owns the optional Ink terminal UI for the CareContinuity
Portals launcher. It owns terminal rendering, interaction, protocol-client
handling, the standalone mock host, and UI tests. The authoritative launcher
configuration, module catalog, environment setup, build graph, Visual Studio
integration, and process lifecycle live in `carecontinuity.app/Portals`.

Do not duplicate backend commands, module paths, ports, or environment logic in
this repository. Consume choices and runtime state sent by the launcher host.

## Protocol compatibility

The current contract is `cc.portals.launcher.v1`, using newline-delimited JSON
over the host process's standard input and output.

- Presentation, layout, and interaction changes may ship independently.
- Add optional commands or fields only when older clients and hosts can safely
  ignore them, and advertise optional commands through host capabilities.
- Changes to existing handshake fields, commands, payloads, events, target
  statuses, or their semantics are breaking. Coordinate those changes with
  `carecontinuity.app/Portals` and introduce a new protocol version.
- Keep `dev/mock-launcher-host.mjs` and protocol tests aligned with the real host.

## Development and validation

Use Node.js 22 and the Yarn version pinned in `package.json`.

```powershell
corepack yarn install
corepack yarn check
corepack yarn test
```

Use `corepack yarn dev` or `corepack yarn dev:quick` for standalone development.
Use `corepack yarn visualize` when changing terminal layout. Intentional layout
changes require reviewing and updating the snapshots with `corepack yarn test -u`.

Keep changes scoped and match the existing JavaScript/ES module style. Do not
commit generated `node_modules/`, coverage, logs, temporary package archives, or
other build output.

## Release workflow

`.github/workflows/release.yml` is the only supported release publisher. It runs
when a tag matching `v*` is pushed, validates the package, creates
`cc-dayers-portal-tools.tgz`, creates the GitHub release, and uploads the asset.

For a new release:

1. Update both the `package.json` version and `PACKAGE_VERSION` in `src/cli.mjs`.
2. Run `corepack yarn check` and `corepack yarn test`.
3. Commit and push the release code to `main`.
4. Run `git tag vX.Y.Z` and `git push origin vX.Y.Z`.
5. Verify the Release workflow passes before testing installation from the
   CareContinuity Portals repository.

Do not run `gh release create`, manually upload the package archive, or create a
release in the GitHub UI. Those actions create the release before the tag-driven
workflow reaches its own `gh release create` step, causing the workflow to fail
with “a release with the same tag name already exists.” Never reuse or
force-move a published release tag.

Do not commit or push unless the user asks. Do not delete releases or tags
without explicit confirmation.
