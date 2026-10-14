import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import webHttp from "isomorphic-git/http/web";
import { Workspace } from "../src/git/workspace.ts";
import { authUrl, localArtifacts, sh } from "./helpers.ts";

const bot = { name: "maggot", email: "bot@maggot.dev" };
let artifacts: Awaited<ReturnType<typeof localArtifacts>>;
let main: { url: string; token: string };

before(async () => {
	artifacts = await localArtifacts();
	const created = await artifacts.call("POST", "/repos", { name: "proj" });
	main = { url: created.remote, token: created.token };
	await new Workspace("main", bot).seed(
		main,
		{ "README.md": "# proj\n\nline one\n", "src/a.ts": "export const a = 1;\n" },
		"Initial commit",
	);
});

after(() => artifacts.close());

/** Forks the project, clones the fork with the git CLI, applies edits, commits and pushes. */
async function agentChange(name: string, files: Record<string, string>) {
	const fork = await artifacts.call("POST", "/repos/proj/fork", { name });
	const dir = join(artifacts.root, name);
	await sh("git", ["clone", "--quiet", authUrl(fork.remote, fork.token), dir]);
	for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
	await sh("git", ["add", "-A"], dir);
	await sh("git", ["commit", "--quiet", "-m", `${name} change`], dir);
	await sh("git", ["push", "--quiet", "origin", "HEAD:main"], dir);
	return { url: fork.remote, token: fork.token };
}

async function mainFile(path: string) {
	const { content } = await artifacts.call<{ content: string }>("GET", `/repos/proj/file?ref=main&path=${path}`);
	return Buffer.from(content, "base64").toString();
}

test("merges concurrent non-overlapping tasks, fast-forward then true merge", async () => {
	const a = await agentChange("proj--a", { "a.txt": "from a\n" });
	const b = await agentChange("proj--b", { "b.txt": "from b\n" });
	const ws = new Workspace("main", bot);

	await ws.syncBase(main);
	const first = await ws.merge(await ws.fetchTask(a, "main"), "Merge a", bot);
	assert.equal(first.kind, "merged");
	assert.ok(first.kind === "merged" && first.fastForward);
	assert.deepEqual(first.kind === "merged" && first.changedFiles, ["a.txt"]);
	assert.equal(await ws.push(main), true);

	await ws.syncBase(main);
	const second = await ws.merge(await ws.fetchTask(b, "main"), "Merge b", bot);
	assert.equal(second.kind, "merged");
	assert.ok(second.kind === "merged" && !second.fastForward);
	assert.deepEqual(second.kind === "merged" && second.changedFiles, ["b.txt"]);
	assert.equal(await ws.push(main), true);

	assert.equal(await mainFile("a.txt"), "from a\n");
	assert.equal(await mainFile("b.txt"), "from b\n");
	const log = await artifacts.call<{ parents: string[] }[]>("GET", "/repos/proj/log?ref=main&limit=1");
	assert.equal(log[0].parents.length, 2);
});

test("reports conflicts without touching the default branch", async () => {
	const c = await agentChange("proj--c", { "README.md": "# proj\n\nline one from c\n" });
	const d = await agentChange("proj--d", { "README.md": "# proj\n\nline one from d\n", "d.txt": "d\n" });
	const ws = new Workspace("main", bot);

	await ws.syncBase(main);
	assert.equal((await ws.merge(await ws.fetchTask(c, "main"), "Merge c", bot)).kind, "merged");
	assert.equal(await ws.push(main), true);
	const headBefore = (await artifacts.call<{ hash: string }[]>("GET", "/repos/proj/log?ref=main&limit=1"))[0].hash;

	await ws.syncBase(main);
	const outcome = await ws.merge(await ws.fetchTask(d, "main"), "Merge d", bot);
	assert.equal(outcome.kind, "conflict");
	assert.deepEqual(outcome.kind === "conflict" && outcome.files, ["README.md"]);
	assert.deepEqual(outcome.kind === "conflict" && outcome.changedFiles, ["README.md", "d.txt"]);

	const headAfter = (await artifacts.call<{ hash: string }[]>("GET", "/repos/proj/log?ref=main&limit=1"))[0].hash;
	assert.equal(headAfter, headBefore);
	assert.equal(await mainFile("README.md"), "# proj\n\nline one from c\n");
});

test("a stale workspace detects that the remote moved and recovers on resync", async () => {
	const stale = new Workspace("main", bot);
	await stale.syncBase(main);
	const e = await agentChange("proj--e", { "e.txt": "e\n" });
	const f = await agentChange("proj--f", { "f.txt": "f\n" });

	const other = new Workspace("main", bot);
	await other.syncBase(main);
	await other.merge(await other.fetchTask(e, "main"), "Merge e", bot);
	assert.equal(await other.push(main), true);

	await stale.merge(await stale.fetchTask(f, "main"), "Merge f", bot);
	assert.equal(await stale.push(main), false, "push from an outdated base must be rejected");

	await stale.syncBase(main);
	assert.equal((await stale.merge(await stale.fetchTask(f, "main"), "Merge f", bot)).kind, "merged");
	assert.equal(await stale.push(main), true);
	assert.equal(await mainFile("e.txt"), "e\n");
	assert.equal(await mainFile("f.txt"), "f\n");
});

