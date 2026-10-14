#!/usr/bin/env node
// QA against real repositories: mirrors small public GitHub repositories into maggot with plain git,
// the way someone moving from GitHub would, then checks that nothing was lost and that the website
// and API agree with git.
//
//   MAGGOT_URL=http://127.0.0.1:8787 node scripts/qa-github.ts            # signs up a throwaway QA user
//   MAGGOT_URL=https://… MAGGOT_USER=me MAGGOT_TOKEN=maggot_pat_… node scripts/qa-github.ts
//
// For each repository it:
//   1. clones it from GitHub (all branches and tags) and creates a maggot repository
//   2. pushes every branch and tag with `git push` over HTTPS, a personal access token as the password
//   3. compares every ref on maggot with GitHub's
//   4. clones it back from maggot (anonymously when public; private must refuse that) and runs git fsck
//   5. checks the API: history, root tree, branch list, the README, a raw file, and a zip archive
// One more repository goes through "Import from URL" instead of a push. All QA repositories are deleted
// afterwards unless KEEP=1.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BASE = (process.env.MAGGOT_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const KEEP = process.env.KEEP === "1";

interface Case {
	github: string;
	visibility: "public" | "private";
	/** Create the maggot repository with "Import from URL" instead of pushing to it. */
	importUrl?: boolean;
}

const CASES: Case[] = [
	{ github: "octocat/Hello-World", visibility: "public" },
	{ github: "octocat/Spoon-Knife", visibility: "private" },
	{ github: "sindresorhus/slugify", visibility: "public" },
	{ github: "pallets/markupsafe", visibility: "public" },
	{ github: "github/gitignore", visibility: "private" },
	{ github: "octocat/git-consortium", visibility: "public", importUrl: true },
];

let token = process.env.MAGGOT_TOKEN ?? "";
let user = process.env.MAGGOT_USER ?? "";
const results: { repo: string; checks: string[]; failures: string[]; seconds: number }[] = [];

async function api<T>(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: T; res: Response }> {
	const res = await fetch(`${BASE}/api${path}`, {
		method,
		headers: { "content-type": "application/json", ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json: T;
	try {
		json = JSON.parse(text) as T;
	} catch {
		json = text as T;
	}
	return { status: res.status, json, res };
}

async function git(args: string[], cwd?: string) {
	const { stdout } = await exec("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	return stdout.trim();
}

/** Branch and tag refs, as "oid ref" lines, sorted. Peeled tag lines (^{}) are left out. */
async function refs(remote: string): Promise<string[]> {
	const out = await git(["ls-remote", "--heads", "--tags", remote]);
	return out
		.split("\n")
		.filter((l) => l && !l.endsWith("^{}"))
		.map((l) => l.replace("\t", " "))
		.sort();
}

function authed(url: string) {
	const u = new URL(url);
	u.username = user;
	u.password = token;
	return u.toString();
}

async function signUpQaUser() {
	const name = `qa${Date.now().toString(36)}`;
	const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: BASE },
		body: JSON.stringify({ email: `${name}@qa.maggot.invalid`, password: `qa-${crypto.randomUUID()}`, name: "QA", username: name }),
	});
	if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);
	const cookie = (signUp.headers.getSetCookie?.() ?? [signUp.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
	const created = await fetch(`${BASE}/api/tokens`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie, origin: BASE },
		body: JSON.stringify({ name: "qa" }),
	});
	if (!created.ok) throw new Error(`token failed: ${created.status} ${await created.text()}`);
	token = ((await created.json()) as { token: string }).token;
	user = name;
}

