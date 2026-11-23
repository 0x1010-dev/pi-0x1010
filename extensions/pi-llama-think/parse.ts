/**
 * Pure chat-template reasoning-effort parsing. No I/O, no pi imports — unit-testable.
 *
 * The Qwen-family llama.cpp chat templates guard the effort with a Jinja `raise_exception`,
 * e.g.:
 *   {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
 *   {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
 *       {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ ...) }}
 *   {%- endif %}
 * The tuple in `not in (...)` is the authoritative set of values the template accepts; any
 * other value makes the request fail server-side. We recover that set with plain string ops
 * (no Jinja lib) so the `/thinking` selector only offers levels the model will honor.
 */

/** Pi's thinking-level universe (off + the effort ladder). */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Extract the reasoning-effort values a chat template accepts.
 *
 * Primary signal: the `raise_exception` guard tuple (`not in (...)`). Fallback: a
 * `reasoning_effort|default('<x>')` with no guard means only that single value is safe.
 * Returns `[]` when no effort machinery is detectable.
 */
export function parseEfforts(template: string): string[] {
	const guard = template.match(/reasoning_effort[\s\S]{0,400}?not in \(\s*([^)]+)\)/);
	if (guard) {
		const tokens = [...guard[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
		if (tokens.length > 0) return tokens;
	}
	const def = template.match(/reasoning_effort\|default\('([^']+)'\)/);
	return def ? [def[1]] : [];
}

/**
 * Map Pi's level universe onto the template's accepted efforts.
 * `off` always maps to `"off"` (thinking disabled); any other level maps to itself only when
 * the template accepts it, else `null` (hidden from the selector).
 */
export function buildLevelMap(efforts: string[]): Record<string, string | null> {
	const map: Record<string, string | null> = {};
	for (const level of LEVELS) {
		map[level] = level === "off" ? "off" : efforts.includes(level) ? level : null;
	}
	return map;
}