test("read tokens cannot push", async () => {
	const token = await artifacts.call<{ plaintext: string }>("POST", "/repos/proj/tokens", { scope: "read" });
	const dir = join(artifacts.root, "readonly");
	await sh("git", ["clone", "--quiet", authUrl(main.url, token.plaintext), dir]);
	await writeFile(join(dir, "x.txt"), "x\n");
	await sh("git", ["add", "-A"], dir);
	await sh("git", ["commit", "--quiet", "-m", "x"], dir);
	await assert.rejects(sh("git", ["push", "--quiet", "origin", "HEAD:main"], dir));
});

/**
 * A repository with `count` commits on main, also cloned with the git CLI into `dir` for making branches
 * off old commits: a workspace fetches only the last few dozen commits, so merging those needs more.
 */
async function deepRepo(name: string, count: number) {
	const created = await artifacts.call("POST", "/repos", { name });
	const remote = { url: created.remote, token: created.token };
	const dir = join(artifacts.root, `${name}-clone`);
	await sh("git", ["init", "--quiet", "-b", "main", dir]);
	await sh("bash", ["-c", `for i in $(seq 1 ${count}); do echo "line $i" >> history.txt; git add history.txt; git commit --quiet -m "commit $i"; done`], dir);
	await sh("git", ["push", "--quiet", authUrl(remote.url, remote.token), "main"], dir);
	return { remote, dir };
}

test("merges a fork's branch that started long before the fetched history, and pushes all of it", async () => {
	const { remote, dir } = await deepRepo("deep", 150);
	// Off commit 30 of 150, far behind a shallow fetch of main, with more commits of its own than one fetches.
	await sh("git", ["checkout", "--quiet", "-b", "long", "main~120"], dir);
	await sh("bash", ["-c", `for i in $(seq 1 70); do echo "branch $i" >> branch.txt; git add branch.txt; git commit --quiet -m "branch $i"; done`], dir);
	// The branch is in a fork, so the merge's push has to carry all 70 of its commits.
	const fork = await artifacts.call("POST", "/repos/deep/fork", { name: "deep--fork" });
	await sh("git", ["push", "--quiet", authUrl(fork.remote, fork.token), "long"], dir);

	const ws = new Workspace("main", bot);
	await ws.syncBase(remote);
	const theirs = await ws.fetchTask({ url: fork.remote, token: fork.token }, "long");
	const outcome = await ws.merge(theirs, "Merge long", bot, "merge-commit");
	assert.equal(outcome.kind, "merged");
	assert.deepEqual(outcome.kind === "merged" && outcome.changedFiles, ["branch.txt"]);
	assert.equal(await ws.push(remote), true);

	// A full clone of the result is intact and has both histories, joined at the real merge base.
	const check = join(artifacts.root, "deep-check");
	await sh("git", ["clone", "--quiet", authUrl(remote.url, remote.token), check]);
	await sh("git", ["fsck", "--full", "--strict"], check);
	assert.equal(await sh("git", ["rev-list", "--count", "HEAD"], check), String(150 + 70 + 1));
	assert.equal(await sh("git", ["merge-base", "HEAD^1", "HEAD^2"], check), await sh("git", ["rev-parse", "main~120"], dir));
});

test("finds the real merge base behind the shallow cut, so an old branch merges cleanly", async () => {
	const { remote, dir } = await deepRepo("deep2", 120);
	// Main changed history.txt 110 times since this branch started; without the real merge base that
	// would look like unrelated histories. The branch only adds a file.
	await sh("git", ["checkout", "--quiet", "-b", "old", "main~110"], dir);
	await writeFile(join(dir, "old.txt"), "old\n");
	await sh("git", ["add", "old.txt"], dir);
	await sh("git", ["commit", "--quiet", "-m", "old change"], dir);
	await sh("git", ["push", "--quiet", authUrl(remote.url, remote.token), "old"], dir);

	const ws = new Workspace("main", bot);
	await ws.syncBase(remote);
	const outcome = await ws.merge(await ws.fetchTask(remote, "old"), "Merge old", bot, "squash");
	assert.equal(outcome.kind, "merged");
	assert.deepEqual(outcome.kind === "merged" && outcome.changedFiles, ["old.txt"]);
	assert.equal(await ws.push(remote), true);
	const check = join(artifacts.root, "deep2-check");
	await sh("git", ["clone", "--quiet", authUrl(remote.url, remote.token), check]);
	await sh("git", ["fsck", "--full", "--strict"], check);
	assert.equal(await sh("git", ["show", "HEAD:old.txt"], check), "old");
	assert.equal((await sh("git", ["show", "HEAD:history.txt"], check)).split("\n").length, 120);
});

/** Pushes `count` commits on a new `branch` off `start`, each appending to `file`. */
async function branchOff(dir: string, remote: { url: string; token: string }, branch: string, start: string, file: string, count: number) {
	await sh("git", ["checkout", "--quiet", "-b", branch, start], dir);
	await sh("bash", ["-c", `for i in $(seq 1 ${count}); do echo "${branch} $i" >> ${file}; git add ${file}; git commit --quiet -m "${branch} $i"; done`], dir);
	await sh("git", ["push", "--quiet", authUrl(remote.url, remote.token), branch], dir);
	await sh("git", ["checkout", "--quiet", "main"], dir);
}

