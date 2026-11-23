import { test } from "node:test";
import * as assert from "node:assert/strict";

import { LEVELS, buildLevelMap, parseEfforts } from "./parse.ts";

/**
 * The real Qwen3.8-27B chat template guard (both iceland local models use it).
 * Accepts exactly xhigh / medium / low; any other value raises server-side.
 */
const QWEN_TEMPLATE = [
	"{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}",
	"{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}",
	"    {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ ' is not supported') }}",
	"{%- endif %}",
	"{%- if enable_thinking is not defined or enable_thinking %}",
	"    {{- '<thinking>' }}",
	"{%- endif %}",
].join("\n");

test("parseEfforts: Qwen guard tuple → xhigh, medium, low", () => {
	assert.deepEqual(parseEfforts(QWEN_TEMPLATE), ["xhigh", "medium", "low"]);
});

test("parseEfforts: single default, no guard → just the default", () => {
	const tpl = "{% set e = reasoning_effort|default('high') %}{{ e }}";
	assert.deepEqual(parseEfforts(tpl), ["high"]);
});

test("parseEfforts: no effort machinery → empty", () => {
	assert.deepEqual(parseEfforts("{% for m in messages %}{{ m.content }}{% endfor %}"), []);
});

test("parseEfforts: empty tuple in guard falls back to default", () => {
	// Guard present but with no quoted tokens; a default is still declared.
	const tpl = "{% set e = reasoning_effort|default('low') %}{% if e not in () %}{% endif %}";
	assert.deepEqual(parseEfforts(tpl), ["low"]);
});

test("buildLevelMap: only off + accepted efforts are non-null", () => {
	const map = buildLevelMap(["xhigh", "medium", "low"]);
	assert.equal(map.off, "off");
	assert.equal(map.low, "low");
	assert.equal(map.medium, "medium");
	assert.equal(map.xhigh, "xhigh");
	// Levels the template rejects are hidden (null).
	assert.equal(map.minimal, null);
	assert.equal(map.high, null);
	assert.equal(map.max, null);
});

test("buildLevelMap: no efforts → only off is selectable", () => {
	const map = buildLevelMap([]);
	for (const level of LEVELS) {
		assert.equal(map[level], level === "off" ? "off" : null, level);
	}
});

test("buildLevelMap: covers the full level universe", () => {
	const map = buildLevelMap(["minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(Object.keys(map).sort(), [...LEVELS].sort());
});
