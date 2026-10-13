// Which branch protection rules apply to a branch. No runtime imports, so the UI uses it too.
import type { BranchRule } from "./api.ts";

type Token = "*" | "**" | "?" | { literal: string };

function tokens(pattern: string): Token[] {
	const out: Token[] = [];
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "*" && pattern[i + 1] === "*") {
			out.push("**");
			i++;
		} else if (pattern[i] === "*" || pattern[i] === "?") out.push(pattern[i] as "*" | "?");
		else out.push({ literal: pattern[i] });
	}
	return out;
}

/**
 * Whether a branch name matches a rule's pattern: `*` stays within one path segment, `**` crosses
 * them, `?` is one character. A table over pattern and name positions, so it takes time proportional
 * to their lengths multiplied, whatever the pattern (a regular expression could backtrack for ages).
 */
export function patternMatches(pattern: string, branch: string): boolean {
	const t = tokens(pattern);
	// can[j]: the pattern so far matches branch[0, j).
	let can = new Array<boolean>(branch.length + 1).fill(false);
	can[0] = true;
	for (const token of t) {
		const next = new Array<boolean>(branch.length + 1).fill(false);
		for (let j = 0; j <= branch.length; j++) {
			if (token === "*" || token === "**") {
				// Zero characters, or one more than a match that ended just before (not a "/" for *).
				next[j] = can[j] || (j > 0 && next[j - 1] && (token === "**" || branch[j - 1] !== "/"));
			} else if (j > 0 && can[j - 1]) {
				next[j] = token === "?" ? branch[j - 1] !== "/" : branch[j - 1] === token.literal;
			}
		}
		can = next;
	}
	return can[branch.length];
}

export function validPattern(pattern: string): boolean {
	return /^[A-Za-z0-9._/*?-]{1,200}$/.test(pattern) && !pattern.includes("..") && !pattern.startsWith("/") && !pattern.endsWith("/");
}

/** What applies to a branch: every rule whose pattern matches it, combined. */
export function protectionFor(rules: BranchRule[], branch: string): Omit<BranchRule, "pattern" | "createdAt"> & { patterns: string[] } {
	const matching = rules.filter((r) => patternMatches(r.pattern, branch));
	return {
		patterns: matching.map((r) => r.pattern),
		blockDeletions: matching.some((r) => r.blockDeletions),
		blockForcePushes: matching.some((r) => r.blockForcePushes),
		requireMergeQueue: matching.some((r) => r.requireMergeQueue),
	};
}
