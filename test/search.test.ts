// The tree index and code search on Node's SQLite (with FTS5), standing in for a Durable Object's storage.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { CommitObject, ObjectReader, TreeEntry } from "../src/git/diff.ts";
import { CodeIndex, type Sql } from "../src/search.ts";
import { TreeIndex, type IndexLimits } from "../src/tree-index.ts";

/** A Durable Object's `exec`, on Node's SQLite: bound parameters, rows back. */
function sqlStorage(db: DatabaseSync): Sql {
	return {
		exec(query: string, ...params: unknown[]) {
			const rows = params.length === 0 && query.trim().split(";").filter((s) => s.trim()).length > 1 ? (db.exec(query), []) : db.prepare(query).all(...(params as never[]));
			return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		},
	} as Sql;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

type Content = string | Uint8Array | { exec: string } | { link: string };

/** Trees from `{ path: content }` maps, content-addressed like git. Counts the reads an index makes. */
class Store implements ObjectReader {
	readonly blobs = new Map<string, Uint8Array>();
	readonly trees = new Map<string, TreeEntry[]>();
	treeReads = 0;
	blobReads: string[] = [];
	tree(files: Record<string, Content>): string {
		const dirs = new Map<string, Record<string, Content>>();
		const entries: TreeEntry[] = [];
		for (const [path, content] of Object.entries(files)) {
			const [head, ...rest] = path.split("/");
			if (rest.length) dirs.set(head, { ...dirs.get(head), [rest.join("/")]: content });
			else {
				const exec = typeof content === "object" && "exec" in content;
				const link = typeof content === "object" && "link" in content;
				const raw = exec ? content.exec : link ? content.link : (content as string | Uint8Array);
				const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
				const hash = sha(`blob ${Buffer.from(bytes).toString("base64")}`);
				this.blobs.set(hash, bytes);
				entries.push({ name: head, mode: exec ? "100755" : link ? "120000" : "100644", type: exec ? "exec" : link ? "symlink" : "blob", hash });
			}
		}
		for (const [name, sub] of dirs) entries.push({ name, mode: "40000", type: "tree", hash: this.tree(sub) });
		const hash = sha(`tree ${JSON.stringify(entries)}`);
		this.trees.set(hash, entries);
		return hash;
	}
	async readTree(hash: string) {
		this.treeReads++;
		return this.trees.get(hash) ?? null;
	}
	async readBlob(hash: string) {
		this.blobReads.push(hash);
		const bytes = this.blobs.get(hash);
		return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
	}
	async readCommit(): Promise<CommitObject | null> {
		return null;
	}
}

function setup(limits: Partial<IndexLimits> = {}) {
	const sql = sqlStorage(new DatabaseSync(":memory:"));
	const code = new CodeIndex(sql);
	assert.ok(code.available, "this SQLite has FTS5");
	const count = () => (sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tree_entries").one() as { n: number }).n;
	return { code, index: new TreeIndex(sql, code, limits), store: new Store(), count };
}

/** Runs the index to `commit` the way the alarm does, step by step; returns how many steps it took. */
async function update(index: TreeIndex, store: Store, commit: string, tree: string): Promise<number> {
	index.target(commit, tree);
	let steps = 0;
	while (await index.step(store)) steps++;
	return steps;
}

const paths = (index: CodeIndex, q: string) => index.search(q).results.map((r) => r.path).sort();
const names = (index: TreeIndex, commit: string, dir: string) => {
	const listing = index.listing(commit, dir);
	return listing && "entries" in listing ? listing.entries.map((e) => `${e.type === "tree" ? "d" : "f"}:${e.name}`) : listing;
};

test("code search follows edits, deletes and renames, and skips binary files", async () => {
	const { code, index, store } = setup();
	const one = store.tree({ "src/a.ts": "const quokka = 1;\n", "src/gone.ts": "pangolin\n", "img.bin": new Uint8Array([0, 1, 2, 113, 117, 111]) });
	await update(index, store, "c1", one);
	assert.deepEqual(paths(code, "quokka"), ["src/a.ts"]);
	assert.deepEqual(paths(code, "pangolin"), ["src/gone.ts"]);
	assert.equal(code.state()?.files, 2, "the binary file isn't indexed");

	const two = store.tree({ "src/a.ts": "const wombat = 2;\n", "lib/moved.ts": "pangolin\n", "img.bin": new Uint8Array([0, 1, 2]) });
	await update(index, store, "c2", two);
	assert.deepEqual(paths(code, "quokka"), [], "the old text of an edited file is gone");
	assert.deepEqual(paths(code, "wombat"), ["src/a.ts"]);
	assert.deepEqual(paths(code, "pangolin"), ["lib/moved.ts"], "a moved file is found only at its new path");
	assert.equal(code.state()?.files, 2);
	assert.deepEqual(code.search("a.t").results.map((r) => [r.path, r.lines.length]), [["src/a.ts", 0]], "names match too");
	assert.equal(code.state()?.commit, "c2");
});

test("the tree index lists every directory with sizes and serves the file finder", async () => {
	const { index, store } = setup();
	const tree = store.tree({ "README.md": "hi\n", "src/b.ts": "bb\n", "src/a.ts": "a\n", "src/lib/deep.ts": "deep\n", "docs/x.md": "x\n" });
	assert.equal(index.listing("c1", ""), null, "nothing to list before the first update");
	await update(index, store, "c1", tree);
	assert.deepEqual(names(index, "c1", ""), ["d:docs", "d:src", "f:README.md"], "directories first, then files, each alphabetical");
	assert.deepEqual(names(index, "c1", "src"), ["d:lib", "f:a.ts", "f:b.ts"]);
	assert.deepEqual(names(index, "c1", "src/lib/"), ["f:deep.ts"]);
	const listing = index.listing("c1", "src");
	assert.ok(listing && "entries" in listing);
	assert.deepEqual(
		listing.entries.map((e) => [e.path, e.size]),
		[["src/lib", null], ["src/a.ts", 2], ["src/b.ts", 3]],
	);
	assert.ok(listing.entries.every((e) => store.trees.has(e.hash) || store.blobs.has(e.hash)), "entries carry their object ids");
	assert.deepEqual(index.listing("c1", "README.md/x"), { missing: "README.md" });
	assert.deepEqual(index.listing("c1", "nope"), { missing: "nope" });
	assert.equal(index.listing("other", ""), null, "only the indexed commit is answered for");
	assert.deepEqual(index.paths("c1", 100), { paths: ["README.md", "docs/x.md", "src/a.ts", "src/b.ts", "src/lib/deep.ts"], truncated: false });
	assert.deepEqual(index.paths("c1", 2), { paths: ["README.md", "docs/x.md"], truncated: true });
});

test("an update reads only what changed and ends where a fresh index would", async () => {
	const { code, index, store } = setup();
	const files: Record<string, Content> = { "keep/k.ts": "same\n", "src/edit.ts": "before\n", "src/old/x.ts": "x\n", "becomes-dir": "file\n", "run.sh": "echo\n" };
	for (let i = 0; i < 40; i++) files[`many/f${i}.txt`] = `file ${i}\n`;
	await update(index, store, "c1", store.tree(files));

	const next: Record<string, Content> = { ...files, "src/edit.ts": "after!\n", "becomes-dir/inner.ts": "now a dir\n", "run.sh": { exec: "echo\n" }, "src/new.ts": "new\n" };
	delete next["src/old/x.ts"];
	delete next["becomes-dir"];
	const tree = store.tree(next);
	store.treeReads = 0;
	store.blobReads = [];
	await update(index, store, "c2", tree);
	// Changed directories only: root and src on both sides, and the new becomes-dir.
	assert.equal(store.treeReads, 5, "unchanged directories (keep/, many/) aren't read");
	assert.equal(store.blobReads.length, 3, "only the edited and the new files are read; a mode change isn't");

	const fresh = setup();
	await update(fresh.index, store, "c2", tree);
	for (const dir of ["", "src", "becomes-dir", "keep", "many"]) {
		assert.deepEqual(index.listing("c2", dir), fresh.index.listing("c2", dir), `"${dir}" matches a fresh index`);
	}
	assert.deepEqual(index.paths("c2", 1000), fresh.index.paths("c2", 1000));
	assert.deepEqual(index.listing("c2", "src/old"), { missing: "src/old" }, "a deleted directory is gone with everything in it");
	assert.equal(code.state()?.files, fresh.code.state()?.files, "code search holds the same files");
	assert.deepEqual(paths(code, "before"), [], "an edited file's old text is gone");
	assert.deepEqual(paths(code, "now a dir"), ["becomes-dir/inner.ts"]);
});

test("an update is spread over bounded steps, isn't listed until its walk is done, and queues a newer head", async () => {
	const { code, index, store } = setup();
	const files: Record<string, string> = {};
	for (let d = 0; d < 100; d++) files[`dir${d}/file.txt`] = `content ${d}\n`;
	const one = store.tree(files);
	index.target("c1", one);
	assert.equal(await index.step(store), true);
	assert.equal(await index.step(store), true);
	assert.equal(index.current("c1"), false, "a half-walked tree isn't listed");
	const two = store.tree({ ...files, "late.txt": "pushed meanwhile\n" });
	index.target("c2", two);
	let steps = 2;
	while (await index.step(store)) {
		steps++;
		assert.ok(steps < 50, "the update ends");
	}
	assert.ok(steps > 4, `the work took several steps (${steps})`);
	assert.equal(index.current("c2"), true, "it went on to the newer head");
	assert.equal(index.busy(), false);
	assert.equal(code.state()?.commit, "c2");
	assert.equal(code.state()?.files, 101);
	assert.deepEqual(paths(code, "meanwhile"), ["late.txt"]);
});

test("the same tree under a new commit needs no reads", async () => {
	const { index, store } = setup();
	const tree = store.tree({ "a.txt": "a\n" });
	await update(index, store, "c1", tree);
	store.treeReads = 0;
	await update(index, store, "c2", tree);
	assert.equal(store.treeReads, 0);
	assert.equal(index.current("c2"), true);
});

test("files becoming directories and back, and symlinks becoming files with the same content, index like a fresh build", async () => {
	const { code, index, store, count } = setup();
	const one = store.tree({ "a/inner.ts": "apple\n", b: "banana\n", link: { link: "cherry" }, file: "durian\n" });
	await update(index, store, "c1", one);
	assert.deepEqual(paths(code, "cherry"), [], "a symlink's target isn't searchable text");
	const two = store.tree({ a: "apple file\n", "b/inner.ts": "banana dir\n", link: "cherry", file: { link: "durian\n" } });
	await update(index, store, "c2", two);
	const fresh = setup();
	await update(fresh.index, store, "c2", two);
	for (const dir of ["", "b"]) assert.deepEqual(index.listing("c2", dir), fresh.index.listing("c2", dir), `"${dir}"`);
	assert.deepEqual(index.listing("c2", "a"), { missing: "a" }, "the old directory is gone with its contents");
	assert.deepEqual(paths(code, "cherry"), ["link"], "a symlink that became a file with the same blob is read and indexed");
	assert.deepEqual(paths(code, "durian"), [], "a file that became a symlink with the same blob leaves search");
	assert.deepEqual(paths(code, "banana"), ["b/inner.ts"]);
	assert.equal(index.state().entries, count(), "the running entry count matches the table");
	assert.equal(index.state().entries, fresh.count());
});

test("one huge directory is written a bounded number of entries per step", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 95; i++) files[`flat/f${String(i).padStart(3, "0")}.txt`] = `n${i}\n`;
	const { index, store, count } = setup({ entriesPerStep: 10 });
	const tree = store.tree(files);
	index.target("c1", tree);
	let walkSteps = 0;
	let before = count();
	while (index.state().update?.walking) {
		await index.step(store);
		walkSteps++;
		assert.ok(count() - before <= 10, "no step writes more than entriesPerStep entries");
		before = count();
	}
	assert.ok(walkSteps >= 10, `the directory took ${walkSteps} steps`);
	while (await index.step(store)) {}
	assert.equal(index.paths("c1", 1000)?.paths.length, 95);
	assert.equal(index.state().entries, 96);
});

