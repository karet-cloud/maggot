import { structuredPatch } from "diff";
import type { Commit, Diff, DiffHunk, FileDiff } from "../api.ts";

// Structural copies of the Artifacts types this module reads, so it also type-checks (and runs) outside
// the Worker, in tests.
export interface TreeEntry {
	name: string;
	mode: string;
	hash: string;
	type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

export interface CommitObject {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string; email: string };
	parents: string[];
	committedAt: number;
}

/** Just the object reads a diff needs; satisfied by an Artifacts repo. */
export interface ObjectReader {
	readTree(hash: string): Promise<TreeEntry[] | null>;
	readBlob(hash: string): Promise<Blob | null>;
	readCommit(hash: string): Promise<CommitObject | null>;
}

const MAX_FILES = 300;
/** Files bigger than this are listed without hunks. */
const MAX_FILE_BYTES = 512 * 1024;
/** Once this many diff lines are shown, remaining files are listed without hunks. */
const MAX_TOTAL_LINES = 20_000;
/** Blob bytes one diff may read in total; past it, remaining files are listed without hunks. */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/**
 * Edit distance past which Myers (O(N·D)) gives up; such files are shown as a whole-file replacement
 * instead. 1,000 keeps a 4,000-line rewrite under ~100 ms of CPU.
 */
const MAX_EDIT_LENGTH = 1_000;
const READ_CONCURRENCY = 8;
/**
 * Tree reads one diff may make. Trees can share subtrees (a small repository can describe a huge
 * directory structure), so the walk is bounded by reads and directories, not just by changed files.
 */
const MAX_TREE_READS = 2_000;

export interface Change {
	path: string;
	before: TreeEntry | null;
	after: TreeEntry | null;
}

type Content = { kind: "text"; text: string } | { kind: "binary" } | { kind: "large" };

/** Shared by every file of one diff, so the limits hold for the request as a whole. */
interface Budget {
	lines: number;
	bytes: number;
}

/** Diffs two root trees. `base` null means everything in `head` is added (a root commit). */
export async function diffTrees(repo: ObjectReader, base: string | null, head: string): Promise<Diff> {
	const { changes, truncated } = await collect(repo, base, head);
	changes.sort((a, b) => a.path.localeCompare(b.path));
	const budget: Budget = { lines: MAX_TOTAL_LINES, bytes: MAX_TOTAL_BYTES };
	const files = await mapLimit(changes, READ_CONCURRENCY, (change) => fileDiff(repo, change, budget));
	return {
		files,
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0),
		truncated,
	};
}

/**
 * Walks both trees breadth-first with bounded concurrency, skipping identical subtrees, and stops
 * once more than MAX_FILES changed files are found.
 */
/** Paths that differ between two root trees (`base` null: everything in `head`), up to `maxFiles`. */
export async function changedFiles(repo: ObjectReader, base: string | null, head: string, maxFiles: number, maxTreeReads = MAX_TREE_READS) {
	return collect(repo, base, head, maxFiles, maxTreeReads);
}

async function collect(
	repo: ObjectReader,
	base: string | null,
	head: string,
	maxFiles = MAX_FILES,
	maxTreeReads = MAX_TREE_READS,
): Promise<{ changes: Change[]; truncated: boolean }> {
	const changes: Change[] = [];
	const trees = new TreeCache(repo, maxTreeReads);
	let level: { before: string | null; after: string | null; prefix: string }[] = [{ before: base, after: head, prefix: "" }];
	while (level.length > 0 && changes.length <= maxFiles) {
		// Each directory pair costs up to two reads; stop before a level could overrun the budget.
		if (level.length > maxTreeReads || !trees.hasRoomFor(level.length * 2)) break;
		const next: typeof level = [];
		await mapLimit(level, READ_CONCURRENCY, async ({ before, after, prefix }) => {
			if (before === after || changes.length > maxFiles) return;
			const [a, b] = await Promise.all([before ? trees.read(before) : [], after ? trees.read(after) : []]);
			const left = new Map(a.map((e) => [e.name, e]));
			const right = new Map(b.map((e) => [e.name, e]));
			for (const name of new Set([...left.keys(), ...right.keys()])) {
				const x = left.get(name) ?? null;
				const y = right.get(name) ?? null;
				if (x && y && x.hash === y.hash && x.mode === y.mode) continue;
				const path = prefix + name;
				const xTree = x?.type === "tree" ? x : null;
				const yTree = y?.type === "tree" ? y : null;
				if (xTree || yTree) next.push({ before: xTree?.hash ?? null, after: yTree?.hash ?? null, prefix: `${path}/` });
				// A file replaced by a directory (or the reverse) shows up as a deletion plus additions.
				const xFile = xTree ? null : x;
				const yFile = yTree ? null : y;
				if (xFile || yFile) changes.push({ path, before: xFile, after: yFile });
			}
		});
		level = next;
	}
	const truncated = changes.length > maxFiles || level.length > 0;
	return { changes: changes.slice(0, maxFiles), truncated };
}

/**
 * Reads trees at most once each, and at most `budget` reads in all. Callers check `hasRoomFor`
 * before a batch; a read past the budget is an error rather than silently skipped.
 */
export class TreeCache {
	private readonly cache = new Map<string, Promise<TreeEntry[]>>();
	private readonly repo: ObjectReader;
	private remaining: number;

	constructor(repo: ObjectReader, budget: number) {
		this.repo = repo;
		this.remaining = budget;
	}

