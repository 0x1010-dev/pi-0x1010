import { visibleWidth } from "@earendil-works/pi-tui";

/** Styling surface the bar needs: pi's Theme. */
import type { Theme as BarTheme } from "@earendil-works/pi-coding-agent";
import type { CompactFlash } from "./state.ts";
export type { BarTheme };

export interface BarState {
	/** Used context tokens, null when unknown (e.g. just after compaction). */
	usedTokens: number | null;
	contextWindow: number;
	/** Fraction of the window at which auto-compaction triggers, 0..1; null when unknown. */
	thresholdFraction: number | null;
	/** Context before this turn (baseline at turn start); null when idle. */
	baseTokens: number | null;
	/** Tokens in the currently-streaming (uncommitted) message; 0 otherwise. */
	inFlightTokens: number;
	/** Average tokens added per settled run; null with fewer than one sample. */
	burnPerTurn: number | null;
	/** Transient compaction state, if any. */
	compact: CompactFlash | null;
}

type Urgency = "ok" | "warn" | "error";
type NamedColor = "success" | "warning" | "error";

/** Fill glyph: heavy — committed context is settled weight. */
const HEAVY = "\u2501";
/** Head glyph: normal line — the in-flight message is still being written. */
const LINE = "\u2500";
/** Headroom glyph: dotted, so fill and head read as "real" context. */
const DOT = "\u2504";
/** Compaction threshold marker: inline middle dot, rendered in the line's own color. */
const MARKER = "\u00B7";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) {
		const k = Math.round(count / 1000);
		return k < 1000 ? `${k}k` : `${(count / 1000000).toFixed(1)}M`;
	}
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function clamp01(x: number): number {
	return Math.min(1, Math.max(0, x));
}

/**
 * Urgency: what the fill hue should say.
 * error = at/over the compaction threshold (or compaction just failed);
 * warn  = within 2× the average per-run growth of the threshold; ok otherwise.
 */
export function resolveUrgency(s: BarState): Urgency {
	if (s.compact?.kind === "failed") return "error";
	if (s.usedTokens === null || s.contextWindow <= 0 || s.thresholdFraction === null) return "ok";
	const thr = s.contextWindow * s.thresholdFraction;
	if (s.usedTokens >= thr) return "error";
	if (s.burnPerTurn !== null && thr - s.usedTokens <= 2 * s.burnPerTurn) return "warn";
	return "ok";
}

const URGENCY_COLOR: Record<Urgency, NamedColor> = {
	ok: "success",
	warn: "warning",
	error: "error",
};

/**
 * Right-hand stats label: `used/total` only (user preference: no other
 * numbers in the bar). Compaction flashes replace the label entirely.
 */
function buildStats(s: BarState): { text: string; color: NamedColor | "dim" } | null {
	if (s.compact?.kind === "compacting") return { text: "compacting…", color: "warning" };
	if (s.compact?.kind === "failed")
		return { text: `compact failed · ${s.compact.reason}`, color: "error" };
	if (s.compact?.kind === "compacted") {
		const t = s.compact.usedTokens !== null ? formatTokens(s.compact.usedTokens) : "?";
		return { text: `compacted → ${t}`, color: "success" };
	}

	const used = s.usedTokens;
	const usageKnown = used !== null && s.contextWindow > 0;
	const stats = usageKnown
		? `${formatTokens(used)}/${formatTokens(s.contextWindow)}`
		: s.contextWindow > 0
			? `?/${formatTokens(s.contextWindow)}`
			: "";
	return stats === "" ? null : { text: stats, color: "dim" };
}

/**
 * Render the middle bar segment, left to right:
 *   [heavy fill: pre-turn context][normal bold head: this turn's growth]
 *   [dotted headroom]
 * with `·` = compaction threshold in the headroom's own color.
 *
 * Glyphs carry the state, not color. The fill is heavy `━`: the context
 * BEFORE this turn (baseline at turn start), in the urgency color of the
 * current total. The head is normal bold `─`: everything this turn has
 * added — committed growth (used − baseline: model output, thinking, tool
 * results) plus the in-flight streaming estimate — at least one cell when
 * any growth exists, growing on every commit and every delta. When the turn
 * settles, the baseline absorbs the total and the head thickens into the
 * heavy fill. Fill + head always equals the current total. The headroom is
 * always dotted `┄`, always in the editor's live border color.
 */
function renderBar(
	theme: BarTheme,
	border: (text: string) => string,
	s: BarState,
	mid: number,
	urgency: Urgency,
): string {
	if (mid <= 0) return "";
	const color = URGENCY_COLOR[urgency];
	const window = s.contextWindow;
	const used = s.usedTokens;
	const usageKnown = used !== null && window > 0;

	// Fill = context before this turn (baseline); idle → the full used count.
	const baseKnown = s.baseTokens !== null && used !== null && window > 0;
	const base = baseKnown ? Math.min(s.baseTokens as number, used) : (used ?? 0);
	const frac = usageKnown ? clamp01(base / window) : 0;
	const fill = Math.min(mid, Math.round(mid * frac));

	// Head = this turn's growth: committed (used − baseline) + in-flight.
	let head = 0;
	if (window > 0) {
		const growth = (baseKnown ? used - base : 0) + s.inFlightTokens;
		if (growth > 0) {
			const cells = Math.round((mid * growth) / window);
			// Clamp AFTER the 1-cell minimum: a full fill leaves no room, and
			// the minimum must not push the row past its width.
			head = Math.min(mid - fill, Math.max(1, cells));
		}
	}
	const live = fill + head;

	const markerPos =
		s.thresholdFraction !== null && s.thresholdFraction > 0 && s.thresholdFraction < 1
			? Math.min(mid - 1, Math.round(mid * s.thresholdFraction))
			: -1;

	const parts: Array<[number, number, string, (t: string) => string]> = [];
	if (fill > 0) parts.push([0, fill, HEAVY, (t) => theme.fg(color, t)]);
	if (head > 0) parts.push([fill, live, LINE, (t) => theme.style(t, { fg: color, bold: true })]);
	const lastEnd = Math.max(fill, live);
	if (mid > lastEnd) parts.push([lastEnd, mid, DOT, border]);

	let out = "";
	for (const [a, b, glyph, paint] of parts) {
		if (markerPos >= a && markerPos < b) {
			if (markerPos > a) out += paint(glyph.repeat(markerPos - a));
			out += border(MARKER);
			const rest = b - markerPos - 1;
			if (rest > 0) out += paint(glyph.repeat(rest));
		} else {
			out += paint(glyph.repeat(b - a));
		}
	}
	return out;
}

/**
 * Render the bottom bar:
 *   ━━━━━━━━━━──┄┄┄·┄┄┄ 42k/200k
 * (fill = context before this turn, heavy `━` in the urgency color; head =
 * this turn's growth — committed + in-flight — normal bold `─` at the fill
 * edge; dotted headroom in the editor's live border color; · = threshold in the
 * headroom's own color; then ` used/total` — or a compaction flash —
 * dimmed/colored. Model + effort live in the footer.)
 * Returns null when unknown or too narrow (caller falls back to the
 * default border).
 */
export function buildBottomBar(
	width: number,
	theme: BarTheme,
	border: (text: string) => string,
	s: BarState,
): string | null {
	const stats = buildStats(s);
	if (stats === null) return null;

	const rightW = visibleWidth(stats.text) + 1; // " stats"
	if (rightW + 1 > width) return null;

	const mid = width - rightW;
	return (
		renderBar(theme, border, s, mid, resolveUrgency(s)) +
		theme.fg(stats.color, ` ${stats.text}`)
	);
}
