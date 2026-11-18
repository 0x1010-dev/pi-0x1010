import type { ProgramStatus } from "@earendil-works/pi-tui";
import { replaceControlCharacters } from "@earendil-works/pi-tui";

const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Encode a status report as OSC 7501. Mirrors pi-tui's `formatProgramStatus`
 * (kept local rather than post-processed so the `title` key can be added):
 * Termius renders `title`, Rex/Ghostty render `msg`, so both carry the same
 * text.
 */
export function formatReport(status: ProgramStatus): string {
	const pairs = [`state=${status.state}`];
	if (status.app !== undefined && APP_PATTERN.test(status.app))
		pairs.push(`app=${status.app}`);
	if (status.state === "blocked" && status.kind) pairs.push(`kind=${status.kind}`);
	const message = status.message
		? replaceControlCharacters(status.message).trim()
		: "";
	if (message) {
		pairs.push(`title=${b64(message)}`);
		pairs.push(`msg=${b64(message)}`);
	}
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/**
 * tmux DCS passthrough envelope. tmux intercepts `ESC P tmux; … ESC \`,
 * undoes the ESC doubling in the payload, and writes the bare sequence to the
 * outer terminal (requires `set -g allow-passthrough on`, tmux >= 3.2).
 */
export function tmuxPassthrough(sequence: string): string {
	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max - 1) + "\u2026";
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

/** One short line describing a tool call's target, for blocked messages. */
function toolInputLine(input: unknown): string {
	if (typeof input === "string") return truncate(firstLine(input), 80);
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		const v = o.command ?? o.path ?? o.pattern;
		if (typeof v === "string") return truncate(firstLine(v), 80);
	}
	try {
		return truncate(JSON.stringify(input) ?? "", 80);
	} catch {
		return "";
	}
}

/** The extension events the state machine consumes (structural subset). */
export type PspTmuxEvent =
	| { type: "agent_start" }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "turn_start" }
	| { type: "tool_call"; toolName: string; input: unknown }
	| {
			type: "message_end";
			message: { role: string; stopReason?: string; errorMessage?: string };
	  }
	| { type: "session_before_compact"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_compact"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "session_compact_failed";
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
	  }
	| { type: "ui_prompt_start"; kind: string; title?: string }
	| { type: "ui_prompt_end"; kind: string; title?: string };

/**
 * Mirrors pi's interactive `ProgramStatusReporter` (dist/modes/interactive/
 * program-status-reporter.js), fed by public extension events instead of
 * interactive-mode internals. Precedence: blocked > compacting > working >
 * resting. Each report replaces the terminal's record completely, so `app`
 * repeats in every report.
 *
 * Messages (one line, middle-dot separated, capped):
 * - working: session name
 * - done: `session · N turns · duration` (baked in at settle)
 * - blocked (permission): `tool: first input line` (e.g. `bash: git push …`)
 * - blocked (other): dialog title
 * - error: first error line + ` (last: tool)` when a tool ran last
 * - idle: none
 */
export class PspTmuxState {
	readonly app: string;
	runActive = false;
	compacting = false;
	/** Outcome of the current run, reported once it settles. */
	runResult: ProgramStatus = { state: "done" };
	/** Status while no run is active. */
	restingStatus: ProgramStatus = { state: "idle" };
	/** Open prompts, oldest first; the most recent one is reported. */
	private prompts: { status: ProgramStatus; label: string }[] = [];
	private lastReport: string | undefined;
	/** Turns in the current run, for done metadata. */
	private turns = 0;
	private runStartedAt: number | undefined;
	/** Last tool called, for blocked and error messages. */
	private lastTool: { name: string; line: string } | undefined;

	constructor(
		app: string,
		private readonly getSessionName: () => string | undefined,
	) {
		this.app = app;
	}

