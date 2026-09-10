# Developing the TUI without the Portals monorepo

`cc-portals-tui` talks to whatever launcher host it's pointed at over a
small newline-JSON protocol (`cc.portals.launcher` v1) via stdin/stdout of a
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
