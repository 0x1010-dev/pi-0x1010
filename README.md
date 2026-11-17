# pi-0x1010

A single repo holding many [Pi](https://github.com/badlogic/pi-mono) coding-agent extensions.
Each extension lives in `extensions/<name>/` and can be installed and enabled individually —
no separate repo per extension.

## Layout

```
extensions/
└── <name>/
    ├── index.ts      # the extension
    └── README.md     # what it does, requirements, config
```

## Install

Install the whole package once (from npm, git, or local path):

```bash
pi install ./pi-0x1010                                  # local
pi install git:github.com/<you>/pi-0x1010               # git
```

Then enable only the extensions you want. `pi config` lists discovered
resources for toggling, or select explicitly in settings:

```json
{
  "packages": [
    {
      "source": "git:github.com/<you>/pi-0x1010",
      "extensions": ["extensions/psp-tmux/index.ts"]
    }
  ]
}
```

For quick one-off testing without touching settings:

```bash
pi -e ./pi-0x1010/extensions/psp-tmux/index.ts
```

## Extensions

| Name | Status | Description |
|---|---|---|
| [`psp-tmux`](extensions/psp-tmux/) | WIP | Bridges Pi's Program Status Protocol (OSC 7501) through tmux via DCS passthrough, so terminals like Termius get status + push notifications even when Pi runs inside tmux. |

## Notes for contributors

- Pi supplies the `@earendil-works/*` packages and `typebox` at runtime;
  declare them in `peerDependencies` with `"*"` and never bundle them.
- Extensions are TypeScript, loaded directly by Pi (no build step).
- Per-extension README must state requirements (tmux version, terminal
  support, env vars) so each extension is self-contained.
