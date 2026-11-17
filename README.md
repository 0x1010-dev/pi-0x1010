# pi-0x1010

A single repo holding many [Pi](https://github.com/badlogic/pi-mono) coding-agent extensions.
Each extension lives in `extensions/<name>/` and can be installed and enabled individually —
no separate repo per extension.

## Layout

```
extensions/<name>/
├── index.ts     # entry — always here, registered in the root pi manifest
├── src/         # extra modules (only for larger extensions)
├── *.test.ts    # tests, node:test API (or test/ dir)
└── README.md    # what it does, requirements, config — self-contained
```

The root `package.json` is the single pi package: it declares the
`pi.extensions` manifest (an explicit manifest is required — otherwise Pi
discovers every `.ts` file under `extensions/`, tests included), all runtime
`dependencies`, and dev tooling. One `tsconfig.json` covers the tree.

## Install

Install the whole package once (from npm, git, or local path):

```bash
pi install ./pi-0x1010                                  # local
pi install git:github.com/0x1010-dev/pi-0x1010          # git
```

Then enable only the extensions you want. `pi config` lists discovered
resources for toggling, or select explicitly in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/0x1010-dev/pi-0x1010",
      "extensions": ["extensions/pi-notebook/index.ts"]
    }
  ]
}
```

For quick one-off testing without touching settings:

```bash
pi -e ./pi-0x1010/extensions/pi-notebook/index.ts
```

## Extensions

| Name | Status | Description |
|---|---|---|
| [`pi-notebook`](extensions/pi-notebook/) | stable | Durable, file-based memory: rules in `AGENTS.md`, per-project handoff, searchable memories. Zero background model calls. |
| [`pi-visual-stats`](extensions/pi-visual-stats/) | stable | Prompt-box bottom border as a live context progress bar + compact footer. |
| [`psp-tmux`](extensions/psp-tmux/) | implemented | Bridges Pi's Program Status Protocol (OSC 7501) through tmux via DCS passthrough, so terminals like Termius get status + push notifications even when Pi runs inside tmux. Termius acceptance pending on-device verification. |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit over the whole tree
npm test            # tsx --test, all extensions' node:test suites
```

## Notes for contributors

Conventions (keep every extension evolving the same way):

- **Entry**: `extensions/<name>/index.ts`, listed by the root
  `pi.extensions` glob. No per-extension `package.json`.
- **Dependencies**: runtime deps go in the root `dependencies`.
  Pi supplies the `@earendil-works/*` packages and `typebox` at runtime;
  declare them in `peerDependencies` with `"*"` and never bundle them.
- **Language**: TypeScript, loaded directly by Pi (no build step).
  Imports between local files may use explicit `.ts` extensions.
- **Tests**: node:test API, run by the root `npm test`
  (`tsx --test "extensions/**/*.test.ts"`). Tests must not depend on the
  repo root being the CWD — resolve paths from `import.meta.dirname`.
- **No build/dev artifacts in the tree**: no lockfiles, bunfig, tsconfigs,
  `.pi` dev symlinks, or dev-link scripts per extension.
- **README**: per-extension README states requirements (terminal support,
  tmux version, env vars) and install/enable instructions so each extension
  is self-contained.
