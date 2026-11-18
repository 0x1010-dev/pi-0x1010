# psp-tmux

Bridge Pi's Program Status Protocol (OSC 7501) through tmux.

## Problem

Pi reports its state (working / blocked / done / error / idle) with OSC 7501
after the terminal answers the protocol's feature-detection query. tmux does
not forward OSC 7501 (open upstream request: tmux/tmux#5713), so terminals
behind tmux — e.g. Termius, which turns these reports into push
notifications — never see Pi's state.

## Approach

A Pi extension re-emits state changes wrapped in tmux's DCS passthrough
envelope. With `set -g allow-passthrough on`, tmux intercepts the envelope,
undoes the escaping, and writes the bare OSC 7501 to the outer terminal.
The spec (rev 0.3+) allows programs to send reports without the
feature-detection query, so terminals should accept them.

Envelope bytes (verified against the tmux man page, `allow-passthrough`
option docs, and independent tmux-wrapper implementations):

```
ESC P tmux; <payload> ESC \        where <payload> = OSC 7501 with every
                                   ESC (0x1b) replaced by ESC ESC
```

Example: a `state=done:app=pi` report goes out as
`1b 50 74 6d 75 78 3b 1b 1b 5d 37 35 30 31 3b … 1b 1b 5c 1b 5c`.

**Verified live against tmux 3.8**: a pane wrote this exact envelope with
`allow-passthrough on`; the attached (outer) client received the bare
`ESC ] 7501 ; … ESC \` and nothing else — no wrapped-form leakage.
Note: tmux forwards passthrough to attached clients only; writes made while
no client is attached are dropped (irrelevant for a live TUI).

The state machine mirrors pi's interactive `ProgramStatusReporter`
(`dist/modes/interactive/program-status-reporter.js`): precedence
blocked > compacting > working > resting, dedupe by full status key,
session name in working/done messages, first line of errors only.
Encoding reuses `formatProgramStatus` from `@earendil-works/pi-tui`.

On `session_shutdown` the extension sends `state=clear` — pi's native
clear only fires for probe-confirmed terminals, which never happens
behind tmux.

## Messages

One line, middle-dot separated, capped (tool line 80 chars, full message
150). The report carries the text in both the `title` and `msg` keys —
Termius renders `title`, Rex/Ghostty render `msg`; pi-tui's own encoder
only emits `msg`, so the extension uses a small local encoder for this.

| State | Message |
|---|---|
| working | session name |
| done | `session · N turns · duration` (e.g. `my-notebook · 3 turns · 3m 12s`; session falls back to `pi`) |
| blocked, permission | `tool: first input line` (e.g. `bash: git push --force origin main`) |
| blocked, other | dialog title |
| error | first error line, plus ` (last: tool)` when a tool ran last |
| idle | none |

All of it is harvested from existing events (`tool_call`, `turn_start`,
timestamps) — no model calls.

## Requirements

- tmux ≥ 3.2 with `allow-passthrough on` (global or per-window). Default is
  `off`. `all` also works; `on` is sufficient.
- A terminal client that implements OSC 7501 (Termius iOS ≥ 8.2.0 / Android
  beta, Rex, Ghostty)
- Only active when the `TMUX` env var is set and stdout is a TTY;
  otherwise Pi's native probe-based reporting is used and this extension
  stays silent

## Extension events used

`agent_start`, `agent_settled` (`aborted`), `message_end` (assistant
`stopReason`/`errorMessage`), `session_before_compact` / `session_compact` /
`session_compact_failed` (`reason`, `aborted`, `errorMessage`),
`ui_prompt_start` / `ui_prompt_end` (`kind`, `title`), `session_start`,
`session_info_changed` (session name), `session_shutdown`.

Note: the internal `compaction_start`/`compaction_end` events consumed by
pi's own reporter are **not** exposed to extensions; the `session_*_compact`
events are the public equivalents and are emitted for manual, threshold,
and overflow compactions alike.

Kind mapping for blocked prompts: `confirm` → `permission`, all other
`ui_prompt` kinds → `question` (matches interactive-mode's mapping).
`auth` (login) is an interactive-mode-only path, not reachable from an
extension.

## Open questions

1. **Termius on-device verification**: does it act on unsolicited OSC 7501
   reports (no probe round-trip)? The spec permits it (rev 0.3: "a program
   MAY send reports without querying first"), but this needs confirmation
   on a real device. If Termius requires the probe, answering it would need
   raw stdin access, which extensions do not currently expose — that would
   be a pi feature request (or an upstream tmux OSC 7501 fix, tmux/tmux#5713).

## Status

Implemented and envelope-verified against tmux 3.8 (see above). 20 unit
tests cover the envelope encoding, the full state machine
(working/done/error/idle, blocked stacking and unwinding, compaction
outcomes, aborts, dedupe) and the message formats.
