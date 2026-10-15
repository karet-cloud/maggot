// Streamed diffs: the server's NDJSON (diffStream), the browser's reading of it (readDiff, reduceDiff),
// loading one deferred file (diffPath), and hunk headers as git writes them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { QueryClient } from "@tanstack/query-core";
import { completeDiff, emptyDiff, fileDiffKey, readDiff, reduceDiff, STREAMED, StreamError, type StreamedDiff } from "../app/lib/diff-stream.ts";
import { streamDiff } from "../app/lib/api.ts";
import { diffQuery } from "../app/lib/queries.ts";
import type { DiffEvent } from "../src/api.ts";
import { DEFER_ABOVE, diffList, diffPath, diffStream, diffTrees, type CommitObject, type ObjectReader, type TreeEntry } from "../src/git/diff.ts";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

class Store implements ObjectReader {
	readonly blobs = new Map<string, string>();
	readonly trees = new Map<string, TreeEntry[]>();
	tree(files: Record<string, string>): string {
		const dirs = new Map<string, Record<string, string>>();
		const entries: TreeEntry[] = [];
		for (const [path, content] of Object.entries(files)) {
			const [head, ...rest] = path.split("/");
			if (rest.length) dirs.set(head, { ...dirs.get(head), [rest.join("/")]: content });
			else {
				const hash = sha(`blob ${content}`);
				this.blobs.set(hash, content);
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
		const content = this.blobs.get(hash);
		return content === undefined ? null : new Blob([content]);
	}
	async readCommit(): Promise<CommitObject | null> {
		return null;
	}
}

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n";

/** A byte stream that hands out `text` in pieces of `size` bytes, splitting lines (and characters) anywhere. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(at, at + size));
			at += size;
		},
	});
}

async function collect<M>(body: ReadableStream<Uint8Array>): Promise<{ diff: StreamedDiff<M>; batches: number }> {
	let diff = emptyDiff<M>();
	let batches = 0;
	for await (const batch of readDiff<M>(body)) {
		diff = reduceDiff(diff, batch);
		batches++;
	}
	return { diff, batches };
}

test("hunk headers start at 0 on a side with no lines, as git writes them", async () => {
	const store = new Store();
	const before = store.tree({ "gone.txt": "a\nb\n", "edit.txt": "1\n2\n3\n" });
	const after = store.tree({ "new.txt": "x\ny\n", "edit.txt": "1\n2\n3\n" });
	const diff = await diffTrees(store, before, after);
	const header = (path: string) => {
		const h = diff.files.find((f) => f.path === path)?.hunks[0];
		return h && `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
	};
	assert.equal(header("new.txt"), "@@ -0,0 +1,2 @@");
	assert.equal(header("gone.txt"), "@@ -1,2 +0,0 @@");
	const root = await diffTrees(store, null, store.tree({ "only.txt": "z\n" }));
	assert.equal(root.files[0].hunks[0].oldStart, 0, "a root commit's files are added from nothing too");
	const edited = await diffTrees(store, store.tree({ f: "a\n" }), store.tree({ f: "a\nb\n" }));
	assert.deepEqual(
		[edited.files[0].hunks[0].oldStart, edited.files[0].hunks[0].newStart],
		[1, 1],
		"sides with lines keep their start",
	);
});

test("a streamed diff arrives as the same files as the whole diff, with large and lock files deferred", async () => {
	const store = new Store();
	const base = store.tree({ "a.ts": "one\n", "big.txt": lines(DEFER_ABOVE, "old"), "src/b.ts": "two\n", "gone.md": "bye\n" });
	const head = store.tree({ "a.ts": "one!\n", "big.txt": lines(DEFER_ABOVE, "new"), "src/b.ts": "two\nthree\n", "package-lock.json": "{\n}\n", "new.md": "hi\n" });
	const whole = await diffTrees(store, base, head);
	const list = await diffList(store, base, head);
	const meta = { head: "c2" };
	let disposed = 0;
	const body = diffStream(store, list, { meta, trees: { from: base, to: head } }, () => disposed++);
	const text = await new Response(body).text();
	assert.equal(disposed, 1, "the repository is let go once the stream ends");

	const events = text.trim().split("\n").map((l) => JSON.parse(l) as DiffEvent);
	assert.equal(events[0].type, "header");
	assert.equal(events.at(-1)?.type, "end");
	assert.deepEqual(
		events.filter((e) => e.type === "file").map((e) => e.type === "file" && e.file.path),
		whole.files.map((f) => f.path),
		"files come in the header's order",
	);

	// Read back in awkward pieces (7 bytes: lines and characters split), as a slow network would hand it over.
	const { diff, batches } = await collect<typeof meta>(chunked(text, 7));
	assert.ok(batches > 1, "files are folded in as they arrive, not all at the end");
	assert.equal(diff.done, true);
	assert.deepEqual(diff.meta, meta);
	assert.deepEqual(diff.trees, { from: base, to: head });
	assert.deepEqual(diff.list.map((e) => [e.path, e.status]), whole.files.map((f) => [f.path, f.status]));
	assert.equal(diff.additions, whole.additions);
	assert.equal(diff.deletions, whole.deletions);
	for (const file of whole.files) {
		const streamed = diff.files.get(file.path)!;
		assert.equal(streamed.additions, file.additions, file.path);
		if (file.path === "big.txt") {
			assert.equal(streamed.deferred, "large", "more than DEFER_ABOVE changed lines");
			assert.deepEqual(streamed.hunks, [], "hunks are left for later");
		} else if (file.path === "package-lock.json") {
			assert.equal(streamed.deferred, "generated");
			assert.deepEqual(streamed.hunks, []);
		} else {
			assert.deepEqual(streamed, file, file.path);
		}
	}

	const loaded = await diffPath(store, base, head, "big.txt");
	assert.deepEqual(loaded, whole.files.find((f) => f.path === "big.txt"), "the deferred file loads on its own, hunks and all");
	assert.equal((await diffPath(store, null, head, "new.md"))?.status, "added");
	assert.equal(await diffPath(store, base, head, "nowhere.txt"), null);
	assert.equal(await diffPath(store, base, head, "src"), null, "a directory isn't a file of the diff");
});

test("a file that fails partway ends the stream with an error line, keeping the files before it", async () => {
	const store = new Store();
	const base = store.tree({ "a.txt": "1\n", "b.txt": "2\n", "c.txt": "3\n" });
	const head = store.tree({ "a.txt": "1!\n", "b.txt": "2!\n", "c.txt": "3!\n" });
	const list = await diffList(store, base, head);
	const broken = store.blobs.get(sha("blob 2!\n")) ?? "";
	assert.ok(broken, "b.txt's new blob is in the store");
	const failing: ObjectReader = {
		readTree: (hash) => store.readTree(hash),
		readCommit: () => store.readCommit(),
		readBlob: async (hash) => {
			if (store.blobs.get(hash) === "2!\n") throw new Error("Storage went away");
			return store.readBlob(hash);
		},
	};
	let disposed = 0;
	const text = await new Response(diffStream(failing, list, { meta: null, trees: { from: base, to: head } }, () => disposed++)).text();
	const events = text.trim().split("\n").map((l) => JSON.parse(l) as DiffEvent);
	assert.deepEqual(
		events.map((e) => (e.type === "file" ? e.file.path : e.type)),
		["header", "a.txt", "error"],
		"files up to the failure, then the error; nothing after it",
	);
	assert.equal(disposed, 1);
	let partial = emptyDiff();
	await assert.rejects(async () => {
		for await (const batch of readDiff(chunked(text, 11))) partial = reduceDiff(partial, batch);
	}, /Storage went away/);
	assert.deepEqual([...partial.files.keys()], ["a.txt"], "what arrived before the error is kept for the page");
});

test("a file loaded on its own is fetched again once the diff's trees change, not served from the old ones", async () => {
	const client = new QueryClient();
	const calls: string[] = [];
	const load = (trees: { from: string | null; to: string }) =>
		client.fetchQuery({
			queryKey: fileDiffKey(["project", "o/r", "pulls", 1, "files"], trees, "big.txt"),
			queryFn: () => {
				calls.push(trees.to);
				return trees.to;
			},
			staleTime: Number.POSITIVE_INFINITY,
		});
	assert.equal(await load({ from: "t0", to: "t1" }), "t1");
	assert.equal(await load({ from: "t0", to: "t1" }), "t1");
	assert.deepEqual(calls, ["t1"], "the same trees are the same diff: cached");
	assert.equal(await load({ from: "t0", to: "t2" }), "t2", "a push moved the head: the new trees' file");
	assert.equal(await load({ from: "t9", to: "t2" }), "t2");
	assert.deepEqual(calls, ["t1", "t2", "t2"]);
	client.clear();
});

test("a whole diff takes the streamed shape, complete", async () => {
	const store = new Store();
	const whole = await diffTrees(store, store.tree({ a: "1\n" }), store.tree({ a: "2\n", b: "3\n" }));
	const view = completeDiff(whole);
	assert.equal(view.done, true);
	assert.deepEqual(view.list.map((e) => e.path), ["a", "b"]);
	assert.equal(view.files.get("b"), whole.files[1]);
	assert.equal(view.additions, 2);
});

test("a stream that stops early, or reports an error, fails instead of looking like a short diff", async () => {
	const header: DiffEvent = { type: "header", meta: null, trees: { from: null, to: "t" }, files: [{ path: "a", status: "added", oldMode: null, newMode: "100644" }], truncated: false };
	const cut = `${JSON.stringify(header)}\n`;
	await assert.rejects(collect(chunked(cut, 5)), StreamError);
	const failed = `${cut}${JSON.stringify({ type: "error", message: "Tree x is missing" })}\n`;
	await assert.rejects(collect(chunked(failed, 1000)), /Tree x is missing/);
	// The last line needn't end in a newline.
	const { diff } = await collect(chunked(`${cut}${JSON.stringify({ type: "end", additions: 0, deletions: 0 })}`, 3));
	assert.equal(diff.done, true);
	assert.equal(diff.list.length, 1);
});

test("folding events never changes the diff it was given", () => {
	const start = emptyDiff<null>();
	const header: DiffEvent<null> = { type: "header", meta: null, trees: { from: null, to: "t" }, files: [], truncated: false };
	const after = reduceDiff(start, [header, { type: "file", file: { path: "a", status: "added", oldMode: null, newMode: "100644", additions: 1, deletions: 0, binary: false, tooLarge: false, hunks: [] } }]);
	assert.deepEqual(start, emptyDiff<null>());
	const again = reduceDiff(after, [{ type: "file", file: { path: "b", status: "added", oldMode: null, newMode: "100644", additions: 2, deletions: 0, binary: false, tooLarge: false, hunks: [] } }]);
	assert.deepEqual([...after.files.keys()], ["a"], "an earlier state keeps its files");
	assert.deepEqual([...again.files.keys()], ["a", "b"]);
	assert.equal(again.additions, 3);
});


test("special filenames are absent until received and survive reducer copies and complete diffs", async () => {
	const store = new Store();
	const tree = store.tree({ toString: "one\n", ["__proto__"]: "two\n" });
	const list = await diffList(store, null, tree);
	const events = (await new Response(diffStream(store, list, { meta: null, trees: { from: null, to: tree } })).text())
		.trim().split("\n").map((line) => JSON.parse(line) as DiffEvent<null>);
	let view = reduceDiff(emptyDiff<null>(), [events[0]]);
	assert.deepEqual(view.list.map((entry) => entry.path).sort(), ["__proto__", "toString"]);
	for (const path of ["toString", "__proto__"]) assert.equal(view.files.get(path), undefined, "an inherited member isn't a file");
	const header = view;
	const states = [header];
	for (const event of events.slice(1)) {
		view = reduceDiff(view, [event]);
		states.push(view);
	}
	assert.equal(header.files.size, 0);
	assert.equal(states[1].files.size, 1, "a later batch does not mutate the preceding Map");
	assert.equal(view.files.size, 2);
	assert.equal(view.done, true);
	const whole = completeDiff(await diffTrees(store, null, tree));
	for (const path of ["toString", "__proto__"]) {
		assert.equal(view.files.get(path)?.hunks.length, 1);
		assert.deepEqual(view.files.get(path), whole.files.get(path));
	}
});

test("diff queries carry the browserOnly SSR opt-out and streamDiff refuses a server fetch", async (t) => {
	assert.deepEqual(diffQuery(["diff"], "/projects/o/r/compare").meta, { browserOnly: true });
	assert.deepEqual(STREAMED, { browserOnly: true }, "also used by per-file Load diff queries");
	const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("fetch must not run"); });
	await assert.rejects(streamDiff("/projects/o/r/compare").next(), /browser only/);
	assert.equal(fetch.mock.callCount(), 0);
});
