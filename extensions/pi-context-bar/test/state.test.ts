import { test } from "node:test";
import * as assert from "node:assert/strict";

import { BarStateStore, type CompactFlash } from "../src/state.ts";

const LATER = 6100; // > FLASH_TTL_MS (6000)

test("turn baseline: null when idle, turn-start value for the whole run, null after settle", () => {
	const s = new BarStateStore();

	// Idle: no baseline (fill = full used count).
	assert.equal(s.turnBaseline(), null);

	// Turn starts: baseline = context at that moment.
	s.agentStart(100_000);
	assert.equal(s.turnBaseline(), 100_000);

	// Baseline holds across message boundaries (tool work in between).
	s.messageDelta(100);
	s.messageEnd();
	assert.equal(s.turnBaseline(), 100_000, "baseline survives message_end");
	s.messageDelta(50);
	s.messageEnd();
	assert.equal(s.turnBaseline(), 100_000);

	// Settled: baseline clears (fill absorbs the head).
	s.agentSettled(110_000);
	assert.equal(s.turnBaseline(), null);
});

test("inFlightTokens: streamed string chars / 4, reset at each message end", () => {
	const s = new BarStateStore();
	s.agentStart(100_000);
	assert.equal(s.inFlightTokens(), 0, "no chars yet");

	s.messageDelta(9);
	assert.equal(s.inFlightTokens(), 2, "floor(9/4) = 2");
	s.messageDelta(15);
	assert.equal(s.inFlightTokens(), 6, "cumulative floor(24/4) = 6");

	s.messageEnd();
	assert.equal(s.inFlightTokens(), 0, "reset when the message commits");
});

test("burnPerTurn: null with no samples, sliding 5-run window, non-positive deltas ignored", () => {
	const s = new BarStateStore();
	assert.equal(s.burnPerTurn(), null);

	s.agentStart(0);
	s.agentSettled(10_000);
	assert.equal(s.burnPerTurn(), 10_000);

	s.agentStart(10_000);
	s.agentSettled(10_000); // zero delta: ignored
	assert.equal(s.burnPerTurn(), 10_000);

	s.agentStart(10_000);
	s.agentSettled(14_000);
	assert.equal(s.burnPerTurn(), 7_000, "average of 10k and 4k");

	// Fill past the window: only the last 5 samples count.
	for (let i = 0; i < 5; i++) {
		s.agentStart(14_000);
		s.agentSettled(24_000); // +10k each
	}
	assert.equal(s.burnPerTurn(), 10_000, "window capped at the last 5 runs");
});

test("flashes: compacting never expires; compacted/failed expire after the TTL", () => {
	const s = new BarStateStore();
	const now = Date.now();

	s.compacting();
	assert.equal(s.flashAt(now)?.kind, "compacting");
	assert.equal(s.flashAt(now + LATER)?.kind, "compacting", "compacting persists until it resolves");

	s.compacted(50_000);
	assert.equal(s.flashAt(now + 1000)?.kind, "compacted");
	assert.equal(s.flashAt(now + LATER), null, "compacted flash expires");

	s.compactFailed("overflow");
	assert.equal(s.flashAt(now + 1000)?.kind, "failed");
	assert.equal(s.flashAt(now + LATER), null, "failed flash expires");
});

test("noteUsage: fills the compacted flash once usage is known again", () => {
	const s = new BarStateStore();
	s.compacted(null);
	assert.equal(s.flashAt()?.kind, "compacted");
	assert.equal((s.flashAt() as Extract<CompactFlash, { kind: "compacted" }>).usedTokens, null);

	s.noteUsage(42_000);
	assert.equal((s.flashAt() as Extract<CompactFlash, { kind: "compacted" }>).usedTokens, 42_000);

	// Later usage updates must not overwrite the flash.
	s.noteUsage(43_000);
	assert.equal((s.flashAt() as Extract<CompactFlash, { kind: "compacted" }>).usedTokens, 42_000);
});

test("compaction re-baselines the run: burn counts post-compaction growth only", () => {
	const s = new BarStateStore();
	s.agentStart(170_000);
	s.messageDelta(40_000); // streaming into the overflow

	// Overflow compaction mid-run: re-baseline at the compacted usage.
	s.compacted(30_000);
	s.agentSettled(35_000);
	assert.equal(s.burnPerTurn(), 5_000, "delta from the compacted baseline, not 170k");

	// History now holds only post-compaction runs: window average of 5k and 10k.
	s.agentStart(35_000);
	s.agentSettled(45_000);
	assert.equal(s.burnPerTurn(), 7_500);
});

test("isLive: true while a run is in flight or a flash is visible", () => {
	const s = new BarStateStore();
	const now = Date.now();
	assert.equal(s.isLive(now), false);

	s.agentStart(100_000);
	assert.equal(s.isLive(now), true, "running");
	s.agentSettled(110_000);
	assert.equal(s.isLive(now), false, "settled, no flash");

	s.compacted(30_000);
	assert.equal(s.isLive(now), true, "flash visible");
	assert.equal(s.isLive(now + LATER), false, "flash expired");
});

test("reset: clears everything", () => {
	const s = new BarStateStore();
	s.agentStart(100_000);
	s.messageDelta(100);
	s.compactFailed("threshold");
	s.reset();
	assert.equal(s.turnBaseline(), null);
	assert.equal(s.inFlightTokens(), 0);
	assert.equal(s.burnPerTurn(), null);
	assert.equal(s.flashAt(), null);
});
