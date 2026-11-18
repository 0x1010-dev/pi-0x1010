import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
	formatDuration,
	formatReport,
	PspTmuxState,
	tmuxPassthrough,
	truncate,
} from "../src/state.ts";

function state(name?: string): PspTmuxState {
	return new PspTmuxState("pi", () => name);
}

const osc = (s: string) => s.replace(/\x1b/g, "\\e");

/** Decode the base64 `msg` of an OSC report ("" when absent). */
function msgOf(oscSeq: string | undefined): string {
	const m = oscSeq?.match(/msg=([A-Za-z0-9+/=]+)/);
	return m ? Buffer.from(m[1], "base64").toString("utf8") : "";
}

test("formatDuration", () => {
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(192_000), "3m 12s");
	assert.equal(formatDuration(3_720_000), "1h 2m");
	assert.equal(formatDuration(-5), "0s");
});

test("truncate keeps short text, ellipsizes long text", () => {
	assert.equal(truncate("abc", 5), "abc");
	assert.equal(truncate("1234567890", 5), "1234\u2026");
});

test("formatReport emits title and msg with the same text", () => {
	const oscSeq = formatReport({
		state: "done",
		app: "pi",
		message: "my-notebook \u00b7 3 turns \u00b7 42s",
	});
	const b64 = Buffer.from("my-notebook \u00b7 3 turns \u00b7 42s", "utf8").toString("base64");
	assert.ok(oscSeq.startsWith("\x1b]7501;state=done:app=pi:"), oscSeq);
	assert.ok(oscSeq.includes(`title=${b64}:`), oscSeq);
	assert.ok(oscSeq.endsWith(`msg=${b64}\x1b\\`), oscSeq);
});

test("formatReport: kind only for blocked, no title/msg without a message", () => {
	assert.equal(formatReport({ state: "blocked", kind: "permission" }),
		"\x1b]7501;state=blocked:kind=permission\x1b\\");
	assert.equal(formatReport({ state: "clear" }), "\x1b]7501;state=clear\x1b\\");
	assert.equal(formatReport({ state: "done", app: "bad app!" }),
		"\x1b]7501;state=done\x1b\\");
});

test("tmuxPassthrough wraps in DCS envelope with doubled ESCs", () => {
	const inner = "\x1b]7501;state=done:app=pi\x1b\\";
	const wrapped = tmuxPassthrough(inner);
	// ESC P tmux; ESC ESC ] 7501 ; ... ESC ESC \ ESC \
	assert.equal(
		osc(wrapped),
		"\\ePtmux;\\e\\e]7501;state=done:app=pi\\e\\e\\\\e\\",
	);
});

test("working -> done with session name, dedupes repeats", () => {
	const s = state("my-notebook");
	const working = s.handle({ type: "agent_start" });
	assert.match(working!, /state=working/);
	assert.match(working!, /msg=/); // base64 session name
	assert.equal(s.handle({ type: "agent_start" }), undefined); // dedupe
	const done = s.handle({ type: "agent_settled", aborted: false });
	assert.ok(done!.startsWith("\x1b]7501;"), `got: ${osc(done!)}`);
	assert.match(done!, /state=done/);
	assert.match(done!, /app=pi/);
});

test("error derived from message_end stopReason; retried success overwrites", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	// The outcome is recorded, not re-reported while still working.
	assert.equal(
		s.handle({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "boom\nline2",
			},
		}),
		undefined,
	);
	const err = s.handle({ type: "agent_settled", aborted: false });
	assert.match(err!, /state=error/);
	// only the first line of the error is reported (msg is base64 anyway)
	assert.doesNotMatch(err!, /line2/);
	// a retried success overwrites the error
	s.handle({ type: "agent_start" });
	s.handle({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "x" },
	});
	s.handle({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	const ok = s.handle({ type: "agent_settled", aborted: false });
	assert.match(ok!, /state=done/);
});

test("non-assistant message_end does not change the outcome", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	s.handle({ type: "message_end", 
		message: { role: "assistant", stopReason: "error", errorMessage: "x" },
	});
	assert.equal(
		s.handle({ type: "message_end",  message: { role: "toolResult" } }),
		undefined, // deduped, still error
	);
});

test("abort settles to idle", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	const idle = s.handle({ type: "agent_settled", aborted: true });
	assert.match(idle!, /state=idle/);
});

test("compaction during a run: working, failure becomes error on settle", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	const working = s.handle({ type: "session_before_compact", reason: "overflow" });
	assert.match(working!, /state=working/);
	// Failure ends the compacting phase but the run is still active:
	// no new report, outcome recorded as error.
	assert.equal(
		s.handle({
			type: "session_compact_failed",
			reason: "overflow",
			aborted: false,
			errorMessage: "Compaction failed: nope",
		}),
		undefined,
	);
	const err = s.handle({ type: "agent_settled", aborted: false });
	assert.match(err!, /state=error/);
});

test("compaction_end outside a run: manual success -> done, manual error -> error", () => {
	const s = state();
	const done = s.handle({ type: "session_compact", reason: "manual" });
	assert.match(done!, /state=done/);
	const s2 = state();
	const err = s2.handle({
		type: "session_compact_failed",
		reason: "manual",
		aborted: false,
		errorMessage: "failed",
	});
	assert.match(err!, /state=error/);
	const s3 = state();
	const idle = s3.handle({
		type: "session_compact_failed",
		reason: "manual",
		aborted: true,
	});
	assert.match(idle!, /state=idle/);
});

