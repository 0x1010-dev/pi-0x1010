import { test } from "node:test";
import * as assert from "node:assert/strict";

import { formatBranch, formatCwd } from "../src/footer.ts";
import type { GitStatus } from "../src/git.ts";

test("formatCwd: home-relative with tilde, absolute outside home, no home", () => {
	assert.equal(formatCwd("/home/luis/Code/x", "/home/luis"), "~/Code/x");
	assert.equal(formatCwd("/home/luis", "/home/luis"), "~");
	assert.equal(formatCwd("/etc", "/home/luis"), "/etc");
	assert.equal(formatCwd("/etc", undefined), "/etc");
});

test("formatBranch: zero parts omitted, each shown when non-zero", () => {
	assert.equal(formatBranch("main", null), "main");
	assert.equal(formatBranch("main", { dirty: 0, ahead: 0, behind: 0 }), "main");
	assert.equal(formatBranch("main", { dirty: 3, ahead: 0, behind: 0 }), "main *3");
	assert.equal(formatBranch("main", { dirty: 0, ahead: 1, behind: 2 }), "main ↑1↓2");
	assert.equal(formatBranch("main", { dirty: 3, ahead: 1, behind: 2 }), "main *3 ↑1↓2");
});
