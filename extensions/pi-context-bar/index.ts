import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { createEditorFactory } from "./src/editor.ts";
import { createGitStatusTracker } from "./src/git.ts";
import { createFooter } from "./src/footer.ts";
import { BarStateStore } from "./src/state.ts";

/**
 * pi-context-bar
 *
 * - Bottom border of the prompt box = live context bar:
 *   [heavy fill = pre-turn context][normal bold head = this turn's growth]
 *   [dotted headroom]· 42k/200k
 *   Fill hue = urgency of the current total (success → warning within 2×
 *   burn of the threshold → error at/over it, or when compaction failed).
 * - The head shows everything added since the user's prompt — model output,
 *   thinking, tool results — growing on every commit and streamed delta; when
 *   the turn settles, it thickens into the heavy `━` fill in one settle.
 * - Compaction is visible: "compacting…", "compacted → 12k" flash (~6 s),
 *   red "compact failed · <reason>".
 * - Hidden lines below the editor fall back to Pi's original
 *   border (solid, centered "↓ N more", border color).
 * - Footer: cwd + `branch *dirty ↑ahead↓behind` left; `model · effort`
 *   right; both dimmed via theme.fg("dim") per part, like pi's original.
 */
export default function (pi: ExtensionAPI) {
	let cleanup: (() => void) | null = null;

	pi.on("session_shutdown", () => {
		cleanup?.();
		cleanup = null;
	});

	const apply = (ctx: ExtensionContext): (() => void) => {
		const store = new BarStateStore();
		const git = createGitStatusTracker(ctx.cwd);
		let tui: TUI | null = null;
		let beat = 0;

		// 1 Hz heartbeat: while live (a run in flight or a flash visible),
		// re-render (fills in the compacted usage, expires the flash); refresh
		// git every 5 s (catches external branch changes). The bar re-renders
		// on its own while a run streams — the transcript drives the TUI.
		const timer = setInterval(() => {
			beat++;
			if (tui === null) return;
			if (store.isLive()) {
				store.noteUsage(ctx.getContextUsage()?.tokens ?? null);
				tui.requestRender();
			}
			if (beat % 5 === 0) git.refresh();
		}, 1000);

		const unsubs = [
			pi.on("agent_start", (_event, c) => {
				store.agentStart(c.getContextUsage()?.tokens ?? null);
				git.refresh();
				tui?.requestRender();
			}),
			pi.on("message_update", (event) => {
				if ("delta" in event.assistantMessageEvent && typeof event.assistantMessageEvent.delta === "string") {
					store.messageDelta(event.assistantMessageEvent.delta.length);
				}
			}),
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant") store.messageEnd();
			}),
			pi.on("agent_settled", (_event, c) => {
				store.agentSettled(c.getContextUsage()?.tokens ?? null);
				git.refresh();
				tui?.requestRender();
			}),
			pi.on("session_before_compact", () => {
				store.compacting();
				tui?.requestRender();
			}),
			pi.on("session_compact", (_event, c) => {
				store.compacted(c.getContextUsage()?.tokens ?? null);
				tui?.requestRender();
			}),
			pi.on("session_compact_failed", (event) => {
				store.compactFailed(event.reason);
				tui?.requestRender();
			}),
		];

		ctx.ui.setEditorComponent(
			createEditorFactory({
				pi,
				ctx,
				store,
				onTui: (t) => {
					tui = t;
				},
			}),
		);
		ctx.ui.setFooter(
			createFooter(
				ctx,
				() => {
					const level = pi.getThinkingLevel();
					return level && level !== "off" ? level : null;
				},
				() => git.get(),
			),
		);

		return () => {
			clearInterval(timer);
			for (const unsub of unsubs) unsub();
			store.reset();
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setFooter(undefined);
			tui = null;
		};
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cleanup?.();
		cleanup = apply(ctx);
	});

	pi.registerCommand("cbar", {
		description: "Toggle the context bar (off/on)",
		handler: async (_args, ctx) => {
			const on = ctx.ui.getEditorComponent() === undefined;
			if (on) {
				cleanup = apply(ctx);
			} else {
				cleanup?.();
				cleanup = null;
			}
			ctx.ui.notify(`pi-context-bar ${on ? "on" : "off"}`, "info");
		},
	});
}
