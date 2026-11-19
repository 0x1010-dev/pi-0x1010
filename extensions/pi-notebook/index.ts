import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerForgetCommand } from "./src/commands/forget.ts";
import { registerInitCommand } from "./src/commands/init.ts";
import { registerPromptCommands } from "./src/commands/prompts.ts";
import { registerPrefsCommand, registerRememberCommand } from "./src/commands/rules.ts";
import { registerShowCommand } from "./src/commands/show.ts";
import { registerCompactionEvents } from "./src/events/compaction.ts";
import { registerContextEvents } from "./src/events/context.ts";
import { registerPromptEvents } from "./src/events/prompt.ts";
import { registerSessionEvents } from "./src/events/session.ts";
import { registerToolEvents } from "./src/events/tools.ts";
import { registerTurnEvents } from "./src/events/turns.ts";
import { createRuntime } from "./src/runtime.ts";
import { registerContextCompact } from "./src/tools/context-compact.ts";
import { registerHandoffUpdate } from "./src/tools/handoff-update.ts";
import { registerMemoryDelete } from "./src/tools/memory-delete.ts";
import { registerMemorySave } from "./src/tools/memory-save.ts";
import { registerMemorySearch } from "./src/tools/memory-search.ts";

export default function notebook(pi: ExtensionAPI): void {
	const rt = createRuntime(pi);

	registerSessionEvents(rt);
	registerPromptEvents(rt);
	registerToolEvents(rt);
	registerTurnEvents(rt);
	registerContextEvents(rt);
	registerCompactionEvents(rt);

	registerMemorySave(rt);
	registerMemorySearch(rt);
	registerHandoffUpdate(rt);
	registerMemoryDelete(rt);
	if (rt.session.cfg.handoffCompaction) {
		registerContextCompact(rt);
	}

	registerShowCommand(rt);
	registerInitCommand(rt);
	registerRememberCommand(rt);
	registerPrefsCommand(rt);
	registerForgetCommand(rt);
	registerPromptCommands(rt);
}