test("an index too big to list gives partial search, and isn't rebuilt for the same commit", async () => {
	const files: Record<string, string> = {};
	// The root's own files (a*, sorting first) are queued before its directories pass the cap.
	for (let i = 0; i < 10; i++) files[`a${i}.txt`] = `word${i} kiwi\n`;
	for (let i = 0; i < 30; i++) files[`d${i}/f.txt`] = `word${i} kiwi\n`;
	const { code, index, store } = setup({ maxEntries: 20, dirsPerStep: 4 });
	const tree = store.tree(files);
	await update(index, store, "c1", tree);
	assert.equal(index.listing("c1", ""), null, "nothing is listed");
	assert.equal(index.state().overflow, "c1");
	assert.equal(code.state()?.commit, "c1");
	assert.equal(code.state()?.partial, true);
	assert.ok(paths(code, "kiwi").length > 0, "the files queued before the overflow are searchable");
	store.treeReads = 0;
	index.target("c1", tree);
	assert.equal(index.busy(), false, "asking again for the same commit starts nothing");
	assert.equal(store.treeReads, 0);
	assert.equal(index.settled("c1"), true);
});

test("an overflow partway through an update starts that commit over, leaving no deleted file searchable", async () => {
	const { code, index, store } = setup({ maxEntries: 12, dirsPerStep: 1 });
	const one = store.tree({ "a/x.txt": "x\n", "z/gone.txt": "zebra\n" });
	await update(index, store, "c1", one);
	assert.deepEqual(paths(code, "zebra"), ["z/gone.txt"]);
	// "a" (walked first) grows past the cap; "z", where the deletion is, is never reached by that walk.
	const files: Record<string, string> = { "z/kept.txt": "kept\n" };
	for (let i = 0; i < 20; i++) files[`a/n${i}.txt`] = `new ${i}\n`;
	await update(index, store, "c2", store.tree(files));
	assert.deepEqual(paths(code, "zebra"), [], "the deleted file is out of search");
	assert.equal(code.state()?.commit, "c2");
	assert.equal(code.state()?.partial, true);
	assert.equal(index.state().overflow, "c2");
	assert.equal(index.listing("c2", ""), null);
});

