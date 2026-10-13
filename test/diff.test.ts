// Diffs, archives and the receive-pack parser against an in-memory object store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { archiveStream, listFiles } from "../src/archive.ts";
import { diffTrees, walkToMainline, type CommitObject, type ObjectReader, type TreeEntry } from "../src/git/diff.ts";
import { deleteBranch } from "../src/git/protocol.ts";

/** A tiny content-addressed store: trees are built from `{ path: content }` maps. */
class Store implements ObjectReader {
	readonly blobs = new Map<string, string>();
	readonly trees = new Map<string, TreeEntry[]>();
	readonly commits = new Map<string, CommitObject>();
	treeReads = 0;
	maxConcurrentTreeReads = 0;
	private inFlight = 0;

	tree(files: Record<string, string>): string {
		const dirs = new Map<string, Record<string, string>>();
		const entries: TreeEntry[] = [];
		for (const [path, content] of Object.entries(files)) {
			const [head, ...rest] = path.split("/");
			if (rest.length) dirs.set(head, { ...dirs.get(head), [rest.join("/")]: content });
			else entries.push({ name: head, mode: "100644", type: "blob", hash: this.blob(content) });
		}
		for (const [name, sub] of dirs) entries.push({ name, mode: "40000", type: "tree", hash: this.tree(sub) });
		const hash = sha(`tree ${JSON.stringify(entries)}`);
		this.trees.set(hash, entries);
		return hash;
	}

	blob(content: string): string {
		const hash = sha(`blob ${content}`);
		this.blobs.set(hash, content);
		return hash;
	}

	commit(parents: string[], message = "c"): string {
		const hash = sha(`commit ${message} ${parents.join(",")}`);
		this.commits.set(hash, { hash, treeHash: this.tree({}), message, author: { name: "t", email: "t@t" }, parents, committedAt: this.commits.size });
		return hash;
	}

	async readTree(hash: string) {
		this.treeReads++;
		this.maxConcurrentTreeReads = Math.max(this.maxConcurrentTreeReads, ++this.inFlight);
		await new Promise((r) => setTimeout(r, 1));
		this.inFlight--;
		return this.trees.get(hash) ?? null;
	}

	async readBlob(hash: string) {
		const content = this.blobs.get(hash);
		return content === undefined ? null : new Blob([content]);
	}

