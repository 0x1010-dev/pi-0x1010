/**
 * Session-scoped state store for the context bar.
 *
 * Fed by pi events (agent_start / message_update / message_end /
 * agent_settled / compaction), read by the bar renderer on every frame.
 * Keeps:
 * - run-start baseline -> the fill/head split (fill = pre-turn context,
 *   head = turn growth) and per-run token deltas -> burn rate -> urgency hue
 * - streamed chars -> in-flight (uncommitted) tokens added to the head
 * - transient compaction state (compacting / compacted / failed)
 *
 * Note: pi's getContextUsage() is computed from committed session entries —
 * it is stale while a message streams. The streamed-chars estimate is the
 * only live token signal mid-run.
 *
 * No rendering here — just numbers and a flash.
 */

export type CompactFlash =
	| { kind: "compacting" }
	| { kind: "compacted"; usedTokens: number | null }
	| { kind: "failed"; reason: string };

/** How many recent runs the burn rate averages over. */
const BURN_WINDOW = 5;
/** How long the compacted/failed flashes stay in the bar. */
const FLASH_TTL_MS = 6000;
/** chars -> tokens heuristic for the streaming estimate. */
const CHARS_PER_TOKEN = 4;

export class BarStateStore {
	private running = false;
	private runStartUsed: number | null = null;
	private streamChars = 0;
	private deltas: number[] = [];
	private flash: CompactFlash | null = null;
	private flashUntil = 0;

	/** Agent run (user turn) started: baseline for the fill/head split. */
	agentStart(usedTokens: number | null): void {
		this.running = true;
		this.runStartUsed = usedTokens;
		this.streamChars = 0;
	}

	/**
	 * An assistant streaming delta with a string payload (text / thinking).
	 * Tool-call deltas are objects and are not counted by the caller.
	 */
	messageDelta(chars: number): void {
		this.streamChars += Math.max(0, chars);
	}

	/**
	 * An assistant message finalized: pi's used count covers it from here,
	 * so only the uncommitted char estimate resets (committed turn growth is
	 * already in `used` and flows through the baseline split).
	 */
	messageEnd(): void {
		this.streamChars = 0;
	}

	/** Run settled: commit the token delta for the burn rate. */
	agentSettled(usedTokens: number | null): void {
		if (this.runStartUsed !== null && usedTokens !== null) {
			const d = usedTokens - this.runStartUsed;
			if (d > 0) {
				this.deltas.push(d);
				if (this.deltas.length > BURN_WINDOW) this.deltas.shift();
			}
		}
		this.running = false;
		this.runStartUsed = null;
		this.streamChars = 0;
	}

	/**
	 * Context before this turn (the fill); null when idle, in which case the
	 * fill is the full used count and the head is only the in-flight part.
	 * pi's used count already includes committed turn work, so the head may
	 * only add (used − baseline) + in-flight — never the run's growth on top
	 * of a fill that already contains it.
	 */
	turnBaseline(): number | null {
		return this.running ? this.runStartUsed : null;
	}

	compacting(): void {
		this.flash = { kind: "compacting" };
	}

	compacted(usedTokens: number | null): void {
		this.deltas = [];
		// Overflow recovery: the run continues on the compacted context, so
		// re-baseline the in-flight tracking at the new usage.
		this.runStartUsed = usedTokens;
		this.flash = { kind: "compacted", usedTokens };
		this.flashUntil = Date.now() + FLASH_TTL_MS;
	}

	compactFailed(reason: string): void {
		this.flash = { kind: "failed", reason };
		this.flashUntil = Date.now() + FLASH_TTL_MS;
	}

	/** Burn rate: average tokens added per settled run; null with no samples. */
	burnPerTurn(): number | null {
		if (this.deltas.length === 0) return null;
		return this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length;
	}

	/**
	 * Tokens in the currently-streaming (uncommitted) message; 0 when idle or
	 * between messages. pi's used count already includes every committed
	 * message, so adding the run's total growth here would double-count it
	 * (visible as an overshoot at each message end).
	 */
	inFlightTokens(): number {
		return Math.max(0, Math.floor(this.streamChars / CHARS_PER_TOKEN));
	}

	/**
	 * Fill in the compacted flash's token count once usage is known again
	 * (it is null right after compaction, until the next estimate lands).
	 */
	noteUsage(usedTokens: number | null): void {
		if (this.flash?.kind === "compacted" && this.flash.usedTokens === null && usedTokens !== null) {
			this.flash = { kind: "compacted", usedTokens };
		}
	}

	/** Current compaction flash; expired flashes clear themselves. */
	flashAt(now = Date.now()): CompactFlash | null {
		if (this.flash === null) return null;
		if (this.flash.kind !== "compacting" && now > this.flashUntil) {
			this.flash = null;
			return null;
		}
		return this.flash;
	}

	/** True while a run is in flight or a flash is visible. */
	isLive(now = Date.now()): boolean {
		return this.running || this.flashAt(now) !== null;
	}

	reset(): void {
		this.running = false;
		this.runStartUsed = null;
		this.streamChars = 0;
		this.deltas = [];
		this.flash = null;
		this.flashUntil = 0;
	}
}
