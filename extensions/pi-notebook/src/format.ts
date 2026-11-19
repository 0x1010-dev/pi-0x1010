import { createStalenessChecker } from "./git.ts";
import { findProject } from "./paths.ts";
import { type Entry, preview, ref } from "./store.ts";

/** Async git staleness checker (non-blocking, cached per cwd). */
export type StalenessChecker = ReturnType<typeof createStalenessChecker>;

/** A staleness checker for the project containing `cwd`, or undefined outside one. */
export function stalenessCheckerFor(cwd: string): StalenessChecker | undefined {
	const root = findProject(cwd)?.root;
	return root ? createStalenessChecker(root) : undefined;
}

export const entryPreview = preview;

export const clip = (s: string, max: number): string =>
	s.length > max ? `${s.slice(0, max)}…` : s;

/** `M3 Title` */
export function entryLabel(e: Entry): string {
	return `${ref(e)} ${e.title}`;
}

/** A reference, title and timestamp. */
export function entryHead(e: Entry): string {
	return `${ref(e)} ${e.title} (${e.date})`;
}

/** Retrieval metadata and code-staleness warnings (async; never blocks the TUI). */
export async function noteLines(
	checker: StalenessChecker | undefined,
	e: Entry,
): Promise<string[]> {
	const lines = metadataLines(e);
	const warn = checker && e.commit ? await checker(e.commit, e.files) : undefined;
	if (warn) {
		lines.push(warn);
	}
	return lines;
}

export function metadataLines(e: Entry): string[] {
	return [
		...(e.tags.length ? [`Tags: ${e.tags.map((t) => `#${t}`).join(" ")}`] : []),
		...(e.files?.length ? [`Files: ${e.files.join(", ")}`] : []),
	];
}