async function runCase(c: Case, work: string) {
	const started = Date.now();
	const name = `${c.github.split("/")[1].toLowerCase()}-qa`;
	const checks: string[] = [];
	const failures: string[] = [];
	const check = (ok: boolean, label: string, detail = "") => (ok ? checks : failures).push(detail ? `${label}: ${detail}` : label);
	const source = `https://github.com/${c.github}.git`;
	const mirror = join(work, `${name}.git`);

	await git(["clone", "--bare", "--quiet", source, mirror]);
	const defaultBranch = (await git(["symbolic-ref", "--short", "HEAD"], mirror)).trim();
	const githubRefs = await refs(source);

	const create = await api<{ repo?: { cloneUrl: string; defaultBranch: string }; error?: { message: string } }>("POST", "/repos", {
		name,
		description: `QA copy of github.com/${c.github}`,
		visibility: c.visibility,
		defaultBranch,
		...(c.importUrl ? { importUrl: source } : {}),
	});
	check(create.status === 201, "create repository", create.status === 201 ? "" : `${create.status} ${create.json.error?.message}`);
	if (!create.json.repo) return void results.push({ repo: c.github, checks, failures, seconds: (Date.now() - started) / 1000 });
	const cloneUrl = create.json.repo.cloneUrl;

	if (!c.importUrl) {
		// What someone moving from GitHub runs: add origin as a remote, push everything.
		await git(["push", "--quiet", "--all", authed(cloneUrl)], mirror);
		await git(["push", "--quiet", "--tags", authed(cloneUrl)], mirror);
		check(true, `git push --all/--tags (${githubRefs.length} refs)`);
	}

	const maggotRefs = await refs(authed(cloneUrl));
	// Imports bring the default branch only, the way Artifacts imports work.
	const expected = c.importUrl ? githubRefs.filter((r) => r.endsWith(`refs/heads/${defaultBranch}`)) : githubRefs;
	const missing = expected.filter((r) => !maggotRefs.includes(r));
	check(missing.length === 0, "every branch and tag matches GitHub", missing.length ? `${missing.length} differ, e.g. ${missing[0]}` : `${expected.length} refs`);

	// Anonymous access: public clones work, private ones must be refused.
	const anon = join(work, `${name}-anon`);
	const anonClone = await git(["clone", "--quiet", cloneUrl, anon]).then(
		() => true,
		() => false,
	);
	check(anonClone === (c.visibility === "public"), `anonymous clone ${c.visibility === "public" ? "works" : "is refused"}`);

	const back = join(work, `${name}-back`);
	await git(["clone", "--quiet", authed(cloneUrl), back]);
	const fsck = await git(["fsck", "--full", "--no-dangling"], back).then(
		() => "",
		(e: Error) => e.message,
	);
	check(fsck === "", "clone back from maggot passes git fsck", fsck.slice(0, 200));
	const head = await git(["rev-parse", "HEAD"], back);
	const githubHead = await git(["rev-parse", defaultBranch], mirror);
	check(head === githubHead, `checked-out ${defaultBranch} matches GitHub`, head.slice(0, 7));
	const commitCount = Number(await git(["rev-list", "--count", "HEAD"], back));
	const githubCount = Number(await git(["rev-list", "--count", defaultBranch], mirror));
	check(commitCount === githubCount, "full history", `${commitCount} commits`);

	// The website's API agrees with git.
	const path = `/repos/${user}/${name}`;
	const anonView = await api("GET", path, undefined, false);
	check(anonView.status === (c.visibility === "public" ? 200 : 404), `anonymous API view is ${c.visibility === "public" ? "allowed" : "hidden"}`, String(anonView.status));
	const info = await api<{ project: { head: string } }>("GET", path);
	check(info.json.project?.head === githubHead, "API head matches", info.json.project?.head?.slice(0, 7) ?? String(info.status));
	const log = await api<{ commits: { hash: string }[] }>("GET", `${path}/log?limit=200`);
	const firstParent = Number(await git(["rev-list", "--count", "--first-parent", "HEAD"], back));
	check(log.json.commits?.length === Math.min(firstParent, 200), "history page", `${log.json.commits?.length} of ${firstParent} first-parent commits`);
	const tree = await api<{ tree: { entries: { name: string }[] } }>("GET", `${path}/tree`);
	const gitRoot = (await git(["ls-tree", "--name-only", "HEAD"], back)).split("\n").filter(Boolean).sort();
	const apiRoot = (tree.json.tree?.entries ?? []).map((e) => e.name).sort();
	check(JSON.stringify(apiRoot) === JSON.stringify(gitRoot), "root tree matches", `${apiRoot.length} entries`);
	const branches = await api<{ branches: { name: string }[] }>("GET", `${path}/branches`);
	const gitBranches = expected.filter((r) => r.includes(" refs/heads/")).length;
	check(branches.json.branches?.length === gitBranches, "branches page", `${branches.json.branches?.length} of ${gitBranches}`);
	const readme = gitRoot.find((n) => /^readme/i.test(n));
	if (readme) {
		const file = await api<string>("GET", `${path}/files/${encodeURIComponent(readme)}`);
		const local = await readFile(join(back, readme), "utf8");
		check(file.status === 200 && file.json === local, `${readme} served byte-for-byte`);
	}
	const firstFile = (await git(["ls-files"], back)).split("\n")[0];
	if (firstFile) {
		const raw = await fetch(`${BASE}/api${path}/raw?path=${encodeURIComponent(firstFile)}`, { headers: { authorization: `Bearer ${token}` } });
		const bytes = Buffer.from(await raw.arrayBuffer());
		check(raw.ok && bytes.equals(await readFile(join(back, firstFile))), "raw file download", firstFile);
	}
	const zip = await fetch(`${BASE}/api${path}/archive?format=zip`, { headers: { authorization: `Bearer ${token}` } });
	if (zip.ok) {
		const zipPath = join(work, `${name}.zip`);
		await writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
		const listing = await exec("unzip", ["-Z1", zipPath], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.split("\n").filter((l) => l && !l.endsWith("/")).length);
		const files = (await git(["ls-files"], back)).split("\n").filter(Boolean).length;
		const submodules = (await git(["ls-files", "--stage"], back)).split("\n").filter((l) => l.startsWith("160000")).length;
		check(listing === files - submodules, "zip archive has every file", `${listing} files`);
	} else {
		check(false, "zip archive", `${zip.status} ${(await zip.text()).slice(0, 120)}`);
	}

	// A follow-up push of new work, as day-to-day use would.
	await git(["-c", "user.name=QA", "-c", "user.email=qa@maggot.invalid", "commit", "--allow-empty", "-q", "-m", "QA follow-up commit"], back);
	await git(["push", "--quiet", "origin", `HEAD:${defaultBranch}`], back);
	const after = await api<{ project: { head: string } }>("GET", path);
	check(after.json.project?.head === (await git(["rev-parse", "HEAD"], back)), "follow-up push lands");

	if (!KEEP) {
		const removed = await api("DELETE", path);
		check(removed.status === 200, "delete repository");
	}
	results.push({ repo: c.github, checks, failures, seconds: (Date.now() - started) / 1000 });
}

const work = await mkdtemp(join(tmpdir(), "maggot-qa-"));
try {
	if (!token) await signUpQaUser();
	if (!user) user = ((await api<{ user: { username: string } }>("GET", "/me")).json.user?.username as string) ?? "";
	console.log(`QA against ${BASE} as ${user}\n`);
	for (const c of CASES) {
		try {
			await runCase(c, work);
		} catch (err) {
			results.push({ repo: c.github, checks: [], failures: [`crashed: ${(err as Error).message.replaceAll(token, "***")}`], seconds: 0 });
		}
		const r = results.at(-1);
		if (r) {
			console.log(`${r.failures.length ? "✖" : "✔"} ${r.repo} (${r.seconds.toFixed(1)}s)`);
			for (const ok of r.checks) console.log(`    ✓ ${ok}`);
			for (const bad of r.failures) console.log(`    ✗ ${bad}`);
		}
	}
} finally {
	await rm(work, { recursive: true, force: true });
}
const failed = results.filter((r) => r.failures.length);
console.log(`\n${results.length - failed.length}/${results.length} repositories passed every check`);
process.exitCode = failed.length ? 1 : 0;
