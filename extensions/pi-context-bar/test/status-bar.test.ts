import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
	buildBottomBar,
	formatTokens,
	resolveUrgency,
	type BarState,
	type BarTheme,
} from "../src/status-bar.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

interface Spans {
	color: string;
	attr: string; // "" | "bold" | "dim"
	text: string;
}

function fakeTheme(): BarTheme & { spans: Spans[] } {
	const spans: Spans[] = [];
	const fake = {
		spans,
		fg: (color: string, text: string) => {
			spans.push({ color, attr: "", text });
			return text;
		},
		style: (text: string, opts?: { fg?: string; bold?: boolean; dim?: boolean }) => {
			spans.push({
				color: opts?.fg ?? "text",
				attr: opts?.bold ? "bold" : opts?.dim ? "dim" : "",
				text,
			});
			return text;
		},
	};
	return fake as unknown as BarTheme & { spans: Spans[] };
}

type Fake = ReturnType<typeof fakeTheme>;

function borderFn(t: Fake): (text: string) => string {
	return (text: string) => {
		t.spans.push({ color: "border", attr: "", text });
		return text;
	};
}

const base: BarState = {
	usedTokens: 60000,
	contextWindow: 128000,
	thresholdFraction: 0.88,
	baseTokens: null,
	inFlightTokens: 0,
	burnPerTurn: null,
	compact: null,
};

/** mid segment width for a given total width and state (renders into a scratch theme). */
function midFor(width: number, s: BarState): number {
	const t = fakeTheme();
	const line = buildBottomBar(width, t, (x: string) => x, s);
	assert.ok(line !== null, "bar rendered for mid measurement");
	const stats = t.spans[t.spans.length - 1].text;
	return width - visibleWidth(stats);
}

test("formatTokens", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(4200), "4.2k");
	assert.equal(formatTokens(172000), "172k");
	assert.equal(formatTokens(1500000), "1.5M");
	assert.equal(formatTokens(999500), "1.0M", "k rounding must not produce 1000k");
	assert.equal(formatTokens(999499), "999k");
});

test("line + ' stats' at the right end, no glyphs beyond bar chars", () => {
	const t = fakeTheme();
	const line = String(buildBottomBar(100, t, borderFn(t), base) as string);
	assert.ok(visibleWidth(line) === 100);
	assert.ok(line.endsWith(` 60k/128k`), `end: ${JSON.stringify(line.slice(-12))}`);
	assert.ok(!line.endsWith(" "), "no trailing space after stats");
	assert.ok(line.startsWith("\u2501"), `start (heavy fill): ${JSON.stringify(line.slice(0, 8))}`);
	assert.ok(
		t.spans.some((s) => s.color === "dim" && s.attr === "" && s.text === ` 60k/128k`),
		"stats dimmed, leading space, no trailing space",
	);
	const colors = new Set(t.spans.map((s) => s.color));
	assert.deepEqual([...colors].sort(), ["border", "dim", "success"]);
});

test("solid line: fill = success, idle = border, no panels", () => {
	const t = fakeTheme();
	const width = 120;
	const stats = "60k/128k";
	const mid = width - stats.length - 1; // " stats"
	const line = String(buildBottomBar(width, t, borderFn(t), base) as string);
	// used 60000/128000 ≈ 0.469
	const fillCount = t.spans
		.filter((s) => s.color === "success" && s.attr === "")
		.map((s) => s.text.length)
		.reduce((a, b) => a + b, 0);
	const idleCount = t.spans
		.filter((s) => s.color === "border" && s.text !== "\u00B7")
		.map((s) => s.text.length)
		.reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(fillCount / mid - 0.469) < 0.03, `fill=${fillCount} mid=${mid}`);
	assert.equal(fillCount + idleCount, mid - 1, "only the marker left uncounted");
	assert.ok(line.includes("\u2501"), "fill is heavy");
	assert.ok(!line.includes("\u2500"), "no normal line glyph when idle (no head)");
	assert.ok(!line.includes("╌"), "no dotted glyph");
});

test("marker · at ≈ threshold fraction, in the line's own color", () => {
	const t = fakeTheme();
	const width = 120;
	const line = String(buildBottomBar(width, t, borderFn(t), base) as string);
	const idx = line.indexOf("\u00B7");
	const mid = width - "60k/128k".length - 1;
	assert.ok(Math.abs(idx / mid - 0.88) < 0.01, `idx=${idx} mid=${mid}`);
	assert.ok(
		t.spans.some((s) => s.color === "border" && s.text === "\u00B7"),
		"marker in line/border color",
	);
});

