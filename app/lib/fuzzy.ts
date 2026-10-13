// Fuzzy file-path matching for "Go to file": the query's characters in order, anywhere in the path,
// ranked so matches in the file name, at word starts and in runs come first.

export interface FuzzyMatch {
	path: string;
	score: number;
	/** Indexes in `path` of the matched characters, for highlighting. */
	positions: number[];
}

const SEPARATOR = /[/._\-\s]/;

/** Where `query` (lowercase, no spaces) matches `lower` in order, starting the search at `from`; null if it doesn't. */
function subsequence(lower: string, query: string, from: number): number[] | null {
	const positions: number[] = [];
	let at = from;
	for (const ch of query) {
		const found = lower.indexOf(ch, at);
		if (found < 0) return null;
		positions.push(found);
		at = found + 1;
	}
	return positions;
}

function score(path: string, positions: number[], nameStart: number): number {
	let total = 0;
	for (let i = 0; i < positions.length; i++) {
		const p = positions[i];
		if (p >= nameStart) total += 4;
		if (p === 0 || SEPARATOR.test(path[p - 1])) total += 6;
		if (i > 0 && positions[i - 1] === p - 1) total += 8;
		else if (i > 0) total -= Math.min(p - positions[i - 1], 10) * 0.5;
	}
	// Shorter paths win ties.
	return total - path.length * 0.05;
}

export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
	const q = query.toLowerCase().replace(/\s+/g, "");
	if (!q) return { path, score: 0, positions: [] };
	const lower = path.toLowerCase();
	const nameStart = lower.lastIndexOf("/") + 1;
	// Matching inside the file name alone is usually what's meant; fall back to the whole path.
	const candidates = [subsequence(lower, q, nameStart), subsequence(lower, q, 0)].filter((p): p is number[] => p !== null);
	if (candidates.length === 0) return null;
	// A substring match is a run, which the greedy search can miss when an earlier character matches first.
	const exact = lower.lastIndexOf(q);
	if (exact >= 0) candidates.push(Array.from(q, (_, i) => exact + i));
	let best: FuzzyMatch | null = null;
	for (const positions of candidates) {
		const s = score(path, positions, nameStart);
		if (!best || s > best.score) best = { path, score: s, positions };
	}
	return best;
}

/** The best `limit` matches, best first. */
export function fuzzyFilter(query: string, paths: string[], limit = 50): FuzzyMatch[] {
	if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
	const matches: FuzzyMatch[] = [];
	for (const path of paths) {
		const m = fuzzyMatch(query, path);
		if (m) matches.push(m);
	}
	matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
	return matches.slice(0, limit);
}
