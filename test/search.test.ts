// The code search index on Node's SQLite (with FTS5), standing in for a Durable Object's storage.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { CommitObject, ObjectReader, TreeEntry } from "../src/git/diff.ts";
import { CodeIndex, type Sql } from "../src/search.ts";

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

/** Trees from `{ path: content }` maps, content-addressed like git. */
class Store implements ObjectReader {
	readonly blobs = new Map<string, Uint8Array>();
	readonly trees = new Map<string, TreeEntry[]>();
	tree(files: Record<string, string | Uint8Array>): string {
		const dirs = new Map<string, Record<string, string | Uint8Array>>();
		const entries: TreeEntry[] = [];
		for (const [path, content] of Object.entries(files)) {
			const [head, ...rest] = path.split("/");
			if (rest.length) dirs.set(head, { ...dirs.get(head), [rest.join("/")]: content });
			else {
				const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
				const hash = sha(`blob ${Buffer.from(bytes).toString("base64")}`);
				this.blobs.set(hash, bytes);
				entries.push({ name: head, mode: "100644", type: "blob", hash });
			}
		}
		for (const [name, sub] of dirs) entries.push({ name, mode: "40000", type: "tree", hash: this.tree(sub) });
		const hash = sha(`tree ${JSON.stringify(entries)}`);
		this.trees.set(hash, entries);
		return hash;
	}
	async readTree(hash: string) {
		return this.trees.get(hash) ?? null;
	}
	async readBlob(hash: string) {
		const bytes = this.blobs.get(hash);
		return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null;
	}
	async readCommit(): Promise<CommitObject | null> {
		return null;
	}
}

const paths = (index: CodeIndex, q: string) => index.search(q).results.map((r) => r.path).sort();

test("the index follows edits, deletes and renames, and skips binary files", async () => {
	const index = new CodeIndex(sqlStorage(new DatabaseSync(":memory:")));
	assert.ok(index.available, "this SQLite has FTS5");
	const store = new Store();
	const one = store.tree({ "src/a.ts": "const quokka = 1;\n", "src/gone.ts": "pangolin\n", "img.bin": new Uint8Array([0, 1, 2, 113, 117, 111]) });
	await index.update(store, "c1", one);
	assert.deepEqual(paths(index, "quokka"), ["src/a.ts"]);
	assert.deepEqual(paths(index, "pangolin"), ["src/gone.ts"]);
	assert.equal(index.state()?.files, 2, "the binary file isn't indexed");

	const two = store.tree({ "src/a.ts": "const wombat = 2;\n", "lib/moved.ts": "pangolin\n", "img.bin": new Uint8Array([0, 1, 2]) });
	await index.update(store, "c2", two);
	assert.deepEqual(paths(index, "quokka"), [], "the old text of an edited file is gone");
	assert.deepEqual(paths(index, "wombat"), ["src/a.ts"]);
	assert.deepEqual(paths(index, "pangolin"), ["lib/moved.ts"], "a moved file is found only at its new path");
	assert.equal(index.state()?.files, 2);
	assert.deepEqual(index.search("a.t").results.map((r) => [r.path, r.lines.length]), [["src/a.ts", 0]], "names match too");
	assert.equal(index.state()?.commit, "c2");
});