/** A full clone of `remote` that git itself finds intact. */
async function checkedClone(remote: { url: string; token: string }, name: string) {
	const check = join(artifacts.root, name);
	await sh("git", ["clone", "--quiet", authUrl(remote.url, remote.token), check]);
	await sh("git", ["fsck", "--full", "--strict"], check);
	return check;
}

test("a shallow workspace whose server stops taking shallow fetches starts over with a full clone", async () => {
	const { remote, dir } = await deepRepo("deep3", 150);
	await branchOff(dir, remote, "late", "main~120", "late.txt", 70);
	// Hides the server's "shallow" capability once `hide` is set, as a server that stopped supporting it.
	let hide = false;
	const http = {
		async request(req: Parameters<typeof webHttp.request>[0]) {
			const res = await webHttp.request(req);
			if (!hide || !req.url.includes("/info/refs")) return res;
			const chunks: Uint8Array[] = [];
			for await (const chunk of res.body ?? []) chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("latin1").replace(/ shallow(?= |\n|\0)/g, " xhallow");
			return { ...res, body: (async function* () { yield Buffer.from(text, "latin1"); })() };
		},
	};
	const ws = new Workspace("main", bot, http);
	await ws.syncBase(remote);
	hide = true;
	const outcome = await ws.merge(await ws.fetchTask(remote, "late"), "Merge late", bot, "merge-commit");
	assert.equal(outcome.kind, "merged");
	assert.deepEqual(outcome.kind === "merged" && outcome.changedFiles, ["late.txt"]);
	assert.equal(await ws.push(remote), true);
	const check = await checkedClone(remote, "deep3-check");
	assert.equal(await sh("git", ["rev-list", "--count", "HEAD"], check), String(150 + 70 + 1));
	assert.equal(await sh("git", ["merge-base", "HEAD^1", "HEAD^2"], check), await sh("git", ["rev-parse", "main~120"], dir));
});

test("a workspace kept between merges syncs again and still deepens for an old branch", async () => {
	const { remote, dir } = await deepRepo("deep4", 120);
	await branchOff(dir, remote, "recent", "main~2", "recent.txt", 1);
	await branchOff(dir, remote, "ancient", "main~100", "ancient.txt", 3);
	const ws = new Workspace("main", bot);
	await ws.syncBase(remote);
	assert.equal((await ws.merge(await ws.fetchTask(remote, "recent"), "Merge recent", bot, "merge-commit")).kind, "merged");
	assert.equal(await ws.push(remote), true);

	// Main moves on elsewhere too; the second sync fetches just what's new.
	await sh("git", ["fetch", "--quiet", authUrl(remote.url, remote.token), "main"], dir);
	await sh("git", ["merge", "--quiet", "--ff-only", "FETCH_HEAD"], dir);
	await sh("bash", ["-c", `for i in 1 2 3; do echo "more $i" >> more.txt; git add more.txt; git commit --quiet -m "more $i"; done`], dir);
	await sh("git", ["push", "--quiet", authUrl(remote.url, remote.token), "main"], dir);

	const head = await ws.syncBase(remote);
	assert.equal(head, await sh("git", ["rev-parse", "main"], dir));
	const outcome = await ws.merge(await ws.fetchTask(remote, "ancient"), "Merge ancient", bot, "merge-commit");
	assert.equal(outcome.kind, "merged");
	assert.deepEqual(outcome.kind === "merged" && outcome.changedFiles, ["ancient.txt"]);
	assert.equal(await ws.push(remote), true);
	const check = await checkedClone(remote, "deep4-check");
	assert.equal(await sh("git", ["merge-base", "HEAD^1", "HEAD^2"], check), await sh("git", ["rev-parse", "main~104"], dir));
	assert.equal(await sh("git", ["show", "HEAD:more.txt"], check), "more 1\nmore 2\nmore 3");
});

test("a conflict with changes from behind the shallow cut is reported, and nothing is pushed", async () => {
	const { remote, dir } = await deepRepo("deep5", 120);
	// Appends to history.txt right where main went on appending 110 more lines.
	await branchOff(dir, remote, "clash", "main~110", "history.txt", 1);
	const before = await sh("git", ["rev-parse", "main"], dir);
	const ws = new Workspace("main", bot);
	await ws.syncBase(remote);
	const outcome = await ws.merge(await ws.fetchTask(remote, "clash"), "Merge clash", bot, "merge-commit");
	assert.equal(outcome.kind, "conflict");
	assert.deepEqual(outcome.kind === "conflict" && outcome.files, ["history.txt"]);
	assert.deepEqual(outcome.kind === "conflict" && outcome.changedFiles, ["history.txt"]);
	const log = await artifacts.call<{ hash: string }[]>("GET", "/repos/deep5/log?ref=main&limit=1");
	assert.equal(log[0].hash, before);
});
