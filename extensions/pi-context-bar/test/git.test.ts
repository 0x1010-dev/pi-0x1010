import { test } from "node:test";
import * as assert from "node:assert/strict";

import { parseAheadBehind, parsePorcelain } from "../src/git.ts";

test("parsePorcelain: counts entries, ignores the trailing newline", () => {
	assert.equal(parsePorcelain(""), 0);
	assert.equal(parsePorcelain("M a.ts\n?? b.ts\n M c.ts\n"), 3);
	assert.equal(parsePorcelain("M a.ts\nM b.ts"), 2);
});

test("parseAheadBehind: left column = behind, right = ahead", () => {
	assert.deepEqual(parseAheadBehind("0\t0\n"), { ahead: 0, behind: 0 });
	assert.deepEqual(parseAheadBehind("2\t5\n"), { ahead: 5, behind: 2 });
	assert.deepEqual(parseAheadBehind("  3 \t 1 \n"), { ahead: 1, behind: 3 });
	assert.deepEqual(parseAheadBehind(""), { ahead: 0, behind: 0 });
});
