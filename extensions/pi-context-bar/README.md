# pi-context-bar

Pi extension: turns the prompt box's bottom border into a live, predictive context bar, and cleans up the footer below it.

![preview](./preview.png)

## What it looks like

```
┌────────────────────────────────────────────────────────────────┐
│ type your prompt...
├━━━━━━━━━━━━━━━──┄┄┄┄·┄┄┄┄┄┄ 42k/200k ┤
  ~/Code/path (main *3 ↑1↓2)                      gpt-5.1 · high
```

(heavy `━` = context before this turn; normal bold `─` at the fill edge = everything this turn has added; dotted `┄` = headroom.)

- **Bottom border** of the prompt box, left to right — glyphs carry the state, not color:
  - **fill** (`━`, heavy) = the context **before this turn** (baseline captured when your prompt started the run); idle, the full used count. Hued by the *urgency* of the current total: `success` green normally, `warning` when within 2× the average per-run growth of the compaction threshold, `error` at/over it. Heavy = settled weight
  - **turn growth head** (`─`, normal, **bold**) at the fill edge — everything added since your prompt: committed model output, thinking, and tool results (`used − baseline`) plus the in-flight streaming estimate (chars/4). At least one cell while any growth exists; grows on every commit and every streamed delta. When the turn settles, the whole segment *thickens* into the heavy fill in one settle. Fill + head always equals the current total
  - **dotted headroom** (`┄`) = the unfilled part of the line, always in the editor's live border color (thinking-level aware, e.g. violet at `high`, bash-mode green in bash mode). Dotted so the fill and head read as "real" context
  - `·` (inline middle dot) marks the auto-compaction threshold (window − compaction reserveTokens), in the headroom's own color
  - line ends in ` used/total` dimmed (unknown usage: `?/total`) — the only numbers in the bar (no turn counter, no timer; by design)
- **Compaction is visible** in the stats slot: `compacting…` (warning), `compacted → 12k` flash (success, ~6 s), or `compact failed · <reason>` (error, reason = manual/threshold/overflow)
- **Bottom status**: lines hidden below the editor render Pi's native border instead of the bar — solid line, centered ` ↓ N more `, all in the border color
- **Footer**: cwd + git branch with working-tree state `(main *3 ↑1↓2` = dirty count, ahead, behind — each shown only when non-zero) + extension statuses left; `model · effort` right. Both parts dimmed via `theme.fg("dim")` per part, exactly like pi's original footer (token/cache/cost stats removed; context usage lives in the border bar)

## Installing

This extension ships in the [pi-0x1010](../../README.md) package:

```bash
pi install git:github.com/0x1010-dev/pi-0x1010
pi install ./pi-0x1010         # local path
```

Enable just this extension in settings (`pi config`), or one-off with
`pi -e ./pi-0x1010/extensions/pi-context-bar/index.ts`.

No runtime dependencies: pi's own packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) are declared as `*` peerDependencies and supplied by the host.

## Layout

Part of the [pi-0x1010](../../README.md) monorepo — no per-extension
`package.json`, build step, or dev-link scripts. The root `package.json` is the
single pi package (manifest, `peerDependencies`, scripts); one root
`tsconfig.json` covers the tree.

```
index.ts                     # extension entry: session_start wiring, event/timer wiring, /cbar toggle
src/
  status-bar.ts              # pure bar renderer (unit tested)
  editor.ts                  # CustomEditor subclass overriding the bottom border
  footer.ts                  # custom footer component factory
  state.ts                   # session-scoped store: burn history, in-flight tokens, compaction flash
  git.ts                     # cached git working-tree status (porcelain + ahead/behind)
test/status-bar.test.ts      # renderer suite (node:test, run by the root npm test)
test/state.test.ts           # store suite: transitions, burn window, flash TTL
test/git.test.ts             # porcelain + ahead/behind parsers
test/footer.test.ts          # cwd + branch formatting
scripts/
  render-preview.ts          # preview frames via the REAL renderer -> JSON cells
  draw-preview.py            # JSON cells -> preview.png (PIL, Noto Sans Mono)
preview.png                  # committed gallery preview (root pi.image)
```

### How the intelligence works

- **Burn rate** — on `agent_start` the store baselines `getContextUsage().tokens`; on `agent_settled` the delta is pushed into a 5-run sliding window. That average drives the urgency hue (green → amber → red).
- **Turn growth head** — the baseline is captured at `agent_start`. While the turn runs, head = `(used − baseline) + in-flight chars/4`: it grows when messages and tool results commit (pi's used count moves) and live on every `message_update` delta; at `agent_settled` the baseline becomes the total and the head thickens into the fill. The fill therefore shows the *pre-turn* baseline — never the run's total growth on top of a fill that already contains it (that double-counting showed as an overshoot at each message end). Compaction mid-turn re-baselines, so the head only ever shows post-compaction growth.
- **Compaction** — `session_before_compact` swaps the stats to `compacting…`; `session_compact` flashes the new usage; `session_compact_failed` tints the bar red with the reason.
- **Git** — `git status --porcelain` + `rev-list --left-right --count @{upstream}...HEAD`, cached; refreshed on `agent_start`, `agent_settled`, and every 5 s (never per render).

## Dev

From the repo root:

```bash
npm install
npm run typecheck   # tsc --noEmit over the whole tree
npm test            # tsx --test, all extensions' node:test suites
```

### Regenerating the preview

`preview.png` is rendered by the real `buildBottomBar` (four states: idle,
mid-turn growth, warning, compacting) — it cannot drift from what ships. Requires Python 3 + PIL and Noto Sans Mono (or DejaVu Sans Mono):

```bash
npx tsx extensions/pi-context-bar/scripts/render-preview.ts \
  | python3 extensions/pi-context-bar/scripts/draw-preview.py \
    extensions/pi-context-bar/preview.png
```

The `@earendil-works/*` packages are peerDependencies supplied by the host at
runtime — declare, never bundle. Tests must resolve paths from
`import.meta.dirname`, not the CWD.

## Disable

`/cbar` toggles the whole extension on/off per session.