	/**
	 * Handle one event. Returns the OSC 7501 sequence to write, or undefined
	 * when the visible status is unchanged (dedupe by full status key).
	 *
	 * Outcome events (`message_end`, compaction failures) record the run
	 * result but do not re-report: like the interactive reporter, they only
	 * change what is shown once a state transition makes the outcome visible.
	 */
	handle(event: PspTmuxEvent): string | undefined {
		switch (event.type) {
			case "agent_start":
				this.runActive = true;
				this.runResult = { state: "done" };
				this.turns = 0;
				this.runStartedAt = Date.now();
				return this.report();
			case "turn_start":
				this.turns++;
				return undefined;
			case "tool_call":
				this.lastTool = {
					name: event.toolName,
					line: toolInputLine(event.input),
				};
				return undefined;
			case "message_end": {
				// The latest assistant response decides the outcome, so a
				// retried error is replaced by its successful retry.
				if (event.message.role !== "assistant") return undefined;
				if (event.message.stopReason === "error") {
					const line = firstLine(event.message.errorMessage);
					this.runResult = {
						state: "error",
						message: truncate(
							this.lastTool ? `${line} (last: ${this.lastTool.name})` : line,
							150,
						),
					};
				} else {
					this.runResult = { state: "done" };
				}
				return undefined;
			}
			case "session_before_compact":
				this.compacting = true;
				return this.report();
			case "session_compact": {
				// Success: the run continues (recovery) or, when idle and manual,
				// the resting status becomes done.
				this.compacting = false;
				if (!this.runActive && event.reason === "manual")
					this.restingStatus = { state: "done" };
				return this.report();
			}
			case "session_compact_failed": {
				// A failed recovery compaction ends the run unless a later
				// response succeeds.
				this.compacting = false;
				if (event.aborted) {
					if (this.runActive) this.runResult = { state: "idle" };
					else this.restingStatus = { state: "idle" };
					return this.report();
				}
				if (event.errorMessage) {
					if (this.runActive) {
						this.runResult = {
							state: "error",
							message: firstLine(event.errorMessage),
						};
						return undefined;
					}
					if (event.reason === "manual") {
						this.restingStatus = {
							state: "error",
							message: firstLine(event.errorMessage),
						};
						return this.report();
					}
				}
				return undefined;
			}
			case "agent_settled": {
				this.runActive = false;
				if (event.aborted) {
					// An aborted run's turn count is noise: plain idle.
					this.restingStatus = { state: "idle" };
				} else {
					// Bake done metadata in at settle: session · turns · duration.
					if (
						this.runResult.state === "done" &&
						this.runStartedAt !== undefined
					) {
						const name = this.getSessionName() ?? "pi";
						const parts = [
							name,
							`${this.turns} turn${this.turns === 1 ? "" : "s"}`,
							formatDuration(Date.now() - this.runStartedAt),
						];
						this.runResult = {
							state: "done",
							message: truncate(parts.join(" \u00b7 "), 150),
						};
					}
					this.restingStatus = this.runResult;
				}
				return this.report();
			}
			case "ui_prompt_start": {
				// Permission prompts show what the tool wants to do:
				// `bash: git push origin main` beats a generic title.
				let message = event.title ?? event.kind;
				if (event.kind === "confirm" && this.lastTool) {
					const line = this.lastTool.line;
					message = truncate(
						line ? `${this.lastTool.name}: ${line}` : this.lastTool.name,
						150,
					);
				}
				this.prompts = [
					...this.prompts,
					{
						status: {
							state: "blocked",
							kind: event.kind === "confirm" ? "permission" : "question",
							message,
						},
						// The title/kind identifies the prompt on ui_prompt_end,
						// even when the reported message is the tool line.
						label: event.title ?? event.kind,
					},
				];
				return this.report();
			}
			case "ui_prompt_end": {
				// Drop the matching open prompt; fall back to the oldest when
				// labels collide (e.g. two untitled prompts of one kind).
				const label = event.title ?? event.kind;
				const i = this.prompts.findIndex(
					(p) => p.label === label || (!event.title && p.label === event.kind),
				);
				this.prompts.splice(i >= 0 ? i : 0, 1);
				return this.report();
			}
		}
	}

	/** Re-emit the current status (e.g. after the session name changes). */
	report(): string | undefined {
		const status = { ...this.currentStatus(), app: this.app };
		const key = JSON.stringify(status);
		if (key === this.lastReport) return undefined;
		this.lastReport = key;
		return formatReport(status);
	}

	/** Forget a previous run (session switch, reload). Returns a report. */
	reset(): string | undefined {
		this.runActive = false;
		this.compacting = false;
		this.runResult = { state: "done" };
		this.restingStatus = { state: "idle" };
		this.prompts = [];
		this.turns = 0;
		this.runStartedAt = undefined;
		this.lastTool = undefined;
		return this.report();
	}

	private currentStatus(): ProgramStatus {
		const blocked = this.prompts.at(-1);
		if (blocked) return blocked.status;
		if (this.compacting) return { state: "working", message: "Compacting context" };
		const status: ProgramStatus = this.runActive
			? { state: "working" }
			: this.restingStatus;
		// The session name fills in only when no message is baked in
		// (done carries `session · turns · duration`; working the name).
		if ((status.state === "working" || status.state === "done") && !status.message) {
			const name = this.getSessionName();
			return name ? { ...status, message: name } : status;
		}
		return status;
	}
}