	async readCommit(hash: string) {
		return this.commits.get(hash) ?? null;
	}
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

test("files whose text is exactly 'binary' or 'large' still get a normal diff", async () => {
	const store = new Store();
	const diff = await diffTrees(store, store.tree({ a: "x\n", b: "y\n" }), store.tree({ a: "binary", b: "large" }));
	for (const f of diff.files) {
		assert.equal(f.binary, false, f.path);
		assert.equal(f.tooLarge, false, f.path);
		assert.ok(f.hunks.length > 0, f.path);
	}
});

test("the line budget holds across files diffed in parallel", async () => {
	const store = new Store();
	const big = (c: string) => `${c}\n`.repeat(4_000);
	const before: Record<string, string> = {};
	const after: Record<string, string> = {};
	for (let i = 0; i < 12; i++) {
		before[`f${i}`] = big("a");
		after[`f${i}`] = big("b");
	}
	const diff = await diffTrees(store, store.tree(before), store.tree(after));
	const lines = diff.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
	assert.ok(lines <= 20_000, `${lines} lines`);
	assert.ok(diff.files.some((f) => f.tooLarge));
});

test("a huge tree stops at the file cap and reads trees with bounded concurrency", async () => {
	const store = new Store();
	const after: Record<string, string> = {};
	for (let d = 0; d < 100; d++) for (let f = 0; f < 10; f++) after[`d${d}/f${f}`] = `${d}.${f}`;
	const diff = await diffTrees(store, null, store.tree(after));
	assert.equal(diff.files.length, 300);
	assert.equal(diff.truncated, true);
	assert.ok(store.maxConcurrentTreeReads <= 8, `${store.maxConcurrentTreeReads} concurrent reads`);
});

test("walkToMainline stops at the default branch and counts what the branch adds", async () => {
	const store = new Store();
	const a = store.commit([], "a");
	const b = store.commit([a], "b");
	const c = store.commit([b], "c");
	const x = store.commit([b], "x");
	const y = store.commit([x], "y");
	const walk = await walkToMainline(store, y, [c, b, a]);
	assert.equal(walk.mergeBase, b);
	assert.equal(walk.behind, 1);
	assert.deepEqual(walk.commits.map((k) => k.message).sort(), ["x", "y"]);
});

test("cancelling an archive mid-read disposes it once and leaves no unhandled rejection", async () => {
	const store = new Store();
	let disposed = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const slow: ObjectReader = {
		...store,
		readTree: (h) => store.readTree(h),
		readCommit: (h) => store.readCommit(h),
		async readBlob(hash) {
			await gate;
			if (hash === "bad") throw new Error("read failed");
			return new Blob(["data"]);
		},
	};
	const files = [
		{ path: "a", hash: "ok", type: "blob" as const },
		{ path: "b", hash: "bad", type: "blob" as const },
	];
	const unhandled: unknown[] = [];
	const onUnhandled = (e: unknown) => unhandled.push(e);
	process.on("unhandledRejection", onUnhandled);
	const stream = archiveStream(slow, files, { format: "zip", root: "r", mtime: 0, onDone: () => disposed++ });
	const reader = stream.getReader();
	const pending = reader.read();
	await new Promise((r) => setTimeout(r, 5));
	await reader.cancel();
	release();
	await pending.catch(() => {});
	await new Promise((r) => setTimeout(r, 20));
	process.off("unhandledRejection", onUnhandled);
	assert.equal(disposed, 1);
	assert.deepEqual(unhandled, []);
});

test("branch deletion needs an explicit ok from the server", async () => {
	const remote = { url: "https://git.invalid/r.git", token: "art_v1_x?expires=1" };
	const real = globalThis.fetch;
	const reply = (body: string) => {
		globalThis.fetch = async () => new Response(body);
	};
	const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
	try {
		reply("everything is fine");
		await assert.rejects(deleteBranch(remote, "x", "a".repeat(40)));
		reply("");
		await assert.rejects(deleteBranch(remote, "x", "a".repeat(40)));
		reply(`${pkt("unpack ok\n")}${pkt("ng refs/heads/x stale info\n")}0000`);
		await assert.rejects(deleteBranch(remote, "x", "a".repeat(40)), /stale info/);
		reply(`${pkt("unpack ok\n")}${pkt("ok refs/heads/x\n")}0000`);
		await deleteBranch(remote, "x", "a".repeat(40));
	} finally {
		globalThis.fetch = real;
	}
});

test("trees that share subtrees can't blow up a diff or an archive listing", async () => {
	// Eight tiny trees, each holding its child four times over: 4^8 directories (65,536) on paper.
	const store = new Store();
	let child = store.tree({ "leaf.txt": "x" });
	for (let depth = 0; depth < 8; depth++) {
		const entries: TreeEntry[] = ["a", "b", "c", "d"].map((name) => ({ name, mode: "40000", type: "tree", hash: child }));
		child = `t${depth}`;
		store.trees.set(child, entries);
	}
	const diff = await diffTrees(store, null, child);
	assert.ok(diff.truncated);
	assert.ok(store.treeReads <= 2_000, `${store.treeReads} tree reads`);
	assert.ok(store.maxConcurrentTreeReads <= 8);

	store.treeReads = 0;
	store.maxConcurrentTreeReads = 0;
	await assert.rejects(listFiles(store, child), /More than/);
	assert.ok(store.treeReads <= 9, `each distinct tree is read once, not ${store.treeReads} times`);
	assert.ok(store.maxConcurrentTreeReads <= 8);
});
