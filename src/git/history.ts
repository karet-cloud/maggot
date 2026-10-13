// A file's history and blame, from the repository's first-parent log: the commits where the file's
// content changed, and for each line of the current version, the commit that last changed it.
import { diffArrays } from "diff";
import type { Blame, Commit, FileHistory } from "../api.ts";
import { isBinary, mapLimit, TreeCache, type CommitObject, type ObjectReader } from "./diff.ts";

/** What history needs beyond object reads: a first-parent log, one request for many commits. */
export interface HistoryReader extends ObjectReader {
	log(opts: { ref: string; limit: number }): Promise<CommitObject[]>;
}

/** Commits one history request looks through. */
const SCAN = 300;
/** Commits blame looks through, and versions of the file it compares. */
const BLAME_SCAN = 1000;
const BLAME_VERSIONS = 100;
const BLAME_MAX_BYTES = 512 * 1024;
const BLAME_MAX_LINES = 10_000;
const READ_CONCURRENCY = 8;

const summary = (c: CommitObject): Commit => ({ hash: c.hash, message: c.message, author: c.author, parents: c.parents, committedAt: c.committedAt });

/** The blob a path names in a tree, or null if it isn't a file there. */
async function blobAt(trees: TreeCache, tree: string, path: string): Promise<string | null> {
	const parts = path.split("/");
	let hash = tree;
	for (const [i, part] of parts.entries()) {
		const entry = (await trees.read(hash)).find((e) => e.name === part);
		if (!entry) return null;
		if (i === parts.length - 1) return entry.type === "tree" || entry.type === "gitlink" ? null : entry.hash;
		if (entry.type !== "tree") return null;
		hash = entry.hash;
	}
	return null;
}

/**
 * The commits from `start` back (first parents) in which `path` changed: added, edited or deleted.
 * Looks through `scan` commits; `next` is where to carry on from, if there's more history.
 */
async function changes(repo: HistoryReader, start: string, path: string, scan: number): Promise<{ versions: { commit: CommitObject; blob: string | null }[]; next: string | null }> {
	const commits = await repo.log({ ref: start, limit: scan + 1 });
	const more = commits.length > scan;
	const window = commits.slice(0, scan + (more ? 1 : 0));
	// Unchanged subtrees keep their hashes from one commit to the next, so most reads are shared.
	const trees = new TreeCache(repo, window.length * Math.max(2, path.split("/").length) + 50);
	const blobs = await mapLimit(window, READ_CONCURRENCY, (c) => blobAt(trees, c.treeHash, path));
	const versions: { commit: CommitObject; blob: string | null }[] = [];
	for (let i = 0; i < Math.min(window.length, scan); i++) {
		// The last commit of the window compares with the one after it; the root commit with nothing.
		const parent = i + 1 < window.length ? blobs[i + 1] : null;
		if (blobs[i] !== parent) versions.push({ commit: window[i], blob: blobs[i] });
	}
	// The next page starts at the first commit not looked at yet.
	return { versions, next: more ? window[scan].hash : null };
}

/** The commits that changed `path`, newest first, starting at commit `start`. */
export async function fileHistory(repo: HistoryReader, start: string, path: string): Promise<FileHistory> {
	const { versions, next } = await changes(repo, start, path, SCAN);
	return {
		path,
		commits: versions.map((v) => ({ ...summary(v.commit), change: v.blob === null ? "deleted" : "modified" })),
		// The scan stops at SCAN commits; carry on from the last one looked at.
		next,
	};
}

async function lines(repo: ObjectReader, blob: string | null): Promise<string[] | null> {
	if (!blob) return [];
	const data = await repo.readBlob(blob);
	if (!data) return [];
	if (data.size > BLAME_MAX_BYTES) return null;
	const bytes = new Uint8Array(await data.arrayBuffer());
	if (isBinary(bytes)) return null;
	const text = new TextDecoder().decode(bytes);
	const out = text.split("\n");
	if (out.at(-1) === "") out.pop();
	return out;
}

/**
 * Who last changed each line of `path` at commit `start`. Walks the file's versions newest first,
 * diffing each with the one before: lines a version added belong to its commit, and lines it kept are
 * followed into the older version. Lines still unclaimed when the history (or the budget) runs out
 * belong to the oldest version seen, marked `boundary` if there was more history to look at.
 */
export async function blame(repo: HistoryReader, start: string, path: string): Promise<Blame> {
	const { versions, next } = await changes(repo, start, path, BLAME_SCAN);
	if (versions.length === 0 || versions[0].blob === null) throw new Error(`${path} isn't a file at this commit`);
	const current = await lines(repo, versions[0].blob);
	if (current === null) return { path, lines: [], commits: {}, tooLarge: true };
	if (current.length > BLAME_MAX_LINES) return { path, lines: [], commits: {}, tooLarge: true };
	const owner: (number | null)[] = current.map(() => null);
	/** For each line of the version being looked at, the line of the current file it is (or -1). */
	let live = current.map((_, i) => i);
	let newer = current;
	const used = versions.slice(0, BLAME_VERSIONS);
	let oldest = 0;
	for (let k = 0; k < used.length; k++) {
		oldest = k;
		const older = k + 1 < used.length ? await lines(repo, used[k + 1].blob) : null;
		if (k + 1 < used.length && older === null) break; // a binary or huge old version: stop here
		const parts = diffArrays(older ?? [], newer);
		const nextLive: number[] = (older ?? []).map(() => -1);
		let o = 0;
		let n = 0;
		for (const part of parts) {
			const count = part.count ?? part.value.length;
			if (part.added) {
				for (let i = 0; i < count; i++, n++) if (live[n] >= 0 && owner[live[n]] === null) owner[live[n]] = k;
			} else if (part.removed) {
				o += count;
			} else {
				for (let i = 0; i < count; i++, o++, n++) nextLive[o] = live[n];
			}
		}
		if (k + 1 >= used.length) break;
		live = nextLive;
		newer = older ?? [];
		if (live.every((l) => l < 0 || owner[l] !== null)) break;
	}
	const boundary = next !== null || versions.length > used.length;
	const resolved = owner.map((o) => o ?? oldest);
	const commits: Blame["commits"] = {};
	for (const k of new Set(resolved)) commits[used[k].commit.hash] = summary(used[k].commit);
	return {
		path,
		lines: current.map((text, i) => ({ text, commit: used[resolved[i]].commit.hash, boundary: owner[i] === null && boundary })),
		commits,
		tooLarge: false,
	};
}
