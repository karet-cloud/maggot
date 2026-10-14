import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { seedSourceBatches, cleanupSourceBatches } from "../scripts/git-source-batches.ts";

const exec = promisify(execFile);

test("batched source upload preserves the upstream commit and files, and removes staging refs", async () => {
	const root = await mkdtemp(join(tmpdir(), "git-source-batches-"));
	const source = join(root, "source");
	const target = join(root, "target.git");
	const scratch = join(root, "cleanup.git");
	const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();
	try {
		await mkdir(source);
		await git(source, "init", "-q", "-b", "master");
		const contents: string[] = [];
		for (const [n, file] of ["README", "kernel/demo.c", "drivers/demo.c", "Documentation/demo.rst"].entries()) {
			await mkdir(join(source, file, ".."), { recursive: true });
			contents[n] = `fixture-${n}\n${randomBytes(2048).toString("hex")}\n`;
			await writeFile(join(source, file), contents[n]);
		}
		await git(source, "add", ".");
		await git(source, "commit", "-q", "-m", "Upstream fixture");
		const upstream = await git(source, "rev-parse", "HEAD");
		await exec("git", ["init", "--bare", "-q", "-b", "master", target]);
		await git(target, "config", "receive.unpackLimit", "0");
		const packLog = join(root, "packs.jsonl");
		await writeFile(join(target, "hooks", "pre-receive"), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const refs = fs.readFileSync(0, "utf8").trim().split("\\n").map(line => line.split(" ")[2]);
const dir = process.env.GIT_QUARANTINE_PATH ? path.join(process.env.GIT_QUARANTINE_PATH, "pack") : null;
const bytes = dir ? fs.readdirSync(dir).filter(file => file.endsWith(".pack")).reduce((n, file) => n + fs.statSync(path.join(dir, file)).size, 0) : 0;
fs.appendFileSync(${JSON.stringify(packLog)}, JSON.stringify({ refs, bytes }) + "\\n");
`, { mode: 0o700 });
		const access = async () => ({ remote: target, token: "test-token?expires=123" });
		await seedSourceBatches(source, access, process.env, 5000);
		assert.equal(await git(target, "rev-parse", "master"), upstream);
		assert.equal(await git(target, "tag", "--list", "maggot-seed-*"), "");
		assert.equal(await git(target, "show", "master:kernel/demo.c"), contents[1].trimEnd());
		await git(target, "fsck", "--no-dangling");
		const packs = (await readFile(packLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { refs: string[]; bytes: number });
		const published = packs.find(pack => pack.refs.includes("refs/heads/master"));
		assert.ok(published && published.bytes < 1000, "the final pack contains metadata, not already-staged blobs");
		// A completed push followed by cancellation can leave tree refs; a later run removes them.
		const tree = await git(source, "rev-parse", "HEAD^{tree}");
		await git(source, "update-ref", "refs/tags/maggot-seed-interrupted", tree);
		await git(source, "push", "-q", target, "refs/tags/maggot-seed-interrupted");
		await exec("git", ["init", "--bare", "-q", "-b", "master", scratch]);
		await cleanupSourceBatches(scratch, access, process.env);
		assert.equal(await git(target, "tag", "--list", "maggot-seed-*"), "");
		assert.equal(await git(target, "rev-parse", "master"), upstream);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
