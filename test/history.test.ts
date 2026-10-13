import assert from "node:assert/strict";
import { test } from "node:test";
import { blame, fileHistory, type HistoryReader } from "../src/git/history.ts";
import type { CommitObject, TreeEntry } from "../src/git/diff.ts";

/** A linear repository in memory: each commit is the full set of files, newest last in `snapshots`. */
function repo(snapshots: Record<string, string>[]): { reader: HistoryReader; hashes: string[] } {
	const trees = new Map<string, TreeEntry[]>();
	const blobs = new Map<string, string>();
	const commits = new Map<string, CommitObject>();
	const writeTree = (files: Record<string, string>): string => {
		const entries = new Map<string, TreeEntry>();
		const dirs = new Map<string, Record<string, string>>();
		for (const [path, content] of Object.entries(files)) {
			const [head, ...rest] = path.split("/");
			if (rest.length) dirs.set(head, { ...dirs.get(head), [rest.join("/")]: content });
			else {
				blobs.set(`b:${content}`, content);
				entries.set(head, { name: head, mode: "100644", hash: `b:${content}`, type: "blob" });
			}
		}
		for (const [name, sub] of dirs) entries.set(name, { name, mode: "040000", hash: writeTree(sub), type: "tree" });
		const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
		const hash = `t:${JSON.stringify(list.map((e) => [e.name, e.hash]))}`;
		trees.set(hash, list);
		return hash;
	};
	const hashes: string[] = [];
	snapshots.forEach((files, i) => {
		const hash = `c${i}`;
		commits.set(hash, { hash, treeHash: writeTree(files), message: `commit ${i}`, author: { name: `a${i}`, email: "" }, parents: i ? [`c${i - 1}`] : [], committedAt: 1000 + i });
		hashes.push(hash);
	});
	const reader: HistoryReader = {
		readTree: async (h) => trees.get(h) ?? null,
		readBlob: async (h) => (blobs.has(h) ? new Blob([blobs.get(h) as string]) : null),
		readCommit: async (h) => commits.get(h) ?? null,
		log: async ({ ref, limit }) => {
			const out: CommitObject[] = [];
			for (let c = commits.get(ref); c && out.length < limit; c = commits.get(c.parents[0])) out.push(c);
			return out;
		},
	};
	return { reader, hashes };
}

test("file history lists only the commits that changed the file, newest first", async () => {
	const { reader, hashes } = repo([
		{ "src/a.ts": "one\n", "README.md": "x" },
		{ "src/a.ts": "one\n", "README.md": "y" },
		{ "src/a.ts": "one\ntwo\n", "README.md": "y" },
		{ "README.md": "y" },
		{ "src/a.ts": "back\n", "README.md": "z" },
	]);
	const history = await fileHistory(reader, hashes[4], "src/a.ts");
	assert.deepEqual(history.commits.map((c) => [c.hash, c.change]), [["c4", "modified"], ["c3", "deleted"], ["c2", "modified"], ["c0", "modified"]]);
	assert.equal(history.next, null);
});

test("blame gives each line to the commit that last changed it", async () => {
	const { reader, hashes } = repo([
		{ "f.txt": "alpha\nbeta\ngamma\n" },
		{ "f.txt": "alpha\nBETA\ngamma\n" },
		{ "f.txt": "alpha\nBETA\ngamma\ndelta\n", "other.txt": "noise" },
		{ "f.txt": "zero\nalpha\nBETA\ngamma\ndelta\n" },
	]);
	const result = await blame(reader, hashes[3], "f.txt");
	assert.deepEqual(
		result.lines.map((l) => [l.text, l.commit]),
		[["zero", "c3"], ["alpha", "c0"], ["BETA", "c1"], ["gamma", "c0"], ["delta", "c2"]],
	);
	assert.ok(result.lines.every((l) => !l.boundary));
	assert.deepEqual(Object.keys(result.commits).sort(), ["c0", "c1", "c2", "c3"]);
});
