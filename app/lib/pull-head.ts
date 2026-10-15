// A pull request's head in compare and new pull request URLs, read the way the server reads it (pullHead in src/index.ts).

/** `head` is a ref here (an agent fork's `task:<id>` included), `owner:branch` as on GitHub, or a branch of `headRepo` (owner/name). */
export interface HeadSearch {
	head?: string;
	headRepo?: string;
}

/** Splits `owner:branch`. `task:<id>` names an agent fork here, never an owner called "task". */
export function parseHead(head: string | undefined): { owner?: string; branch?: string } {
	if (!head) return {};
	const colon = head.startsWith("task:") ? -1 : head.indexOf(":");
	return colon < 0 ? { branch: head } : { owner: head.slice(0, colon).toLowerCase(), branch: head.slice(colon + 1) || undefined };
}

/**
 * What `owner:` means, given that owner's repositories in the fork network that the caller can read
 * (the base among them if it's theirs): the one, or none, or too many to say, as the server decides.
 */
export function ownerRepo(candidates: { fullName: string }[]): { repo?: string; problem?: "unknown" | "ambiguous" } {
	if (candidates.length === 0) return { problem: "unknown" };
	if (candidates.length > 1) return { problem: "ambiguous" };
	return { repo: candidates[0].fullName };
}

/** The URL for a head: a ref here, or a branch and its `headRepo`, which is unambiguous however many repositories the owner has. */
export function headSearch(project: string, repo: string, branch: string | undefined): HeadSearch {
	return sameRepo(repo, project) ? { head: branch, headRepo: undefined } : { head: branch, headRepo: repo };
}

export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