test("a head that moves away and back while walking doesn't leave the index heading elsewhere", async () => {
	const { index, store } = setup({ dirsPerStep: 1 });
	const files: Record<string, string> = {};
	for (let d = 0; d < 5; d++) files[`dir${d}/f.txt`] = `f${d}\n`;
	const b = store.tree(files);
	const c = store.tree({ ...files, "c.txt": "c\n" });
	index.target("B", b);
	await index.step(store);
	assert.equal(index.state().update?.walking, true);
	index.target("C", c);
	assert.equal(index.state().next?.commit, "C");
	index.target("B", b);
	assert.equal(index.state().next, null, "back to B: C is no longer where the branch is");
	while (await index.step(store)) {}
	assert.equal(index.current("B"), true);
	assert.equal(index.current("C"), false);
});

test("failed steps back off, and after five in a row the index is dropped", async () => {
	const { code, index, store } = setup();
	await update(index, store, "c1", store.tree({ "a.txt": "apricot\n" }));
	const now = 1_000_000;
	index.failed(now);
	const first = index.retryAt();
	assert.ok(first > now);
	index.failed(now);
	assert.ok(index.retryAt() > first, "each failure waits longer");
	index.succeeded();
	assert.equal(index.retryAt(), 0, "a success clears it");
	for (let i = 0; i < 4; i++) index.failed(now);
	assert.equal(index.current("c1"), true, "four failures keep the index");
	index.failed(now);
	assert.equal(index.current("c1"), false, "the fifth drops it");
	assert.equal(index.retryAt(), 0);
	assert.equal(code.state(), null, "code search with it");
});
