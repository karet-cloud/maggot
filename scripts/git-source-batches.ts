import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export type SeedAccess = { remote: string; token: string };
const PREFIX = "refs/tags/maggot-seed-";

async function client(repo: string, getAccess: () => Promise<SeedAccess>, env: NodeJS.ProcessEnv) {
	const askpass = join(repo, "maggot-seed-askpass.cjs");
	await writeFile(askpass, '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2].toLowerCase().includes("username") ? "x" : process.env.MAGGOT_PUSH_TOKEN);\n', { mode: 0o700 });
	const git = (args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) => new Promise<string>((resolve, reject) => {
		const child = spawn("git", ["-C", repo, ...args], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
		let out = "", error = "";
		child.stdout.setEncoding("utf8").on("data", (data: string) => { out += data; });
		child.stderr.setEncoding("utf8").on("data", (data: string) => { error += data; });
		const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.stdin.once("error", reject);
		child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`Git ${args[0]} failed: ${error}`)); });
		child.stdin.end(input);
	});
	const network = async (args: (remote: string) => string[]) => {
		const access = await getAccess();
		return git(args(access.remote), undefined, { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", MAGGOT_PUSH_TOKEN: access.token.split("?expires=")[0] });
	};
	const cleanup = async () => {
		const advertised = await network(remote => ["ls-remote", "--refs", remote, `${PREFIX}*`]);
		const refs = advertised.split("\n").filter(Boolean).map(line => line.split("\t")[1]).filter(ref => ref?.startsWith(PREFIX));
		if (refs.length) await network(remote => ["push", "--quiet", remote, ...refs.map(ref => `:${ref}`)]);
	};
	return { git, network, cleanup };
}

/** Upload immutable blobs in small packs, then publish the original upstream commit. */
export async function seedSourceBatches(repo: string, getAccess: () => Promise<SeedAccess>, env: NodeJS.ProcessEnv, maxBatchBytes = 32 * 1024 * 1024) {
	const { git, network, cleanup } = await client(repo, getAccess, env);
	// Recover staging refs from interrupted runs, even when master is already populated.
	await cleanup();
	const listing = await git(["ls-tree", "-r", "-l", "HEAD"]);
	const seen = new Set<string>();
	const batches: string[][] = [];
	let batch: string[] = [], bytes = 0;
	for (const line of listing.split("\n")) {
		const [, type, hash, sizeText] = line.split("\t")[0].trim().split(/\s+/);
		if (type !== "blob" || seen.has(hash)) continue;
		seen.add(hash);
		const size = Number(sizeText);
		if (!Number.isSafeInteger(size) || size < 0 || size > maxBatchBytes) throw new Error("A source blob exceeds the batch limit");
		if (bytes + size > maxBatchBytes && batch.length) { batches.push(batch); batch = []; bytes = 0; }
		batch.push(hash); bytes += size;
	}
	if (batch.length) batches.push(batch);
	const run = randomBytes(6).toString("hex");
	try {
		for (let i = 0; i < batches.length; i++) {
			const tree = await git(["mktree"], batches[i].map((hash, n) => `100644 blob ${hash}\tobject-${String(n).padStart(8, "0")}\n`).join(""));
			const ref = `${PREFIX}${run}-${i}`;
			await git(["update-ref", ref, tree]);
			await network(remote => ["push", "--quiet", remote, `${ref}:${ref}`]);
			console.log(`Uploaded Linux source batch ${i + 1}/${batches.length}`);
		}
		await network(remote => ["push", "--quiet", remote, "master:master"]);
	} finally {
		await cleanup();
	}
}

/** Remove staging refs without cloning Linux again after a successful but interrupted seed. */
export async function cleanupSourceBatches(repo: string, getAccess: () => Promise<SeedAccess>, env: NodeJS.ProcessEnv) {
	await (await client(repo, getAccess, env)).cleanup();
}
