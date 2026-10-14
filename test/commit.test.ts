// The web editor's commit builder against a real bare repository, through `git receive-pack`, with
// the receiving side checking every object (receive.fsckObjects).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { commitChanges, NoChanges, PathError, type FileChange } from "../src/git/commit.ts";
import type { ObjectReader, TreeEntry } from "../src/git/diff.ts";
import { RefUpdateRejected } from "../src/git/protocol.ts";

const exec = promisify(execFile);
let root = "";
let bare = "";
let server: Server;
let remote = { url: "", token: "x" };
const packs: Buffer[] = [];
const git = async (args: string[], cwd = bare) => (await exec("git", args, { cwd, maxBuffer: 64 << 20 })).stdout;

/** Reads trees straight from the bare repository, as the Artifacts binding would. */
const repo: ObjectReader = {
	async readTree(hash) {
		const out = await git(["ls-tree", "-z", hash]);
		return out
			.split("\0")
			.filter(Boolean)
			.map((line): TreeEntry => {
				const [meta, name] = line.split("\t");
				const [mode, , h] = meta.split(" ");
				const type = mode === "040000" ? "tree" : mode === "100755" ? "exec" : mode === "120000" ? "symlink" : mode === "160000" ? "gitlink" : "blob";
				return { name, mode: mode.replace(/^0+/, ""), hash: h, type };
			});
	},
	readBlob: async () => null,
	readCommit: async () => null,
};

before(async () => {
	root = await mkdtemp(join(tmpdir(), "maggot-commit-"));
	bare = join(root, "bare.git");
	const work = join(root, "work");
	await git(["init", "-q", "--bare", "-b", "master", bare], root);
	await git(["config", "receive.fsckObjects", "true"]);
	await git(["clone", "-q", bare, work], root);
	// Names that sort differently as files and as directories ("a" sorts as "a/").
	for (const [path, content] of Object.entries({ "a-b": "1\n", "a.txt": "2\n", a0: "3\n", "a/x": "4\n", "a/y/z": "5\n", "run.sh": "#!/bin/sh\n", "dir/only": "o\n" })) {
		await mkdir(join(work, path, ".."), { recursive: true });
		await writeFile(join(work, path), content);
	}
	await exec("ln", ["-s", "a.txt", join(work, "link")]);
	await git(["add", "-A"], work);
	await git(["update-index", "--chmod=+x", "run.sh"], work);
	await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], work);
	await git(["push", "-q", "origin", "master"], work);

	server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks);
		packs.push(body.subarray(body.indexOf("0000") + 4));
		const child = execFile("git", ["receive-pack", "--stateless-rpc", bare], { encoding: "buffer", maxBuffer: 64 << 20 }, (_err, stdout) => {
			res.setHeader("content-type", "application/x-git-receive-pack-result");
			res.end(stdout);
		});
		child.stdin?.end(body);
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	remote = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "x?expires=1" };
});

after(async () => {
	server.close();
	await rm(root, { recursive: true, force: true });
});

const text = (s: string) => new TextEncoder().encode(s);

async function head(branch = "master") {
	const hash = (await git(["rev-parse", `refs/heads/${branch}`])).trim();
	return { hash, treeHash: (await git(["rev-parse", `${hash}^{tree}`])).trim() };
}

async function commit(changes: FileChange[], opts: { branch?: string; create?: boolean; parent?: { hash: string; treeHash: string } } = {}) {
	const result = await commitChanges(repo, remote, {
		branch: opts.branch ?? "master",
		parent: opts.parent ?? (await head()),
		create: opts.create ?? false,
		changes,
		message: "web edit",
		author: { name: "Web", email: "web@example.com" },
		time: 1_700_000_000,
		maxPackBytes: 10 << 20,
	});
	await git(["fsck", "--strict", "--no-dangling"]);
	return result;
}

const mode = async (path: string) => (await git(["ls-tree", "HEAD", path])).split(" ")[0];

test("trees keep git's order, modes and pruning; packs hold each object once", async () => {
	const big = "x".repeat(70_000); // a size header longer than two bytes
	await commit([
		{ path: "a/new", content: text("same\n") },
		{ path: "a-c", content: text("same\n") },
		{ path: "run.sh", content: text("#!/bin/sh\necho hi\n") },
		{ path: "dir/only", content: null },
		{ path: "big.txt", content: text(big) },
	]);
	assert.equal(await mode("run.sh"), "100755", "an edited executable stays executable");
	assert.equal((await git(["ls-tree", "HEAD", "dir"])).trim(), "", "a directory left empty disappears");
	assert.equal((await git(["show", "HEAD:big.txt"])).length, big.length);
	const packFile = join(root, "last.pack");
	await writeFile(packFile, packs.at(-1) as Buffer);
	await git(["index-pack", "--strict", packFile]); // refuses an object that appears twice (run in the repository, which has what the pack refers to)
});

test("renames keep the mode but can't overwrite; links, no-ops and stale parents are refused", async () => {
	await commit([{ path: "run.sh", content: null }, { path: "bin/run.sh", content: text("#!/bin/sh\n"), executable: true, create: true }]);
	assert.equal(await mode("bin/run.sh"), "100755");
	await assert.rejects(commit([{ path: "a.txt", content: text("x"), create: true }]), PathError);
	await assert.rejects(commit([{ path: "link", content: text("elsewhere") }]), PathError);
	await assert.rejects(commit([{ path: "a.txt", content: text("2\n") }]), NoChanges);
	const stale = await head();
	await commit([{ path: "a.txt", content: text("changed\n") }]);
	await assert.rejects(commit([{ path: "a0", content: text("late\n") }], { parent: stale }), RefUpdateRejected);
});

test("a new branch starts from its parent and leaves the old one alone", async () => {
	const before = await head();
	await commit([{ path: "topic.txt", content: text("t\n") }], { branch: "topic", create: true, parent: before });
	assert.equal((await head()).hash, before.hash);
	assert.equal((await git(["show", "topic:topic.txt"])).trim(), "t");
	await assert.rejects(commit([{ path: "again.txt", content: text("t\n") }], { branch: "topic", create: true, parent: before }), RefUpdateRejected);
});
