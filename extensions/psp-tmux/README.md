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
envelope (`ESC P tmux; … ESC \`, inner ESCs doubled). With
`set -g allow-passthrough on`, tmux intercepts the envelope and writes the
bare OSC 7501 to the outer terminal. The spec (rev 0.3+) allows programs to
send reports without the feature-detection query, so Termius should accept
them.

## Requirements

- tmux with `allow-passthrough on` (global or per-window)
- A terminal client that implements OSC 7501 (Termius iOS ≥ 8.2.0 / Android
  beta, Rex, Ghostty)
- Only active when the `TMUX` env var is set; otherwise Pi's native
  probe-based reporting is used and this extension stays silent

## Verified facts (research 2026-11-13)

From the OSC 7501 spec (rev 0.4, superlogical.com/rex/docs/build/program-status) and pi's
installed source (`dist/modes/interactive/program-status-reporter.js`):

- Grammar: `ESC ] 7501 ; key=value(:key=value)* ST`. ST = `ESC \` or BEL.
  Keys: `state` (required: `idle|working|done|blocked|error|clear`), `id`,
  `kind` (`permission|question|auth`, blocked only), `progress` (0–100),
  `app` (identifier), `title`/`msg` (base64 UTF-8, no control chars). Max
  4096 bytes per sequence.
- **Feature detection is optional** (rev 0.3): "a program MAY send reports
  without querying first, for example when it cannot read replies." This is
  the spec basis for emitting unconditionally through tmux — Termius
  acceptance still needs on-device verification.
- Each report replaces its record completely: repeat `app` in every report.
- pi's own reporter (interactive mode) tracks: `working` on agent_start /
  compaction, `blocked` while dialogs wait, `done`/`error` on agent_settled
  (error if last assistant message stopReason=error), `idle` on abort.
- Extension events to mirror that: `agent_start`, `agent_settled` (has
  `event.aborted`), `message_end` (stopReason), `compaction_start/end`,
  `ui_prompt_start` / `ui_prompt_end` (kind: select|confirm|input|editor|custom,
  title). There is no dedicated error event — derive from `message_end`.
- Raw `process.stdout.write` of OSC sequences from an extension is an
  accepted pattern (see pi's shipped `notify.ts` example).

## Open questions (resolve in next session)

1. Termius: does it act on unsolicited OSC 7501 reports (no probe round-trip)?
2. tmux DCS passthrough: exact escaping rules — inner ESC doubling, ST handling,
   `allow-passthrough on` vs `all`, tmux version requirement.
3. How pi-tui serializes `ProgramStatus` to OSC bytes (reuse encoding if exposed).
4. Whether `agent_settled` + `message_end` suffice for the error state, or a
   dedicated retry/error path is needed.

## Status

WIP — scaffolded, not implemented.
