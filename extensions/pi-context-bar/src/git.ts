import { execFile } from "node:child_process";

export interface GitStatus {
	/** Modified + staged + untracked entries. */
	dirty: number;
	/** Commits ahead of the upstream branch; 0 when there is no upstream. */
	ahead: number;
	/** Commits behind the upstream branch; 0 when there is not. */
	behind: number;
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		});
	});
}

/** Parse `git status --porcelain` output -> dirty entry count. */
export function parsePorcelain(porcelain: string): number {
	return porcelain.split("\n").filter((l) => l.length > 0).length;
}

/** Parse `rev-list --left-right --count` output ("behind\tahead") -> counts. */
export function parseAheadBehind(out: string): { ahead: number; behind: number } {
	const [b, a] = out.trim().split(/\s+/);
	return { behind: Number(b) || 0, ahead: Number(a) || 0 };
}

/**
 * Cached git working-tree status for the footer.
 *
 * `refresh()` is cheap to call often (overlapping calls collapse); results
 * are cached until the next refresh lands. Refresh on agent_settled and
 * branch change — never per render.
 */
export function createGitStatusTracker(cwd: string) {
	let cached: GitStatus | null = null;
	let pending: Promise<GitStatus | null> | null = null;

	function refresh(): void {
		if (pending) return;
		pending = (async (): Promise<GitStatus | null> => {
			try {
				const porcelain = await git(cwd, ["status", "--porcelain"]);
				let ahead = 0;
				let behind = 0;
				try {
					// "rev-list --left-right --count @{upstream}...HEAD" -> "behind\tahead"
					const out = await git(cwd, [
						"rev-list",
						"--left-right",
						"--count",
						"@{upstream}...HEAD",
					]);
					({ ahead, behind } = parseAheadBehind(out));
				} catch {
					// No upstream (or not a git repo branch): leave 0/0.
				}
				cached = { dirty: parsePorcelain(porcelain), ahead, behind };
				return cached;
			} catch {
				return cached; // Not a git repo / git missing: keep last known.
			} finally {
				pending = null;
			}
		})();
	}

	return {
		refresh,
		get: (): GitStatus | null => cached,
	};
}