test("urgency: ok = success, warn within 2× burn of threshold, error at/over", () => {
	const warn: BarState = { ...base, usedTokens: 110000, burnPerTurn: 2000 }; // thr=112640, gap=2640 ≤ 4000
	const error: BarState = { ...base, usedTokens: 118000 }; // over thr
	const okFar: BarState = { ...base, burnPerTurn: 2000 }; // gap=52640 > 4000

	assert.equal(resolveUrgency(okFar), "ok");
	assert.equal(resolveUrgency(warn), "warn");
	assert.equal(resolveUrgency(error), "error");

	const tw = fakeTheme();
	buildBottomBar(100, tw, borderFn(tw), warn);
	assert.ok(
		tw.spans.some((s) => s.color === "warning" && s.attr === ""),
		"warn fill in warning color",
	);

	const te = fakeTheme();
	buildBottomBar(100, te, borderFn(te), error);
	assert.ok(
		te.spans.some((s) => s.color === "error" && s.attr === ""),
		"over-threshold fill in error color",
	);

	const to = fakeTheme();
	buildBottomBar(100, to, borderFn(to), okFar);
	assert.ok(
		to.spans.some((s) => s.color === "success" && s.attr === ""),
		"far-from-threshold fill stays success",
	);
	assert.ok(!to.spans.some((s) => s.color === "warning"), "no warning tint when ok");
});

test("turn growth head: committed growth + in-flight, fill = pre-turn baseline", () => {
	// Mid-turn: 60k baseline, 68k committed, 4k in-flight → growth 12k.
	const t2 = fakeTheme();
	const s2: BarState = { ...base, usedTokens: 68000, baseTokens: 60000, inFlightTokens: 4000 };
	const mid = midFor(120, s2);
	buildBottomBar(120, t2, borderFn(t2), s2);
	const head2 = t2.spans
		.filter((s) => s.attr === "bold" && s.color === "success")
		.map((s) => s.text.length)
		.reduce((a, b) => a + b, 0);
	assert.equal(
		head2,
		Math.max(1, Math.round((mid * 12000) / 128000)),
		"head = mid × (used−base+inFlight)/window",
	);
	assert.ok(!t2.spans.some((s) => s.color === "accent"), "no accent");

	// Fill shows the pre-turn baseline (60k), not the total (68k).
	const fillCount = t2.spans
		.filter((s) => s.color === "success" && s.attr === "")
		.map((s) => s.text.length)
		.reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(fillCount / mid - 0.469) < 0.03, "fill = baseline, not total");

	// Idle (no in-flight): no head, even with a large used count.
	const t3 = fakeTheme();
	buildBottomBar(120, t3, borderFn(t3), base);
	assert.ok(!t3.spans.some((s) => s.attr === "bold"), "no head when idle");

	// Baseline unknown (first turn, usage was null at start) + in-flight:
	// the head still shows the streaming part.
	const t4 = fakeTheme();
	buildBottomBar(120, t4, borderFn(t4), { ...base, inFlightTokens: 20000 });
	assert.ok(
		t4.spans.some((s) => s.attr === "bold"),
		"head = in-flight when baseline unknown",
	);
});

test("headroom: always dotted, always border color — no background color change", () => {
	// Idle: dotted headroom in the border color, marker with it.
	const idle = fakeTheme();
	buildBottomBar(100, idle, borderFn(idle), base);
	assert.ok(
		idle.spans.some((s) => s.color === "border" && s.text.includes("\u2504")),
		"idle headroom dotted",
	);
	assert.ok(
		idle.spans.some((s) => s.color === "border" && s.text === "\u00B7"),
		"marker in border color",
	);
	assert.ok(!idle.spans.some((s) => s.color === "accent"), "no accent when idle");

	// Mid-turn: headroom and marker unchanged — no color change anywhere.
	const gen = fakeTheme();
	buildBottomBar(100, gen, borderFn(gen), { ...base, baseTokens: 0, inFlightTokens: 1000 });
	assert.ok(
		gen.spans.some((s) => s.color === "border" && s.text.includes("\u2504")),
		"headroom still border-colored",
	);
	assert.ok(
		!gen.spans.some((s) => s.color === "accent" && s.text.includes("\u2504")),
		"headroom never accent",
	);
	assert.ok(
		gen.spans.some((s) => s.color === "border" && s.text === "\u00B7"),
		"marker still border color",
	);
});

