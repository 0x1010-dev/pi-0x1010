/**
 * Render pi-context-bar preview frames as JSON cells for draw-preview.py.
 *
 * Uses the REAL bar renderer (buildBottomBar) with a cell-capturing theme,
 * so the preview cannot drift from what ships. Run from the repo root:
 *
 *   npx tsx extensions/pi-context-bar/scripts/render-preview.ts \
 *     | python3 extensions/pi-context-bar/scripts/draw-preview.py \
 *       extensions/pi-context-bar/preview.png
 */
import { buildBottomBar, type BarState, type BarTheme } from "../src/status-bar.ts";

interface Cell {
	t: string;
	c: string;
	b?: boolean;
	d?: boolean;
}

/** Theme stand-in that records styled cells instead of ANSI. */
function cellTheme(): BarTheme & { cells: Cell[] } {
	const cells: Cell[] = [];
	const push = (t: string, c: string, b?: boolean, d?: boolean) => {
		if (!t) return;
		const last = cells[cells.length - 1];
		if (last && last.c === c && !!last.b === !!b && !!last.d === !!d) last.t += t;
		else cells.push({ t, c, b, d });
	};
	const theme = {
		fg: (c: string, t: string) => {
			push(t, c);
			return t;
		},
		style: (t: string, o?: { fg?: string; bold?: boolean; dim?: boolean }) => {
			push(t, o?.fg ?? "text", o?.bold, o?.dim);
			return t;
		},
	};
	// Only fg/style are used by the renderer.
	return Object.assign(theme, { cells }) as unknown as BarTheme & { cells: Cell[] };
}

const W = 86; // interior width (pi draws side borders around it)

function frame(s: BarState, prompt: string, left: string, right: string): Cell[][] {
	const th = cellTheme();
	// In a live session the idle line takes the editor's live border color —
	// here the thinking-`high` violet, matching the top separator.
	const border = (t: string) => th.fg("thinkingHigh", t);
	const bar = buildBottomBar(W, th, border, s);

	const rows: Cell[][] = [];
	rows.push([{ t: `┌${"─".repeat(W)}┐`, c: "thinkingHigh" }]);
	rows.push([
		{ t: "│", c: "thinkingHigh" },
		{ t: ` ${prompt}`.padEnd(W), c: "text" },
		{ t: "│", c: "thinkingHigh" },
	]);
	rows.push([
		{ t: "├", c: "thinkingHigh" },
		...(bar !== null ? th.cells : [{ t: "─".repeat(W), c: "thinkingHigh" }]),
		{ t: "┤", c: "thinkingHigh" },
	]);
	const gap = " ".repeat(Math.max(1, W - left.length - right.length));
	rows.push([
		{ t: `  ${left}`, c: "dim" },
		{ t: gap, c: "dim" },
		{ t: right, c: "dim" },
	]);
	return rows;
}

const left = "~/Code/Personal/pi-0x1010 (main *3 ↑1↓2)";
const right = "gpt-5.1 · high";
const prompt = "type your prompt…";
const thr = 0.9; // 200k window − 20k reserve

const frames: BarState[] = [
	{
		usedTokens: 60000,
		contextWindow: 200000,
		thresholdFraction: thr,
		baseTokens: null,
		inFlightTokens: 0,
		burnPerTurn: null,
		compact: null,
	},
	{
		usedTokens: 78000,
		contextWindow: 200000,
		thresholdFraction: thr,
		baseTokens: 60000,
		inFlightTokens: 4000,
		burnPerTurn: 12000,
		compact: null,
	},
	{
		usedTokens: 172000,
		contextWindow: 200000,
		thresholdFraction: thr,
		baseTokens: null,
		inFlightTokens: 0,
		burnPerTurn: 12000,
		compact: null,
	},
	{
		usedTokens: 181000,
		contextWindow: 200000,
		thresholdFraction: thr,
		baseTokens: null,
		inFlightTokens: 0,
		burnPerTurn: 12000,
		compact: { kind: "compacting" },
	},
];

console.log(JSON.stringify({ frames: frames.map((s) => frame(s, prompt, left, right)) }));
