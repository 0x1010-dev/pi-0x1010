/**
 * psp-tmux
 *
 * Bridges Pi's Program Status Protocol (OSC 7501) through tmux. tmux does not
 * forward OSC 7501, so terminals behind tmux (Termius, Rex, Ghostty) never see
 * Pi's state. This extension re-emits each state change inside tmux's DCS
 * passthrough envelope; with `set -g allow-passthrough on`, tmux unwraps it
 * and writes the bare OSC 7501 to the outer terminal.
 *
 * Active only when the TMUX env var is set (i.e. Pi runs inside tmux) and
 * stdout is a TTY. Otherwise Pi's native probe-based reporting handles the
 * terminal directly and this extension stays silent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatProgramStatus } from "@earendil-works/pi-tui";
import { PspTmuxState, tmuxPassthrough } from "./src/state.ts";

const APP = "pi";

export default function pspTmux(pi: ExtensionAPI): void {
	if (!process.env.TMUX || !process.stdout.isTTY) return;

	let sessionName: string | undefined;
	const state = new PspTmuxState(APP, () => sessionName);
	const emit = (osc: string | undefined): void => {
		if (osc) process.stdout.write(tmuxPassthrough(osc));
	};

	pi.on("session_start", (_event, ctx) => {
		sessionName = ctx.sessionManager.getSessionName();
		emit(state.reset());
	});
	pi.on("session_info_changed", (event) => {
		sessionName = event.name;
		emit(state.report());
	});
	pi.on("agent_start", (event) => emit(state.handle(event)));
	pi.on("agent_settled", (event) => emit(state.handle(event)));
	pi.on("turn_start", (event) => emit(state.handle(event)));
	pi.on("tool_call", (event) => emit(state.handle(event)));
	pi.on("message_end", (event) => emit(state.handle(event)));
	pi.on("session_before_compact", (event) => emit(state.handle(event)));
	pi.on("session_compact", (event) => emit(state.handle(event)));
	pi.on("session_compact_failed", (event) => emit(state.handle(event)));
	pi.on("ui_prompt_start", (event) => emit(state.handle(event)));
	pi.on("ui_prompt_end", (event) => emit(state.handle(event)));

	// Remove the status from the terminal on exit. Pi's native clear only
	// fires for probe-confirmed terminals, which never happens behind tmux.
	pi.on("session_shutdown", () => {
		process.stdout.write(tmuxPassthrough(formatProgramStatus({ state: "clear" })));
	});
}