test("stats: used/total only — no turn counter, no timer", () => {
	const t = fakeTheme();
	const line = String(
		buildBottomBar(100, t, borderFn(t), { ...base, burnPerTurn: 8000 }) as string,
	);
	assert.ok(line.endsWith(` 60k/128k`), `end: ${JSON.stringify(line.slice(-12))}`);
	assert.equal(visibleWidth(line), 100);

	// Running with a burn sample adds no extra numbers.
	const t2 = fakeTheme();
	const line2 = String(
		buildBottomBar(100, t2, borderFn(t2), {
			...base,
			burnPerTurn: 8000,
			baseTokens: 0,
			inFlightTokens: 4000,
		}) as string,
	);
	assert.ok(line2.endsWith(` 60k/128k`), "no turn counter or timer while running");

	// Past threshold: same, just the usage.
	const t3 = fakeTheme();
	const line3 = String(
		buildBottomBar(100, t3, borderFn(t3), {
			...base,
			usedTokens: 118000,
			burnPerTurn: 8000,
		}) as string,
	);
	assert.ok(line3.endsWith(` 118k/128k`));
});

test("compaction flashes replace the stats label", () => {
	const tc = fakeTheme();
	const lc = String(
		buildBottomBar(100, tc, borderFn(tc), {
			...base,
			compact: { kind: "compacting" },
		}) as string,
	);
	assert.ok(lc.endsWith(` compacting…`));
	assert.ok(tc.spans.some((s) => s.color === "warning" && s.text === " compacting…"));

	const tf = fakeTheme();
	const lf = String(
		buildBottomBar(100, tf, borderFn(tf), {
			...base,
			compact: { kind: "failed", reason: "overflow" },
		}) as string,
	);
	assert.ok(lf.endsWith(` compact failed · overflow`));
	assert.ok(tf.spans.some((s) => s.color === "error"));
	assert.equal(
		resolveUrgency({ ...base, compact: { kind: "failed", reason: "overflow" } }),
		"error",
	);

	const tk = fakeTheme();
	const lk = String(
		buildBottomBar(100, tk, borderFn(tk), {
			...base,
			usedTokens: null,
			compact: { kind: "compacted", usedTokens: 12000 },
		}) as string,
	);
	assert.ok(lk.endsWith(` compacted → 12k`));
	assert.ok(tk.spans.some((s) => s.color === "success" && s.text === " compacted → 12k"));
});

test("unknown usage: '?' stats, no fill, marker still shown", () => {
	const t = fakeTheme();
	const line = String(
		buildBottomBar(100, t, borderFn(t), { ...base, usedTokens: null }) as string,
	);
	assert.ok(line.endsWith(` ?/128k`));
	assert.ok(!t.spans.some((s) => s.color === "success"), "no fill");
	assert.ok(line.includes("\u00B7"), "threshold marker still shown");
});

test("no threshold -> no marker", () => {
	const t = fakeTheme();
	const line = String(
		buildBottomBar(100, t, borderFn(t), { ...base, thresholdFraction: null }) as string,
	);
	assert.ok(!line.includes("\u00B7"));
});

test("never overflows; null when too narrow or no window", () => {
	const t = fakeTheme();
	const rich: BarState = { ...base, burnPerTurn: 8000, baseTokens: 0, inFlightTokens: 10000 };
	for (const width of [140, 80, 40, 20, 14, 11]) {
		const line = buildBottomBar(width, t, borderFn(t), rich);
		if (line === null) continue;
		assert.equal(visibleWidth(String(line)), width, `width=${width}`);
	}

	// Full fill while a turn still streams: the 1-cell head minimum must not
	// push the row past its width (overflow case — used ≥ window).
	const tFull = fakeTheme();
	const full: BarState = {
		...base,
		usedTokens: base.contextWindow,
		baseTokens: base.contextWindow,
		inFlightTokens: 5000,
	};
	const lineFull = buildBottomBar(100, tFull, borderFn(tFull), full);
	assert.ok(lineFull !== null);
	assert.equal(visibleWidth(String(lineFull)), 100, "full fill + turn growth still fits");
	assert.ok(!tFull.spans.some((s) => s.attr === "bold"), "no head room means no head");
	assert.equal(buildBottomBar(9, t, borderFn(t), base), null, "too narrow falls back");
	assert.equal(
		buildBottomBar(100, t, borderFn(t), { ...base, contextWindow: 0, usedTokens: null }),
		null,
		"no window falls back",
	);
});