test("ui_prompt blocks with kind mapping, unblocks back to previous state", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	const confirm = s.handle({ type: "ui_prompt_start",  kind: "confirm", title: "Run rm -rf?" });
	assert.match(confirm!, /state=blocked/);
	assert.match(confirm!, /kind=permission/);
	const select = s.handle({ type: "ui_prompt_start",  kind: "select", title: "Pick one" });
	assert.match(select!, /kind=question/);
	// closing the top (select) returns to the confirm dialog
	const back = s.handle({ type: "ui_prompt_end",  kind: "select", title: "Pick one" });
	assert.match(back!, /kind=permission/);
	const done = s.handle({ type: "ui_prompt_end",  kind: "confirm", title: "Run rm -rf?" });
	assert.match(done!, /state=working/);
});

test("nested prompts of the same kind close in order (fallback to oldest)", () => {
	const s = state();
	s.handle({ type: "ui_prompt_start",  kind: "input", title: "A" });
	s.handle({ type: "ui_prompt_start",  kind: "input", title: "B" });
	const backToA = s.handle({ type: "ui_prompt_end",  kind: "input", title: "B" });
	assert.match(backToA!, /msg=/);
	const idle = s.handle({ type: "ui_prompt_end",  kind: "input", title: "A" });
	assert.match(idle!, /state=idle/);
});

test("reset clears run and prompts", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	s.handle({ type: "ui_prompt_start",  kind: "confirm", title: "x" });
	const idle = s.reset();
	assert.match(idle!, /state=idle/);
});

test("done message: session · turns · duration", () => {
	const s = state("my-notebook");
	s.handle({ type: "agent_start" });
	s.handle({ type: "turn_start" });
	s.handle({ type: "turn_start" });
	s.handle({ type: "turn_start" });
	const done = s.handle({ type: "agent_settled", aborted: false });
	assert.equal(msgOf(done), "my-notebook \u00b7 3 turns \u00b7 0s");
});

test("done message without session name falls back to pi; 1 turn singular", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	s.handle({ type: "turn_start" });
	const done = s.handle({ type: "agent_settled", aborted: false });
	assert.equal(msgOf(done), "pi \u00b7 1 turn \u00b7 0s");
});

test("working title: pi when unnamed, live turn counter", () => {
	const s = state();
	const working = s.handle({ type: "agent_start" });
	assert.equal(msgOf(working), "pi");
	const t1 = s.handle({ type: "turn_start" });
	assert.equal(msgOf(t1), "pi \u00b7 turn 1");
	const t2 = s.handle({ type: "turn_start" });
	assert.equal(msgOf(t2), "pi \u00b7 turn 2");
});

test("working title uses session name when set", () => {
	const s = state("my-notebook");
	s.handle({ type: "agent_start" });
	const t1 = s.handle({ type: "turn_start" });
	assert.equal(msgOf(t1), "my-notebook \u00b7 turn 1");
});

test("aborted run reports plain idle, no metadata", () => {
	const s = state("my-notebook");
	s.handle({ type: "agent_start" });
	s.handle({ type: "turn_start" });
	const idle = s.handle({ type: "agent_settled", aborted: true });
	assert.match(idle!, /state=idle/);
	assert.equal(msgOf(idle), "");
});

test("permission prompt shows tool and first input line", () => {
	const s = state();
	s.handle({
		type: "tool_call",
		toolName: "bash",
		input: { command: "git push --force origin main\u000asecond line" },
	});
	const blocked = s.handle({ type: "ui_prompt_start", kind: "confirm", title: "Allow bash?" });
	assert.match(blocked!, /kind=permission/);
	assert.equal(msgOf(blocked), "bash: git push --force origin main");
	// closing matches by the original title, not the tool line
	const after = s.handle({ type: "ui_prompt_end", kind: "confirm", title: "Allow bash?" });
	assert.match(after!, /state=idle/);
});

test("permission prompt truncates long input to 80 chars", () => {
	const s = state();
	s.handle({
		type: "tool_call",
		toolName: "bash",
		input: { command: `curl -X POST https://example.com/api?token=${"x".repeat(200)}` },
	});
	const blocked = s.handle({ type: "ui_prompt_start", kind: "confirm", title: "Allow bash?" });
	const msg = msgOf(blocked);
	assert.ok(msg.length <= 150, `len ${msg.length}`);
	assert.ok(msg.endsWith("\u2026"), msg);
});

test("question prompt keeps the dialog title, ignores last tool", () => {
	const s = state();
	s.handle({ type: "tool_call", toolName: "bash", input: { command: "ls" } });
	const blocked = s.handle({
		type: "ui_prompt_start",
		kind: "select",
		title: "Which approach should we use?",
	});
	assert.match(blocked!, /kind=question/);
	assert.equal(msgOf(blocked), "Which approach should we use?");
});

test("error message names the last tool", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	s.handle({ type: "tool_call", toolName: "bash", input: { command: "rg foo" } });
	s.handle({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit exceeded" },
	});
	const err = s.handle({ type: "agent_settled", aborted: false });
	assert.equal(msgOf(err), "429 rate limit exceeded (last: bash)");
});

test("error without a prior tool has no suffix", () => {
	const s = state();
	s.handle({ type: "agent_start" });
	s.handle({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "provider down" },
	});
	const err = s.handle({ type: "agent_settled", aborted: false });
	assert.equal(msgOf(err), "provider down");
});

