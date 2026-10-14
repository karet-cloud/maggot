// The tree index and code search on Node's SQLite (with FTS5), standing in for a Durable Object's storage.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { CommitObject, ObjectReader, TreeEntry } from "../src/git/diff.ts";
import { CodeIndex, type Sql } from "../src/search.ts";
import { TreeIndex } from "../src/tree-index.ts";

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

type Content = string | Uint8Array | { exec: string };

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
				const raw = exec ? content.exec : content;
				const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
				const hash = sha(`blob ${Buffer.from(bytes).toString("base64")}`);
				this.blobs.set(hash, bytes);
				entries.push({ name: head, mode: exec ? "100755" : "100644", type: exec ? "exec" : "blob", hash });
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

function setup() {
	const sql = sqlStorage(new DatabaseSync(":memory:"));
	const code = new CodeIndex(sql);
	assert.ok(code.available, "this SQLite has FTS5");
	return { code, index: new TreeIndex(sql, code), store: new Store() };
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