	hasRoomFor(reads: number): boolean {
		return this.remaining >= reads;
	}

	read(hash: string): Promise<TreeEntry[]> {
		let tree = this.cache.get(hash);
		if (!tree) {
			if (this.remaining <= 0) throw new Error("Too many directories to read");
			this.remaining--;
			tree = this.repo.readTree(hash).then((t) => {
				if (!t) throw new Error(`Tree ${hash} is missing`);
				return t;
			});
			this.cache.set(hash, tree);
		}
		return tree;
	}
}

async function fileDiff(repo: ObjectReader, { path, before, after }: Change, budget: Budget): Promise<FileDiff> {
	const file: FileDiff = {
		path,
		status: !before ? "added" : !after ? "deleted" : "modified",
		oldMode: before?.mode ?? null,
		newMode: after?.mode ?? null,
		additions: 0,
		deletions: 0,
		binary: false,
		tooLarge: false,
		hunks: [],
	};
	if (before?.hash === after?.hash) return file; // a mode-only change
	if (budget.lines <= 0 || budget.bytes <= 0) return { ...file, tooLarge: true };
	const [a, b] = await Promise.all([content(repo, before, budget), content(repo, after, budget)]);
	if (a.kind === "large" || b.kind === "large") return { ...file, tooLarge: true };
	if (a.kind === "binary" || b.kind === "binary") return { ...file, binary: true };
	const patch = structuredPatch(path, path, a.text, b.text, "", "", { context: 3, maxEditLength: MAX_EDIT_LENGTH });
	const hunks: DiffHunk[] = patch
		? patch.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines }))
		: [replacement(a.text, b.text)];
	const lines = hunks.reduce((n, h) => n + h.lines.length, 0);
	// Checked and spent with no await in between, so concurrent files can't overdraw it.
	if (lines > budget.lines) return { ...file, tooLarge: true };
	budget.lines -= lines;
	for (const h of hunks) {
		for (const line of h.lines) {
			if (line[0] === "+") file.additions++;
			else if (line[0] === "-") file.deletions++;
		}
	}
	return { ...file, hunks };
}

/** One hunk that removes every old line and adds every new one: the diff when Myers gives up. */
function replacement(before: string, after: string): DiffHunk {
	const split = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
	const old = split(before);
	const now = split(after);
	return {
		oldStart: old.length ? 1 : 0,
		oldLines: old.length,
		newStart: now.length ? 1 : 0,
		newLines: now.length,
		lines: [...old.map((l) => `-${l}`), ...now.map((l) => `+${l}`)],
	};
}

async function content(repo: ObjectReader, entry: TreeEntry | null, budget: Budget): Promise<Content> {
	if (!entry) return { kind: "text", text: "" };
	if (entry.type === "gitlink") return { kind: "text", text: `Subproject commit ${entry.hash}\n` };
	let blob: Blob | null;
	try {
		blob = await repo.readBlob(entry.hash);
	} catch (err) {
		if ((err as { code?: string }).code === "MEMORY_LIMIT") return { kind: "large" };
		throw err;
	}
	if (!blob) throw new Error(`Blob ${entry.hash} is missing`);
	if (blob.size > MAX_FILE_BYTES || blob.size > budget.bytes) return { kind: "large" };
	budget.bytes -= blob.size;
	const bytes = new Uint8Array(await blob.arrayBuffer());
	if (isBinary(bytes)) return { kind: "binary" };
	return { kind: "text", text: new TextDecoder().decode(bytes) };
}

/** Git's heuristic: a NUL byte in the first 8000 bytes. */
export function isBinary(bytes: Uint8Array): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

export interface Ancestry {
	/** The newest `mainline` commit reachable from the head; null if none was found within the limit. */
	mergeBase: string | null;
	/** Commits reachable from the head but not through `mainline`, newest first. */
	commits: Commit[];
	/** Number of `mainline` commits newer than the merge base. */
	behind: number | null;
	capped: boolean;
}

/**
 * Walks back from `head` until each path meets `mainline` (the default branch's first-parent
 * history, newest first). Everything visited before that is what the head has that the default
 * branch doesn't. A branch that merged the default branch in stops at the merged commit.
 */
export async function walkToMainline(repo: ObjectReader, head: string, mainline: string[], limit = 500): Promise<Ancestry> {
	const index = new Map(mainline.map((hash, i) => [hash, i]));
	const seen = new Set<string>([head]);
	const commits: CommitObject[] = [];
	let frontier = [head];
	let best: number | null = null;
	let capped = false;
	while (frontier.length > 0) {
		const next: string[] = [];
		const unknown: string[] = [];
		for (const hash of frontier) {
			const i = index.get(hash);
			if (i === undefined) unknown.push(hash);
			else if (best === null || i < best) best = i;
		}
		if (commits.length + unknown.length > limit) {
			capped = true;
			break;
		}
		const read = await mapLimit(unknown, READ_CONCURRENCY, (hash) => repo.readCommit(hash));
		for (const commit of read) {
			if (!commit) continue;
			commits.push(commit);
			for (const parent of commit.parents) {
				if (!seen.has(parent)) {
					seen.add(parent);
					next.push(parent);
				}
			}
		}
		frontier = next;
	}
	return {
		mergeBase: best === null ? null : mainline[best],
		commits: commits
			.sort((a, b) => b.committedAt - a.committedAt)
			.map((c) => ({ hash: c.hash, message: c.message, author: c.author, parents: c.parents, committedAt: c.committedAt })),
		behind: best,
		capped,
	};
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
