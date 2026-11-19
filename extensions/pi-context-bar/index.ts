import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createEditorFactory } from "./src/editor.ts";
import { createFooter } from "./src/footer.ts";

/**
 * pi-context-bar
 *
 * - Bottom border of the prompt box = context progress bar:
 *   ────·────── 60k/128k
 *   (fill = context used in `success` green; idle line in the editor's
 *   live border color = top separator; · = auto-compaction threshold in
 *   the line's own color; then ` used/total` dimmed)
 * - Hidden lines below the editor fall back to Pi's original
 *   border (solid, centered "↓ N more", border color).
 * - Footer: cwd/branch/statuses left; `model · effort` right; both dimmed
 *   via theme.fg("dim") per part, like pi's original footer.
 */
export default function (pi: ExtensionAPI) {
	const apply = (ctx: ExtensionContext) => {
		ctx.ui.setEditorComponent(createEditorFactory({ pi, ctx }));
		ctx.ui.setFooter(
			createFooter(ctx, () => {
				const level = pi.getThinkingLevel();
				return level && level !== "off" ? level : null;
			}),
		);
	};

	const restore = (ctx: ExtensionContext) => {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		apply(ctx);
	});

	pi.registerCommand("cbar", {
		description: "Toggle the context bar (off/on)",
		handler: async (_args, ctx) => {
			const on = ctx.ui.getEditorComponent() === undefined;
			if (on) apply(ctx);
			else restore(ctx);
			ctx.ui.notify(`pi-context-bar ${on ? "on" : "off"}`, "info");
		},
	});
}
