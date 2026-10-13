// Runs the real Worker (vite dev --mode offline) against the local Artifacts stand-in with Artifacts'
// concurrent-fork failures simulated. Slower than the unit tests: npm run test:e2e
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { Branches, Comparison, Diff, GitCredentials, Project, Task, TaskAccess } from "../../src/api.ts";
import { startLocalArtifacts } from "../../scripts/local-artifacts.ts";

let api = "";
// Every test signs up from the same address, so the per-address limits are raised; the ones the
// abuse test checks are small.
const POLICY = {
	requireVerifiedEmail: true,
	signUpsPerHour: 10_000,
	signInsPerIp: 10_000,
	emailsPerHour: 10_000,
	apiPerMinute: 100_000,
	writesPerMinute: 10_000,
	gitPerMinute: 10_000,
	signInsPerAccount: 5,
	authFailuresPerIp: 5,
	reposPerUser: 3,
	repoBytes: 200_000,
};
let artifacts: Awaited<ReturnType<typeof startLocalArtifacts>>;
let worker: ChildProcess;
let workerLog: Awaited<ReturnType<typeof open>>;
let root = "";
// The dev server persists Durable Object state across runs, so every run uses fresh project names.
const run = Date.now().toString(36);
const name = (base: string) => `${base}-${run}`;

function freePort(): Promise<number> {
	return new Promise((ok) => {
		const srv = createServer().listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => ok(port));
		});
	});
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await fetch(`${api}/api${path}`, {
		method,
		headers: { authorization: "Bearer dev", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as T };
}

async function control<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${artifacts.url}/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
	return ((await res.json()) as { result: T }).result;
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== undefined) return value;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("timed out");
}

async function burst(project: string, n: number) {
	return Promise.all(
		Array.from({ length: n }, (_, i) => call<TaskAccess>("POST", `/projects/${project}/tasks`, { title: `burst ${i}` })),
	);
}

async function settledTasks(project: string, n: number): Promise<Task[]> {
	return until(async () => {
		const { json } = await call<{ tasks: Task[] }>("GET", `/projects/${project}/tasks`);
		return json.tasks.length === n && json.tasks.every((t) => t.status !== "provisioning") ? json.tasks : undefined;
	});
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "megit-e2e-"));
	artifacts = await startLocalArtifacts({ root: join(root, "artifacts"), port: 0, quiet: true });
	const port = await freePort();
	// Its own process group, so after() can stop Vite and the workerd processes it starts in one go. Its
	// output goes to a log that is kept when a test fails.
	workerLog = await open(join(tmpdir(), `megit-e2e-${run}.log`), "w");
	worker = spawn("node_modules/.bin/vite", ["dev", "--mode", "offline"], {
		env: { ...process.env, LOCAL_ARTIFACTS_URL: artifacts.url, MEGIT_PORT: String(port), CF_QUIET: "1", MEGIT_POLICY: JSON.stringify(POLICY) },
		stdio: ["ignore", workerLog.fd, workerLog.fd],
		detached: true,
	});
	api = `http://127.0.0.1:${port}`;
	await until(async () => {
		try {
			return (await fetch(api)).ok ? true : undefined;
		} catch {
			return undefined;
		}
	});
});

after(async () => {
	if (worker.pid) process.kill(-worker.pid, "SIGTERM");
	await workerLog.close();
	await artifacts.close();
	await rm(root, { recursive: true, force: true });
});

test("the fork queue keeps a burst under the failure threshold, so no fork fails", async () => {
	await control("POST", "/simulate", { forkDelayMs: 300, forkFailAbove: 2 });
	await call("POST", "/projects", { name: name("burst-throttled") });
	const responses = await burst(name("burst-throttled"), 10);
	assert.ok(responses.every((r) => r.status === 201 || r.status === 202));

	const tasks = await settledTasks(name("burst-throttled"), 10);
	assert.deepEqual(tasks.map((t) => t.status), Array(10).fill("open"));
	assert.ok(tasks.every((t) => t.forkAttempts === 1));
	const stats = await control<{ forkFailures: number; maxConcurrentForks: number }>("GET", "/stats");
	assert.equal(stats.forkFailures, 0);
	assert.ok(stats.maxConcurrentForks <= 2, `max concurrent forks was ${stats.maxConcurrentForks}`);
});

test("failed forks are retried under new names and their half-created names are cleaned up", async () => {
	await control("POST", "/simulate", { forkDelayMs: 300, forkFailAbove: 1 });
	await call("POST", "/projects", { name: name("burst-flaky") });
	await burst(name("burst-flaky"), 6);

	const tasks = await settledTasks(name("burst-flaky"), 6);
	assert.deepEqual(tasks.map((t) => t.status), Array(6).fill("open"));
	const stats = await control<{ forkFailures: number }>("GET", "/stats");
	assert.ok(stats.forkFailures > 0, "simulation should have failed some forks");
	assert.ok(tasks.some((t) => t.forkAttempts > 1));
	await until(async () => ((await control<{ ghosts: string[] }>("GET", "/stats")).ghosts.length === 0 ? true : undefined));
});

test("a fork that is still provisioning returns 202 without credentials, then becomes ready", async () => {
	await control("POST", "/simulate", { forkDelayMs: 3_000 });
	await call("POST", "/projects", { name: name("slow-fork") });
	const created = await call<TaskAccess>("POST", `/projects/${name("slow-fork")}/tasks?wait=0`, { title: "slow" });
	assert.equal(created.status, 202);
	assert.equal(created.json.task.status, "provisioning");
	assert.equal(created.json.fork, null);

	await control("POST", "/simulate", {});
	const ready = await until(async () => {
		const { json } = await call<{ task: Task }>("GET", `/projects/${name("slow-fork")}/tasks/${created.json.task.id}`);
		return json.task.status === "open" ? json.task : undefined;
	});
	const access = await call<TaskAccess>("POST", `/projects/${name("slow-fork")}/tasks/${ready.id}/access`);
	assert.ok(access.json.fork?.token);
	const { json } = await call<{ events: { type: string }[] }>("GET", `/projects/${name("slow-fork")}/events`);
	assert.ok(json.events.some((e) => e.type === "task.ready"));
});

test("a project created without a README accepts an existing repository pushed with plain git", async () => {
	await control("POST", "/simulate", {});
	const project = name("pushed");
	await call("POST", "/projects", { name: project, readme: false });
	const empty = await call<{ project: Project }>("GET", `/projects/${project}`);
	assert.equal(empty.json.project.head, null);
	const early = await call<TaskAccess>("POST", `/projects/${project}/tasks`, { title: "too early" });
	assert.equal(early.status, 409);

	// The commands the dashboard shows, against a repo whose local branch has another name.
	const { json: creds } = await call<GitCredentials>("POST", `/projects/${project}/credentials`, {});
	const url = new URL(creds.remote);
	url.username = "x";
	url.password = creds.token.split("?expires=")[0];
	const dir = join(root, "pushed");
	const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: dir });
	await promisify(execFile)("git", ["init", "-q", "-b", "trunk", dir]);
	await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
	await git("remote", "add", "megit", url.toString());
	await git("branch", "-M", creds.branch);
	await git("push", "-q", "-u", "megit", creds.branch);
	await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "second");
	await git("push", "-q");

	const head = (await git("rev-parse", "HEAD")).stdout.trim();
	const pushed = await call<{ project: Project }>("GET", `/projects/${project}`);
	assert.equal(pushed.json.project.head, head);
	const task = await call<TaskAccess>("POST", `/projects/${project}/tasks`, { title: "after push" });
	assert.equal(task.status, 201);
	assert.equal(task.json.task.baseOid, head);
});

test("branches, task changes, commit diffs, raw files and archives", async () => {
	await control("POST", "/simulate", {});
	const project = name("browse");
	await call("POST", "/projects", { name: project });
	const { json: creds } = await call<GitCredentials>("POST", `/projects/${project}/credentials`, {});
	const url = new URL(creds.remote);
	url.username = "x";
	url.password = creds.token.split("?expires=")[0];
	const dir = join(root, "browse");
	const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
	await promisify(execFile)("git", ["clone", "-q", url.toString(), dir]);
	await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
	await git("add", "-A");
	await git("commit", "-q", "-m", "Add a");
	await git("push", "-q", "origin", creds.branch);
	await git("checkout", "-q", "-b", "feature/x");
	await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n");
	await git("commit", "-q", "-am", "Shout two");
	await git("push", "-q", "origin", "feature/x");
	const featureHead = (await git("rev-parse", "HEAD")).stdout.trim();

	const commit = await call<{ diff: Diff }>("GET", `/projects/${project}/commits/${featureHead}`);
	assert.equal(commit.status, 200);
	assert.deepEqual(commit.json.diff.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [["a.txt", "modified", 1, 1]]);

	const branches = await call<Branches>("GET", `/projects/${project}/branches`);
	const feature = branches.json.branches.find((b) => b.name === "feature/x");
	assert.equal(feature?.ahead, 1);
	assert.equal(feature?.behind, 0);

	const compare = await call<{ comparison: Comparison }>("GET", `/projects/${project}/compare?base=${creds.branch}&head=feature%2Fx`);
	assert.deepEqual(compare.json.comparison.commits.map((c) => c.message), ["Shout two"]);

	const raw = await fetch(`${api}/api/projects/${project}/raw?path=a.txt&ref=feature%2Fx`, { headers: { authorization: "Bearer dev" } });
	assert.equal(await raw.text(), "one\nTWO\nthree\n");
	assert.equal(raw.headers.get("x-content-type-options"), "nosniff");

	const archive = await fetch(`${api}/api/projects/${project}/archive?format=tar.gz&ref=feature%2Fx`, { headers: { authorization: "Bearer dev" } });
	assert.equal(archive.status, 200);
	await writeFile(join(root, "browse.tgz"), new Uint8Array(await archive.arrayBuffer()));
	const listing = await promisify(execFile)("tar", ["tzf", join(root, "browse.tgz")]);
	assert.ok(listing.stdout.includes(`${project}-feature-x/a.txt`));

	const deleted = await call("DELETE", `/projects/${project}/branches/feature/x`);
	assert.equal(deleted.status, 200);
	const remaining = await call<Branches>("GET", `/projects/${project}/branches?counts=0`);
	assert.deepEqual(remaining.json.branches.map((b) => b.name), [creds.branch]);

	// A task's changes are what its fork adds on top of the default branch.
	const task = await call<TaskAccess>("POST", `/projects/${project}/tasks`, { title: "add b" });
	const fork = new URL(task.json.fork?.remote as string);
	fork.username = "x";
	fork.password = (task.json.fork?.token as string).split("?expires=")[0];
	const forkDir = join(root, "browse-fork");
	await promisify(execFile)("git", ["clone", "-q", fork.toString(), forkDir]);
	await writeFile(join(forkDir, "b.txt"), "bee\n");
	const forkGit = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: forkDir });
	await forkGit("add", "-A");
	await forkGit("commit", "-q", "-m", "Add b");
	await forkGit("push", "-q", "origin", creds.branch);
	assert.equal(creds.branch, "master", "new projects default to master");
	const changes = await call<{ comparison: Comparison }>("GET", `/projects/${project}/tasks/${task.json.task.id}/changes`);
	assert.deepEqual(changes.json.comparison.diff.files.map((f) => [f.path, f.status]), [["b.txt", "added"]]);
	assert.deepEqual(changes.json.comparison.commits.map((c) => c.message), ["Add b"]);
});

/** An admin-issued link for a user: a password reset or an email verification. */
async function adminLink(kind: "password-reset" | "verify-email", username: string): Promise<Response> {
	return fetch(`${api}/api/admin/${kind}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer dev" },
		body: JSON.stringify({ username }),
	});
}

/** Signs up a user (verifying their email unless asked not to) and returns its session cookie and a personal access token. */
async function newUser(prefix: string, { verify = true } = {}): Promise<{ username: string; cookie: string; token: string }> {
	const username = `${prefix}${run}`.toLowerCase().slice(0, 39);
	const signUp = await fetch(`${api}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: api },
		body: JSON.stringify({ email: `${username}@test.invalid`, password: "correct-horse-battery", name: username, username }),
	});
	assert.equal(signUp.status, 200, await signUp.clone().text());
	const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	if (verify) {
		const { url } = (await (await adminLink("verify-email", username)).json()) as { url: string };
		const landing = await fetch(url, { redirect: "manual" });
		assert.equal(new URL(landing.headers.get("location") ?? "", api).pathname, "/verify-email");
	}
	const created = await fetch(`${api}/api/tokens`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie, origin: api },
		body: JSON.stringify({ name: "test" }),
	});
	assert.equal(created.status, 201);
	return { username, cookie, token: ((await created.json()) as { token: string }).token };
}

test("people sign up, create public and private repositories, and push and clone them with plain git", async () => {
	const ada = await newUser("ada");
	const bob = await newUser("bob");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers },
		});
	for (const [name, visibility] of [["pub", "public"], ["priv", "private"]]) {
		const res = await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name, visibility }) });
		assert.equal(res.status, 201, await res.clone().text());
	}
	const repoUrl = (repo: string, who?: { username: string; token: string }) => {
		const url = new URL(`${api}/${ada.username}/${repo}.git`);
		if (who) {
			url.username = who.username;
			url.password = who.token;
		}
		return url.toString();
	};
	const exec = promisify(execFile);
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	const git = (args: string[], cwd?: string) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env });
	const dir = join(root, "people");
	await git(["init", "-q", "-b", "master", dir]);
	await writeFile(join(dir, "README.md"), "# hello\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-q", "-m", "first"], dir);
	const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();

	// Pushing needs the owner's token; anonymous and other users are refused.
	await assert.rejects(git(["push", "-q", repoUrl("pub"), "master"], dir), /Authentication|could not read Username/);
	await assert.rejects(git(["push", "-q", repoUrl("pub", bob), "master"], dir), /403/);
	await git(["push", "-q", repoUrl("pub", ada), "master"], dir);
	await git(["push", "-q", repoUrl("priv", ada), "master"], dir);

	// Public: anyone can clone and browse. Private: only the owner; everyone else sees nothing.
	await git(["clone", "-q", repoUrl("pub"), join(root, "pub-anon")]);
	assert.equal((await git(["rev-parse", "HEAD"], join(root, "pub-anon"))).stdout.trim(), head);
	await assert.rejects(git(["clone", "-q", repoUrl("priv"), join(root, "priv-anon")]));
	await assert.rejects(git(["clone", "-q", repoUrl("priv", bob), join(root, "priv-bob")]), /not found/);
	await git(["clone", "-q", repoUrl("priv", ada), join(root, "priv-ada")]);
	assert.equal((await as(null)(`/repos/${ada.username}/pub`)).status, 200);
	assert.equal((await as(null)(`/repos/${ada.username}/priv`)).status, 404);
	assert.equal((await as(bob)(`/repos/${ada.username}/priv`)).status, 404);
	const view = (await (await as(ada)(`/repos/${ada.username}/priv`)).json()) as { project: { head: string; remote: string }; repo: { canWrite: boolean } };
	assert.equal(view.project.head, head);
	assert.equal(view.repo.canWrite, true);
	assert.ok(view.project.remote.startsWith(api), "the storage remote stays internal");
	const listed = (await (await as(null)(`/repos?owner=${ada.username}`)).json()) as { repos: { name: string }[] };
	assert.deepEqual(listed.repos.map((r) => r.name), ["pub"]);

	// Only the owner changes settings; making the repository private hides it.
	assert.equal((await as(bob)(`/repos/${ada.username}/pub`, { method: "PATCH", body: JSON.stringify({ visibility: "private" }) })).status, 403);
	assert.equal((await as(ada)(`/repos/${ada.username}/pub`, { method: "PATCH", body: JSON.stringify({ visibility: "private" }) })).status, 200);
	assert.equal((await as(null)(`/repos/${ada.username}/pub`)).status, 404);

	// A push through megit's URL shows up in the repository's event feed.
	const events = (await (await as(ada)(`/repos/${ada.username}/priv/events`)).json()) as { events: { type: string; data: { to?: string } }[] };
	assert.ok(events.events.some((e) => e.type === "repo.pushed" && e.data.to === head));

	// The admin-only project API doesn't take user tokens.
	assert.equal((await as(ada)("/projects")).status, 401);
});

test("cookie sessions only write from the same origin, and repo files can't run as pages", async () => {
	const ada = await newUser("eve");
	const body = JSON.stringify({ name: "origin" });
	const withCookie = (init: RequestInit) =>
		fetch(`${api}/api/repos`, { method: "POST", body, ...init, headers: { cookie: ada.cookie, "content-type": "application/json", ...init.headers } });
	assert.equal((await withCookie({ headers: { origin: "https://evil.example" } })).status, 403);
	assert.equal((await withCookie({ headers: { origin: api } })).status, 201);
	assert.equal((await fetch(`${api}/api/me`, { headers: { cookie: "megit.session_token=forged" } }).then((r) => r.json()) as { user: unknown }).user, null);

	const file = await fetch(`${api}/api/repos/${ada.username}/origin/tree`, { headers: { authorization: `Bearer ${ada.token}` } });
	assert.equal(file.status, 200);
	const project = name("inert");
	await call("POST", "/projects", { name: project });
	const readme = await fetch(`${api}/api/projects/${project}/files/README.md`, { headers: { authorization: "Bearer dev" } });
	assert.equal(readme.headers.get("content-type"), "text/plain;charset=utf-8");
	assert.equal(readme.headers.get("x-content-type-options"), "nosniff");
	assert.match(readme.headers.get("content-security-policy") ?? "", /sandbox/);

	const events = await call<{ events: unknown[] }>("GET", `/projects/${project}/events?limit=-1`);
	assert.equal(events.status, 200);
	assert.ok(events.json.events.length <= 100);
});

test("passwords can be reset with a one-time link, which signs out every session but keeps tokens", async () => {
	const user = await newUser("reset");
	const json = { "content-type": "application/json", origin: api };
	const me = async (headers: Record<string, string>) => ((await (await fetch(`${api}/api/me`, { headers })).json()) as { user: { username: string } | null }).user;

	// Asking for a reset says the same thing whether or not the account exists.
	const ask = (email: string) =>
		fetch(`${api}/api/auth/request-password-reset`, { method: "POST", headers: json, body: JSON.stringify({ email, redirectTo: "/reset-password" }) }).then((r) => r.json());
	assert.deepEqual(await ask(`${user.username}@test.invalid`), await ask("nobody@test.invalid"));
	assert.deepEqual(await (await fetch(`${api}/api/config`)).json(), { emailDelivery: false, verificationRequired: true });

	// Without email, the admin issues the link; users can't.
	const issue = (auth: string) =>
		fetch(`${api}/api/admin/password-reset`, { method: "POST", headers: { ...json, authorization: auth }, body: JSON.stringify({ username: user.username }) });
	assert.equal((await issue(`Bearer ${user.token}`)).status, 401);
	const { url } = (await (await issue("Bearer dev")).json()) as { url: string };
	const landing = await fetch(url, { redirect: "manual" });
	const target = new URL(landing.headers.get("location") ?? "", api);
	assert.equal(target.pathname, "/reset-password");
	const token = target.searchParams.get("token") ?? "";

	const reset = (newPassword: string) =>
		fetch(`${api}/api/auth/reset-password`, { method: "POST", headers: json, body: JSON.stringify({ token, newPassword }) });
	assert.equal((await reset("a-whole-new-password")).status, 200);
	assert.equal((await reset("and-another-one")).status, 400, "a link works once");

	assert.equal(await me({ cookie: user.cookie }), null, "existing sessions are signed out");
	assert.equal((await me({ authorization: `Bearer ${user.token}` }))?.username, user.username, "tokens keep working");
	const signIn = (password: string) =>
		fetch(`${api}/api/auth/sign-in/username`, { method: "POST", headers: json, body: JSON.stringify({ username: user.username, password }) });
	assert.equal((await signIn("correct-horse-battery")).status, 401);
	assert.equal((await signIn("a-whole-new-password")).status, 200);
});

test("unverified accounts can't create repositories, and sign-ins, repository counts and sizes are limited", async () => {
	const json = { "content-type": "application/json", origin: api };
	const exec = promisify(execFile);
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	const git = (args: string[], cwd?: string) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env });

	// An unverified account can sign in and make a token, but not create repositories.
	const fresh = await newUser("unverified", { verify: false });
	const me = (await (await fetch(`${api}/api/me`, { headers: { cookie: fresh.cookie } })).json()) as { user: { emailVerified: boolean } };
	assert.equal(me.user.emailVerified, false);
	const create = (who: { token: string }, name: string) =>
		fetch(`${api}/api/repos`, { method: "POST", headers: { ...json, authorization: `Bearer ${who.token}` }, body: JSON.stringify({ name }) });
	const refused = await create(fresh, "nope");
	assert.equal(refused.status, 403);
	assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "EMAIL_NOT_VERIFIED");

	// Verification links work once the account is verified, and the admin can't issue another.
	const link = (await (await adminLink("verify-email", fresh.username)).json()) as { url: string };
	assert.equal((await fetch(link.url, { redirect: "manual" })).status, 302);
	assert.equal((await adminLink("verify-email", fresh.username)).status, 409);
	assert.equal((await create(fresh, "now-ok")).status, 201);

	// Each account has at most POLICY.reposPerUser repositories.
	assert.equal((await create(fresh, "two")).status, 201);
	assert.equal((await create(fresh, "three")).status, 201);
	const over = await create(fresh, "four");
	assert.equal(over.status, 403);
	assert.equal(((await over.json()) as { error: { code: string } }).error.code, "QUOTA_EXCEEDED");

	// Pushes are counted; once a repository is over its size limit, git is told why.
	const dir = join(root, "quota");
	await git(["init", "-q", "-b", "master", dir]);
	await writeFile(join(dir, "noise.bin"), crypto.getRandomValues(new Uint8Array(60_000)));
	await git(["add", "-A"], dir);
	await git(["commit", "-q", "-m", "big"], dir);
	const url = new URL(`${api}/${fresh.username}/now-ok.git`);
	url.username = fresh.username;
	url.password = fresh.token;
	for (let i = 0; i < 4; i++) {
		await writeFile(join(dir, `more-${i}.bin`), crypto.getRandomValues(new Uint8Array(60_000)));
		await git(["add", "-A"], dir);
		await git(["commit", "-q", "-m", `more ${i}`], dir);
		try {
			await git(["push", "-q", url.toString(), "master"], dir);
		} catch (err) {
			assert.match(String(err), /remote error: This repository has reached its .* size limit/);
			assert.ok(i >= 2, `refused after only ${i} pushes`);
			break;
		}
		assert.ok(i < 3, "pushes past the size limit were accepted");
	}

	// Concurrent creates can't overshoot the repository count either.
	const racer = await newUser("racer");
	const raced = await Promise.all(Array.from({ length: 6 }, (_, i) => create(racer, `race-${i}`)));
	assert.equal(raced.filter((r) => r.status === 201).length, POLICY.reposPerUser);

	// The storage backend's own credentials are for the admin only; users go through megit's git URL.
	const direct = await fetch(`${api}/api/repos/${fresh.username}/now-ok/credentials`, { method: "POST", headers: { ...json, authorization: `Bearer ${fresh.token}` } });
	assert.equal(direct.status, 401);

	// Usernames can't change: repository URLs depend on them.
	const rename = await fetch(`${api}/api/auth/update-user`, { method: "POST", headers: { ...json, cookie: fresh.cookie }, body: JSON.stringify({ username: `${fresh.username}x` }) });
	assert.equal(rename.status, 400);

	// Sign-ins per account are limited no matter where they come from, or which name or form is used.
	const signIn = (path: string, body: Record<string, string>, headers: Record<string, string> = json) =>
		fetch(`${api}/api/auth/sign-in/${path}`, { method: "POST", headers, body: headers === json ? JSON.stringify(body) : new URLSearchParams(body).toString() });
	const wrong = { username: fresh.username, password: "wrong-password" };
	assert.equal((await signIn("username", wrong, { "content-type": "application/x-www-form-urlencoded", origin: api })).status, 415);
	for (let i = 0; i < POLICY.signInsPerAccount - 1; i++) assert.equal((await signIn("username", wrong)).status, 401);
	// The email address is the same account, whatever username is sent alongside it.
	assert.equal((await signIn("email", { email: `${fresh.username}@test.invalid`, username: "someone-else", password: "wrong-password" })).status, 401);
	const limited = await signIn("username", wrong);
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers.get("retry-after")) > 0);

	// Guessing tokens is limited per address (one of its own here; in production the edge sets this header).
	const address = `198.51.100.${Math.floor(Math.random() * 250)}`;
	const as = (token: string) => fetch(`${api}/api/me`, { headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": address } });
	for (let i = 0; i < POLICY.authFailuresPerIp; i++) assert.equal((await as("megit_pat_wrong")).status, 401);
	assert.equal((await as("megit_pat_wrong")).status, 429);
	assert.equal((await as(fresh.token)).status, 429, "the address is refused before any lookup");
});

test("routes take the repository from the path's position, so a repository can be named like a route", async () => {
	const ada = await newUser("routes");
	const headers = { "content-type": "application/json", authorization: `Bearer ${ada.token}` };
	assert.equal((await fetch(`${api}/api/repos`, { method: "POST", headers, body: JSON.stringify({ name: "files", readme: true }) })).status, 201);
	const readme = await fetch(`${api}/api/repos/${ada.username}/files/files/README.md`, { headers });
	assert.equal(readme.status, 200);
	assert.match(await readme.text(), /^# /);
});

test("only accepted pushes count toward a repository's size", async () => {
	const ada = await newUser("sizes");
	const headers = { "content-type": "application/json", authorization: `Bearer ${ada.token}` };
	assert.equal((await fetch(`${api}/api/repos`, { method: "POST", headers, body: JSON.stringify({ name: "sizes" }) })).status, 201);
	const used = async () => ((await (await fetch(`${api}/api/me`, { headers })).json()) as { user: { usage: { bytes: number } } }).user.usage.bytes;
	const exec = promisify(execFile);
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	const git = (args: string[], cwd: string) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env });
	const url = new URL(`${api}/${ada.username}/sizes.git`);
	url.username = ada.username;
	url.password = ada.token;
	const [one, two] = [join(root, "sizes-1"), join(root, "sizes-2")];
	for (const [dir, text] of [[one, "one"], [two, "two"]]) {
		await exec("git", ["init", "-q", "-b", "master", dir]);
		await writeFile(join(dir, "f.txt"), text.repeat(1000));
		await git(["add", "-A"], dir);
		await git(["commit", "-q", "-m", text], dir);
	}
	await git(["push", "-q", url.toString(), "master"], one);
	const after = await until(async () => ((await used()) > 0 ? used() : undefined));
	// The second history doesn't fast-forward, so the push is refused and its pack doesn't count.
	await assert.rejects(git(["push", "-q", url.toString(), "master"], two), /rejected|non-fast-forward|fetch first/);
	await new Promise((r) => setTimeout(r, 1000));
	assert.equal(await used(), after);
});

test("people star and fork repositories, and commit files from the browser", async () => {
	const ada = await newUser("forker-a");
	const bob = await newUser("forker-b");
	const as = (who: { token: string }) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${who.token}`, ...init.headers } });
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "lib", readme: true }) })).status, 201);
	const source = `/repos/${ada.username}/lib`;

	// The README of a new repository is titled with its name, not its internal id.
	assert.match(await (await as(ada)(`${source}/files/README.md`)).text(), /^# lib\n/);

	// Anyone who can read a repository can star it; stars are counted and listed per user.
	assert.equal((await as(bob)(`${source}/star`, { method: "PUT" })).status, 200);
	assert.equal((await as(bob)(`${source}/star`, { method: "PUT" })).status, 200, "starring twice is harmless");
	const starred = (await (await as(bob)(source)).json()) as { repo: { stars: number; starred: boolean } };
	assert.deepEqual([starred.repo.stars, starred.repo.starred], [1, true]);
	const stars = (await (await fetch(`${api}/api/repos?starredBy=${bob.username}`)).json()) as { repos: { fullName: string }[] };
	assert.deepEqual(stars.repos.map((r) => r.fullName), [`${ada.username}/lib`]);
	assert.equal((await fetch(`${api}/api${source}/star`, { method: "PUT" })).status, 401, "signed out, no star");

	// A web commit lands on the branch, and one based on a stale head is refused.
	const head = ((await (await as(ada)(source)).json()) as { project: { head: string } }).project.head;
	const commit = (body: unknown) => as(ada)(`${source}/contents`, { method: "POST", body: JSON.stringify(body) });
	const edit = await commit({ branch: "master", baseCommit: head, message: "Edit on the web", files: [{ path: "src/a.txt", content: "a\n" }] });
	assert.equal(edit.status, 201, await edit.clone().text());
	assert.equal((await commit({ branch: "master", baseCommit: head, message: "stale", files: [{ path: "b.txt", content: "b" }] })).status, 409);
	assert.equal((await commit({ branch: "master", message: "escape", files: [{ path: "../x", content: "x" }] })).status, 400);
	assert.equal((await as(bob)(`${source}/contents`, { method: "POST", body: JSON.stringify({ message: "no", files: [{ path: "x", content: "x" }] }) })).status, 403);

	// Forking copies every branch; the fork says where it came from, and the source counts it.
	const { commit: edited } = (await edit.json()) as { commit: string };
	const branched = await commit({ branch: "master", baseCommit: edited, newBranch: "topic", message: "Delete a", files: [{ path: "src/a.txt", content: null }] });
	assert.equal(branched.status, 201, await branched.clone().text());
	const forked = await as(bob)(`${source}/forks`, { method: "POST", body: JSON.stringify({}) });
	assert.equal(forked.status, 201, await forked.clone().text());
	const fork = ((await forked.json()) as { repo: { fullName: string; forkOf: { owner: string; name: string } } }).repo;
	assert.deepEqual(fork.forkOf, { owner: ada.username, name: "lib" });
	const exec = promisify(execFile);
	const dir = join(root, "fork-clone");
	await exec("git", ["clone", "-q", `${api}/${fork.fullName}.git`, dir]);
	await exec("git", ["fsck", "--strict"], { cwd: dir });
	const { stdout } = await exec("git", ["branch", "-r"], { cwd: dir });
	assert.match(stdout, /origin\/topic/);
	assert.equal((await exec("git", ["rev-parse", "origin/master"], { cwd: dir })).stdout.trim(), edited);
	const counted = (await (await as(ada)(source)).json()) as { repo: { forks: number } };
	assert.equal(counted.repo.forks, 1);
	assert.equal((await as(bob)(`${source}/forks`, { method: "POST", body: JSON.stringify({}) })).status, 409, "the name is taken");
});

test("only the exact star and fork routes skip the owner check; web commits keep git's rules and limits", async () => {
	const ada = await newUser("exact-a");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, { ...init, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers } });
	for (const name of ["star", "forks"]) {
		assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name, readme: true }) })).status, 201);
		assert.equal((await as(null)(`/repos/${ada.username}/${name}`, { method: "PATCH", body: JSON.stringify({ visibility: "private" }) })).status, 401);
		assert.equal((await as(null)(`/repos/${ada.username}/${name}`, { method: "DELETE" })).status, 401);
	}
	const repo = `/repos/${ada.username}/star`;
	const head = async () => ((await (await as(ada)(repo)).json()) as { project: { head: string } }).project.head;
	const commit = (body: Record<string, unknown>) => as(ada)(`${repo}/contents`, { method: "POST", body: JSON.stringify({ message: "m", ...body }) });
	assert.equal((await commit({ baseCommit: await head(), newBranch: "topic/star", files: [{ path: "x", content: "x" }] })).status, 201);
	assert.equal((await as(null)(`${repo}/branches/topic/star`, { method: "DELETE" })).status, 401, "a branch named like the route is still the owner's");

	// Paths git refuses to check out, and names it refuses as branches, are refused here too.
	for (const path of [".git/config", ".GIT./config", "git~1/hooks/x", ".g‌it/config", "a\\b"]) {
		assert.equal((await commit({ files: [{ path, content: "x" }] })).status, 400, path);
	}
	for (const name of ["HEAD", "-x", "a..b"]) assert.equal((await commit({ newBranch: name, files: [{ path: "y", content: "y" }] })).status, 400, name);

	// A web commit can't take a repository past its size limit (POLICY.repoBytes).
	const noise = (await import("node:crypto")).randomBytes(400_000).toString("base64");
	const big = await commit({ baseCommit: await head(), files: [{ path: "noise.txt", content: noise }] });
	assert.equal(big.status, 413, await big.clone().text());

	// Renaming an executable keeps it executable.
	const exec = promisify(execFile);
	const dir = join(root, "modes");
	const url = new URL(`${api}/${ada.username}/star.git`);
	url.username = ada.username;
	url.password = ada.token;
	await exec("git", ["clone", "-q", url.toString(), dir]);
	await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
	await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "x"], { cwd: dir }).catch(() => {});
	await exec("git", ["add", "run.sh"], { cwd: dir });
	await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add run.sh"], { cwd: dir });
	await exec("git", ["push", "-q", "origin", "HEAD"], { cwd: dir });
	const renamed = await commit({ baseCommit: await head(), files: [{ path: "run.sh", content: null }, { path: "bin/run.sh", content: "#!/bin/sh\necho hi\n", previousPath: "run.sh" }] });
	assert.equal(renamed.status, 201, await renamed.clone().text());
	await exec("git", ["pull", "-q", "origin", "master"], { cwd: dir });
	assert.match((await exec("git", ["ls-tree", "HEAD", "bin/run.sh"], { cwd: dir })).stdout, /^100755 /);
});

test("code search, webhooks and notifications", async () => {
	const ada = await newUser("hooks-a");
	const bob = await newUser("hooks-b");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, { ...init, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers } });
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "app", readme: true }) })).status, 201);
	const repo = `/repos/${ada.username}/app`;

	// A receiver that checks each delivery's signature.
	const received: { event: string; valid: boolean; body: { ref?: string; after?: string; event: string } }[] = [];
	const receiver = createHttpServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const expected = `sha256=${createHmac("sha256", "hush-hush").update(body).digest("hex")}`;
			received.push({ event: String(req.headers["x-megit-event"]), valid: req.headers["x-megit-signature-256"] === expected, body: JSON.parse(body) });
			res.writeHead(200).end("ok");
		});
	});
	await new Promise<void>((ok) => receiver.listen(0, "127.0.0.1", ok));
	const hookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;
	try {
		// Only the owner sees or adds webhooks; URLs are checked.
		assert.equal((await as(null)(`${repo}/hooks`)).status, 404);
		assert.equal((await as(bob)(`${repo}/hooks`, { method: "POST", body: JSON.stringify({ url: hookUrl, events: ["push"] }) })).status, 403);
		assert.equal((await as(ada)(`${repo}/hooks`, { method: "POST", body: JSON.stringify({ url: "ftp://example.com", events: ["push"] }) })).status, 400);
		assert.equal((await as(ada)(`${repo}/hooks`, { method: "POST", body: JSON.stringify({ url: hookUrl, events: ["push"] }) })).status, 400, "a secret is required");
		const created = await as(ada)(`${repo}/hooks`, { method: "POST", body: JSON.stringify({ url: hookUrl, secret: "hush-hush", events: ["push"] }) });
		assert.equal(created.status, 201, await created.clone().text());
		const { hook } = (await created.json()) as { hook: { id: string } };

		// A web commit is a push: the hook hears about it, signed, and the code index follows it.
		const head = ((await (await as(ada)(repo)).json()) as { project: { head: string } }).project.head;
		const commit = await as(ada)(`${repo}/contents`, {
			method: "POST",
			body: JSON.stringify({ branch: "master", baseCommit: head, message: "Add search target", files: [{ path: "src/needle.ts", content: "export const findTheHaystackNeedle = 42;\n" }] }),
		});
		assert.equal(commit.status, 201);
		const { commit: after } = (await commit.json()) as { commit: string };
		const push = await until(async () => received.find((r) => r.event === "push"));
		assert.ok(push.valid, "signed with the secret");
		assert.deepEqual([push.body.ref, push.body.after], ["refs/heads/master", after]);
		assert.ok(received.some((r) => r.event === "ping" && r.valid), "a new hook is pinged");
		const deliveries = (await (await as(ada)(`${repo}/hooks/${hook.id}/deliveries`)).json()) as { deliveries: { status: string }[] };
		assert.ok(deliveries.deliveries.some((d) => d.status === "delivered"));

		const search = await until(async () => {
			const result = (await (await as(null)(`${repo}/search?q=haystackneedle`)).json()) as { indexing: boolean; results: { path: string; lines: { line: number }[] }[] };
			return result.indexing ? undefined : result;
		});
		assert.deepEqual(search.results.map((r) => [r.path, r.lines[0]?.line]), [["src/needle.ts", 1]]);
		const byName = (await (await as(null)(`${repo}/search?q=ne`)).json()) as { results: { path: string }[] };
		assert.ok(byName.results.some((r) => r.path === "src/needle.ts"), "short queries match file names");
		assert.equal((await as(null)(`${repo}/search?q=${"a".repeat(101)}`)).status, 400, "long phrases are refused");
		assert.equal((await as(null)(`${repo}/search?q=aaa%00bbb`)).status, 400);

		// A paused hook sends nothing more.
		assert.equal((await as(ada)(`${repo}/hooks/${hook.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) })).status, 200);
		const seen = received.length;
		const now = ((await (await as(ada)(repo)).json()) as { project: { head: string } }).project.head;
		await as(ada)(`${repo}/contents`, { method: "POST", body: JSON.stringify({ branch: "master", baseCommit: now, message: "quiet", files: [{ path: "quiet.txt", content: "q" }] }) });
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(received.length, seen);
	} finally {
		receiver.close();
	}

	// Starring someone else's repository tells its owner; reading clears it.
	await as(bob)(`${repo}/star`, { method: "PUT" });
	const inbox = await until(async () => {
		const n = (await (await as(ada)("/notifications?unread")).json()) as { unread: number; notifications: { id: string; kind: string; url: string }[] };
		return n.unread > 0 ? n : undefined;
	});
	assert.equal(inbox.notifications[0].kind, "star");
	assert.equal(inbox.notifications[0].url, `/${ada.username}/app`);
	assert.equal((await as(bob)("/notifications")).status, 200);
	assert.equal(((await (await as(bob)("/notifications")).json()) as { unread: number }).unread, 0, "nobody else sees them");
	await as(ada)("/notifications/read", { method: "POST", body: JSON.stringify({}) });
	assert.equal(((await (await as(ada)("/notifications?unread")).json()) as { unread: number }).unread, 0);
});

test("repositories can be renamed, archived and transferred with the recipient's consent; old names redirect", async () => {
	const ada = await newUser("rena");
	const bob = await newUser("renb");
	const carol = await newUser("renc");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers },
		});
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "orig", visibility: "public", readme: true }) })).status, 201);

	// Renaming keeps the old name working, on the web and for git.
	assert.equal((await as(ada)(`/repos/${ada.username}/orig`, { method: "PATCH", body: JSON.stringify({ name: "bad/name" }) })).status, 400);
	const renamed = await as(ada)(`/repos/${ada.username}/orig`, { method: "PATCH", body: JSON.stringify({ name: "renamed" }) });
	assert.equal(renamed.status, 200, await renamed.clone().text());
	const viaOld = (await (await as(null)(`/repos/${ada.username}/orig`)).json()) as { repo: { fullName: string } };
	assert.equal(viaOld.repo.fullName, `${ada.username}/renamed`);
	const exec = promisify(execFile);
	await exec("git", ["clone", "-q", `${api}/${ada.username}/orig.git`, join(root, "renamed-clone")]);

	// The file finder lists every path.
	const paths = (await (await as(null)(`/repos/${ada.username}/renamed/paths`)).json()) as { paths: string[]; truncated: boolean };
	assert.deepEqual([paths.paths, paths.truncated], [["README.md"], false]);

	// Archived: read-only for git, the web editor and settings, but still starrable; unarchiving undoes it.
	const repo = `/repos/${ada.username}/renamed`;
	assert.equal((await as(ada)(repo, { method: "PATCH", body: JSON.stringify({ archived: true }) })).status, 200);
	const head = ((await (await as(ada)(repo)).json()) as { project: { head: string }; repo: { archivedAt: string | null } });
	assert.ok(head.repo.archivedAt);
	const edit = () =>
		as(ada)(`${repo}/contents`, { method: "POST", body: JSON.stringify({ branch: "master", message: "m", files: [{ path: "x.txt", content: "x" }] }) });
	assert.equal((await edit()).status, 403);
	assert.equal((await as(ada)(repo, { method: "PATCH", body: JSON.stringify({ description: "nope" }) })).status, 403);
	assert.equal((await as(bob)(`${repo}/star`, { method: "PUT" })).status, 200);
	assert.equal((await as(bob)(`${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "late" }) })).status, 403, "no new issues either");
	const push = join(root, "renamed-clone");
	await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "late"], { cwd: push });
	const authed = new URL(`${api}/${ada.username}/renamed.git`);
	authed.username = ada.username;
	authed.password = ada.token;
	await assert.rejects(exec("git", ["push", "-q", authed.toString(), "master"], { cwd: push }), /archived/);
	assert.equal((await as(ada)(repo, { method: "PATCH", body: JSON.stringify({ archived: false }) })).status, 200);
	assert.equal((await edit()).status, 201);

	// Transfers wait for the recipient; nobody else can take them.
	assert.equal((await as(ada)(`${repo}/transfer`, { method: "POST", body: JSON.stringify({ to: "no-such-user-x" }) })).status, 404);
	assert.equal((await as(bob)(`${repo}/transfer`, { method: "POST", body: JSON.stringify({ to: carol.username }) })).status, 403);
	const offered = await as(ada)(`${repo}/transfer`, { method: "POST", body: JSON.stringify({ to: bob.username }) });
	assert.equal(offered.status, 201, await offered.clone().text());
	const { transfer } = (await offered.json()) as { transfer: { id: string; to: string } };
	assert.equal(transfer.to, bob.username);
	assert.equal((await as(carol)(`/transfers/${transfer.id}/accept`, { method: "POST", body: "{}" })).status, 404);
	const incoming = (await (await as(bob)("/transfers")).json()) as { transfers: { id: string; repo: string; from: string }[] };
	assert.deepEqual(incoming.transfers.map((t) => [t.repo, t.from]), [[`${ada.username}/renamed`, ada.username]]);
	const accepted = await as(bob)(`/transfers/${transfer.id}/accept`, { method: "POST", body: "{}" });
	assert.equal(accepted.status, 200, await accepted.clone().text());
	assert.equal(((await accepted.json()) as { repo: { fullName: string } }).repo.fullName, `${bob.username}/renamed`);
	// Both old names lead to the new home, and the old owner can't change it any more.
	for (const old of [`/repos/${ada.username}/orig`, repo]) {
		assert.equal(((await (await as(null)(old)).json()) as { repo: { fullName: string } }).repo.fullName, `${bob.username}/renamed`);
	}
	assert.equal((await as(ada)(repo, { method: "PATCH", body: JSON.stringify({ description: "mine?" }) })).status, 403);
	assert.equal((await as(bob)(`/repos/${bob.username}/renamed`, { method: "PATCH", body: JSON.stringify({ description: "mine" }) })).status, 200);
	assert.equal(((await (await as(bob)("/transfers")).json()) as { transfers: unknown[] }).transfers.length, 0);
});

test("git over SSH: keys, clone, push, permissions, branch protection and archived repositories", async () => {
	const ada = await newUser("ssha");
	const bob = await newUser("sshb");
	const as = (who: { token: string }) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${who.token}`, ...init.headers } });
	const exec = promisify(execFile);
	const dir = join(root, "ssh");
	await exec("mkdir", ["-p", dir]);
	const { PROXY_SCRIPT } = await import("../../src/ssh/proxy-script.ts");
	await writeFile(join(dir, "proxy.mjs"), PROXY_SCRIPT);
	const keyFor = async (who: string) => {
		await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", who, "-f", join(dir, who)]);
		const { readFile } = await import("node:fs/promises");
		return readFile(join(dir, `${who}.pub`), "utf8");
	};
	const adaKey = await keyFor("ada");
	const bobKey = await keyFor("bob");
	assert.equal((await as(ada)("/ssh/keys", { method: "POST", body: JSON.stringify({ key: "ssh-ed25519 notbase64!!" }) })).status, 400);
	const added = await as(ada)("/ssh/keys", { method: "POST", body: JSON.stringify({ key: adaKey }) });
	assert.equal(added.status, 201, await added.clone().text());
	assert.equal((await as(bob)("/ssh/keys", { method: "POST", body: JSON.stringify({ key: adaKey }) })).status, 409, "a key belongs to one account");
	assert.equal((await as(bob)("/ssh/keys", { method: "POST", body: JSON.stringify({ key: bobKey }) })).status, 201);
	const info = (await (await fetch(`${api}/api/ssh`)).json()) as { hostKey: string; url: string };
	await writeFile(join(dir, "known_hosts"), `megit-test ${info.hostKey}\n`);

	const ssh = (who: string) =>
		[
			"ssh -F /dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes",
			`-o UserKnownHostsFile=${join(dir, "known_hosts")} -i ${join(dir, who)}`,
			`-o "ProxyCommand=node ${join(dir, "proxy.mjs")} ${info.url}"`,
		].join(" ");
	const git = (who: string, args: string[], cwd?: string) =>
		exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { ...process.env, GIT_SSH_COMMAND: ssh(who), GIT_TERMINAL_PROMPT: "0" } });

	// A key that isn't on any account gets nowhere; a known one is greeted by name.
	await keyFor("stranger");
	await assert.rejects(exec("sh", ["-c", `${ssh("stranger")} -T git@megit-test`]), /Permission denied/);
	await assert.rejects(exec("sh", ["-c", `${ssh("ada")} -T git@megit-test`]), (err: { stderr: string }) => err.stderr.includes(`Hi ${ada.username}!`));

	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "over-ssh", visibility: "private", readme: true }) })).status, 201);
	const remote = `git@megit-test:${ada.username}/over-ssh.git`;
	await git("ada", ["clone", "-q", remote, join(dir, "clone")]);
	await writeFile(join(dir, "clone", "big.bin"), Buffer.alloc(150_000, 7));
	await git("ada", ["add", "-A"], join(dir, "clone"));
	await git("ada", ["commit", "-q", "-m", "over ssh"], join(dir, "clone"));
	await git("ada", ["push", "-q", "origin", "master"], join(dir, "clone"));
	const head = (await git("ada", ["rev-parse", "HEAD"], join(dir, "clone"))).stdout.trim();
	const view = (await (await as(ada)(`/repos/${ada.username}/over-ssh`)).json()) as { project: { head: string }; repo: { sizeBytes: number; sshUrl: string } };
	assert.equal(view.project.head, head);
	assert.ok(view.repo.sizeBytes > 0, "the push counts towards the size quota");
	assert.equal(view.repo.sshUrl, `git@127.0.0.1:${ada.username}/over-ssh.git`);
	await git("ada", ["push", "-q", "origin", "master:topic"], join(dir, "clone"));
	await git("ada", ["push", "-q", "origin", "--delete", "topic"], join(dir, "clone"));
	await git("ada", ["fetch", "-q", "origin"], join(dir, "clone"));

	// Branch protection holds over SSH too: a force push is put back, a deletion refused.
	const sshRepo = `/repos/${ada.username}/over-ssh`;
	assert.equal((await as(ada)(`${sshRepo}/protection`, { method: "PUT", body: JSON.stringify({ pattern: "master", blockForcePushes: true, blockDeletions: true }) })).status, 200);
	const protectedHead = (await git("ada", ["rev-parse", "HEAD"], join(dir, "clone"))).stdout.trim();
	await git("ada", ["reset", "-q", "--hard", "HEAD~1"], join(dir, "clone"));
	await git("ada", ["commit", "-q", "--allow-empty", "-m", "rewritten"], join(dir, "clone"));
	await assert.rejects(git("ada", ["push", "-q", "--force", "origin", "master"], join(dir, "clone")), /force pushes aren't allowed/);
	assert.equal(((await (await as(ada)(sshRepo)).json()) as { project: { head: string } }).project.head, protectedHead);
	await assert.rejects(git("ada", ["push", "-q", "origin", "--delete", "master"], join(dir, "clone")), /can't be deleted/);
	await git("ada", ["reset", "-q", "--hard", protectedHead], join(dir, "clone"));
	assert.equal((await as(ada)(`${sshRepo}/protection?pattern=master`, { method: "DELETE" })).status, 200);

	// Someone else's private repository doesn't exist for them.
	await assert.rejects(git("bob", ["clone", "-q", remote, join(dir, "bob-clone")]), /not found/);

	// Archived repositories refuse pushes over SSH too.
	assert.equal((await as(ada)(`/repos/${ada.username}/over-ssh`, { method: "PATCH", body: JSON.stringify({ archived: true }) })).status, 200);
	await git("ada", ["commit", "-q", "--allow-empty", "-m", "late"], join(dir, "clone"));
	await assert.rejects(git("ada", ["push", "-q", "origin", "master"], join(dir, "clone")), /archived/);
	assert.equal((await as(ada)(`/repos/${ada.username}/over-ssh`, { method: "PATCH", body: JSON.stringify({ archived: false }) })).status, 200);

	// Once a repository is full, further pushes are refused with the reason.
	await writeFile(join(dir, "clone", "bigger.bin"), Buffer.from(Array.from({ length: 300_000 }, () => Math.floor(Math.random() * 256))));
	await git("ada", ["add", "-A"], join(dir, "clone"));
	await git("ada", ["commit", "-q", "-m", "fills it up"], join(dir, "clone"));
	await git("ada", ["push", "-q", "origin", "master"], join(dir, "clone"));
	await git("ada", ["commit", "-q", "--allow-empty", "-m", "one more"], join(dir, "clone"));
	await assert.rejects(git("ada", ["push", "-q", "origin", "master"], join(dir, "clone")), /size limit/);

	// Removing the key locks it out.
	const { keys } = (await (await as(ada)("/ssh/keys")).json()) as { keys: { id: string; fingerprint: string }[] };
	assert.equal(keys.length, 1);
	assert.equal((await as(ada)(`/ssh/keys/${keys[0].id}`, { method: "DELETE" })).status, 200);
	await assert.rejects(git("ada", ["fetch", "-q", "origin"], join(dir, "clone")), /Permission denied/);
});

test("tags, releases, the commit graph, branch protection over HTTPS, and issues", async () => {
	const ada = await newUser("tga");
	const bob = await newUser("tgb");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers },
		});
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "tagged", visibility: "public", readme: true }) })).status, 201);
	const repo = `/repos/${ada.username}/tagged`;
	const exec = promisify(execFile);
	const dir = join(root, "tagged");
	const authed = new URL(`${api}/${ada.username}/tagged.git`);
	authed.username = ada.username;
	authed.password = ada.token;
	const git = (...args: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	await exec("git", ["clone", "-q", authed.toString(), dir]);

	// A feature branch merged back in makes a graph with two lanes.
	await git("checkout", "-q", "-b", "feature");
	await git("commit", "-q", "--allow-empty", "-m", "feature work");
	await git("checkout", "-q", "master");
	await git("commit", "-q", "--allow-empty", "-m", "mainline work");
	await git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
	await git("push", "-q", "origin", "master", "feature");
	await git("tag", "pushed-tag");
	await git("push", "-q", "origin", "pushed-tag");
	const graph = (await (await as(null)(`${repo}/graph`)).json()) as { commits: { message: string; parents: string[]; branches: string[]; tags: string[] }[] };
	assert.equal(graph.commits.length, 4);
	assert.equal(graph.commits[0].parents.length, 2);
	assert.deepEqual([graph.commits[0].branches, graph.commits[0].tags], [["master"], ["pushed-tag"]]);
	assert.ok(graph.commits.some((c) => c.branches.includes("feature")));

	// Tags from the web and from git; a release can make its own tag; downloads work by tag name.
	assert.equal((await as(bob)(`${repo}/tags`, { method: "POST", body: JSON.stringify({ name: "v0" }) })).status, 403);
	assert.equal((await as(ada)(`${repo}/tags`, { method: "POST", body: JSON.stringify({ name: "v1.0", target: "feature" }) })).status, 201);
	assert.equal((await as(ada)(`${repo}/tags`, { method: "POST", body: JSON.stringify({ name: "v1.0" }) })).status, 409);
	assert.equal((await as(ada)(`${repo}/tags`, { method: "POST", body: JSON.stringify({ name: "bad..name" }) })).status, 400);
	const release = await as(ada)(`${repo}/releases`, { method: "POST", body: JSON.stringify({ tag: "v2.0", name: "Two", notes: "# Notes", prerelease: true }) });
	assert.equal(release.status, 201, await release.clone().text());
	const tags = (await (await as(null)(`${repo}/tags`)).json()) as { tags: { name: string; commit: string }[] };
	assert.deepEqual(tags.tags.map((t) => t.name).sort(), ["pushed-tag", "v1.0", "v2.0"]);
	const releases = (await (await as(null)(`${repo}/releases`)).json()) as { releases: { id: string; tag: string; prerelease: boolean; commit: string | null }[] };
	assert.deepEqual(releases.releases.map((r) => [r.tag, r.prerelease, Boolean(r.commit)]), [["v2.0", true, true]]);
	const zip = await as(null)(`${repo}/archive?format=zip&ref=v1.0`);
	assert.equal(zip.status, 200);
	assert.match(zip.headers.get("content-disposition") ?? "", /tagged-v1\.0\.zip/);
	await zip.arrayBuffer();
	await git("fetch", "-q", "--tags", "origin");
	assert.equal((await git("rev-parse", "v1.0^{commit}")).stdout.trim(), (await git("rev-parse", "feature")).stdout.trim());
	assert.equal((await as(ada)(`${repo}/releases/${releases.releases[0].id}?deleteTag`, { method: "DELETE" })).status, 200);
	assert.ok(!((await (await as(null)(`${repo}/tags`)).json()) as { tags: { name: string }[] }).tags.some((t) => t.name === "v2.0"));

	// Branch protection: force pushes are put back, deletion and direct pushes are refused, for git and the web.
	assert.equal((await as(bob)(`${repo}/protection`, { method: "PUT", body: JSON.stringify({ pattern: "master", blockForcePushes: true }) })).status, 403);
	assert.equal((await as(ada)(`${repo}/protection`, { method: "PUT", body: JSON.stringify({ pattern: "master", blockForcePushes: true, blockDeletions: true }) })).status, 200);
	assert.equal((await as(ada)(`${repo}/protection`, { method: "PUT", body: JSON.stringify({ pattern: "release/*", requireMergeQueue: true }) })).status, 200);
	const before = (await git("rev-parse", "master")).stdout.trim();
	await git("reset", "-q", "--hard", "HEAD~1");
	await git("commit", "-q", "--allow-empty", "-m", "rewritten");
	await assert.rejects(git("push", "-q", "--force", "origin", "master"), /force pushes aren't allowed/);
	assert.equal(((await (await as(null)(repo)).json()) as { project: { head: string } }).project.head, before, "the branch was put back");
	await git("reset", "-q", "--hard", before);
	await git("commit", "-q", "--allow-empty", "-m", "fast-forward");
	await git("push", "-q", "origin", "master");
	await assert.rejects(git("push", "-q", "origin", "--delete", "master"), /can't be deleted/);
	await git("push", "-q", "origin", "master:feature-2");
	await assert.rejects(git("push", "-q", "origin", "master:release/1"), /merge queue/);
	assert.equal((await as(ada)(`${repo}/branches/master`, { method: "DELETE" })).status, 400, "the default branch is never deletable");
	const head = ((await (await as(ada)(repo)).json()) as { project: { head: string } }).project.head;
	assert.equal(
		(await as(ada)(`${repo}/contents`, { method: "POST", body: JSON.stringify({ branch: "master", baseCommit: head, newBranch: "release/2", message: "m", files: [{ path: "x", content: "x" }] }) })).status,
		403,
	);
	const rules = (await (await as(null)(`${repo}/protection`)).json()) as { rules: { pattern: string }[] };
	assert.deepEqual(rules.rules.map((r) => r.pattern), ["master", "release/*"]);

	// Issues: anyone signed in opens and comments; the owner labels; authors and the owner close.
	assert.equal((await as(null)(`${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "anon" }) })).status, 401);
	const opened = await as(bob)(`${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "It breaks", body: "Steps: **run it**", labels: ["bug"] }) });
	assert.equal(opened.status, 201, await opened.clone().text());
	const issue = ((await opened.json()) as { issue: { number: number; labels: string[]; canLabel: boolean } }).issue;
	assert.deepEqual([issue.number, issue.labels, issue.canLabel], [1, [], false], "only the owner labels");
	assert.equal((await as(bob)(`${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "" }) })).status, 400);
	const second = ((await (await as(ada)(`${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "Docs", labels: ["docs"] }) })).json()) as { issue: { number: number; labels: string[] } }).issue;
	assert.deepEqual([second.number, second.labels], [2, ["docs"]]);
	assert.equal((await as(ada)(`${repo}/issues/1`, { method: "PATCH", body: JSON.stringify({ labels: ["bug", "p1"] }) })).status, 200);
	assert.equal((await as(bob)(`${repo}/issues/2`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) })).status, 403, "not bob's issue");
	const comment = await as(ada)(`${repo}/issues/1/comments`, { method: "POST", body: JSON.stringify({ body: "Thanks, looking." }) });
	assert.equal(comment.status, 201);
	const { comment: posted } = (await comment.json()) as { comment: { id: string } };
	assert.equal((await as(bob)(`${repo}/issues/1/comments/${posted.id}`, { method: "PATCH", body: JSON.stringify({ body: "edited" }) })).status, 403);
	assert.equal((await as(bob)(`${repo}/issues/1`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) })).status, 200, "authors close their own");
	const detail = (await (await as(null)(`${repo}/issues/1`)).json()) as { issue: { state: string; closedBy: string; labels: string[]; comments: number }; comments: { body: string }[] };
	assert.deepEqual([detail.issue.state, detail.issue.closedBy, detail.issue.labels, detail.issue.comments], ["closed", bob.username, ["bug", "p1"], 1]);
	const open = (await (await as(null)(`${repo}/issues`)).json()) as { issues: { number: number }[]; open: number; closed: number };
	assert.deepEqual([open.issues.map((i) => i.number), open.open, open.closed], [[2], 1, 1]);
	const labelled = (await (await as(null)(`${repo}/issues?state=all&label=p1`)).json()) as { issues: { number: number }[] };
	assert.deepEqual(labelled.issues.map((i) => i.number), [1]);
	const searched = (await (await as(null)(`${repo}/issues?state=all&q=run%20it`)).json()) as { issues: { number: number }[] };
	assert.deepEqual(searched.issues.map((i) => i.number), [1]);
	const listing = (await (await as(null)(repo)).json()) as { repo: { openIssues: number } };
	assert.equal(listing.repo.openIssues, 1);
	// The owner hears about bob's issue; bob hears about the comment on his.
	const adaInbox = await until(async () => {
		const n = (await (await as(ada)("/notifications")).json()) as { notifications: { kind: string; url: string }[] };
		return n.notifications.some((x) => x.kind === "issue") ? n : undefined;
	});
	assert.ok(adaInbox.notifications.some((x) => x.url === `/${ada.username}/tagged/issues/1`));
	await until(async () => {
		const n = (await (await as(bob)("/notifications")).json()) as { notifications: { kind: string }[] };
		return n.notifications.some((x) => x.kind === "issue") ? true : undefined;
	});
	// A commit on the default branch that says it fixes an issue closes it.
	await git("commit", "-q", "--allow-empty", "-m", "Write the docs\n\nFixes #2");
	await git("push", "-q", "origin", "master");
	const fixed = await until(async () => {
		const i = ((await (await as(null)(`${repo}/issues/2`)).json()) as { issue: { state: string; closedByCommit: string | null } }).issue;
		return i.state === "closed" ? i : undefined;
	});
	assert.equal(fixed.closedByCommit, (await git("rev-parse", "HEAD")).stdout.trim());
	const events = (await (await as(null)(`${repo}/events`)).json()) as { events: { type: string }[] };
	for (const type of ["tag.created", "release.published", "issue.opened", "issue.commented", "issue.closed"]) {
		assert.ok(events.events.some((e) => e.type === type), `${type} is in the feed`);
	}
});

test("pull requests: from a branch and from a fork, reviewed line by line, squashed or merged, conflicts refused", async () => {
	const ada = await newUser("pra");
	const bob = await newUser("prb");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers },
		});
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "prs", visibility: "public", readme: true }) })).status, 201);
	const repo = `/repos/${ada.username}/prs`;
	const exec = promisify(execFile);
	const url = (who: { username: string; token: string }, path: string) => {
		const u = new URL(`${api}/${path}.git`);
		u.username = who.username;
		u.password = who.token;
		return u.toString();
	};
	const dir = join(root, "prs");
	const git = (cwd: string, ...args: string[]) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	await exec("git", ["clone", "-q", url(ada, `${ada.username}/prs`), dir]);

	// Two branches that edit the same line, and an issue the first one fixes.
	const issue = ((await (await as(ada)(`${repo}/issues`, { method: "POST", body: JSON.stringify({ title: "Greeting is missing" }) })).json()) as { issue: { number: number } }).issue;
	for (const [branch, text] of [["hello", "hello\n"], ["howdy", "howdy\n"]]) {
		await git(dir, "checkout", "-q", "-B", branch, "origin/master");
		await writeFile(join(dir, "greeting.txt"), text);
		await git(dir, "add", "-A");
		await git(dir, "commit", "-q", "-m", `Say ${text.trim()}`);
		await git(dir, "push", "-q", "origin", branch);
	}
	const open = (head: string, body = "", headRepo?: string) => as(headRepo ? bob : ada)(`${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: `Use ${head}`, body, base: "master", head, headRepo }) });
	const first = await open("hello", `Fixes #${issue.number}`);
	assert.equal(first.status, 201, await first.clone().text());
	const pr = ((await first.json()) as { pull: { number: number; pullState: string } }).pull;
	assert.deepEqual([pr.number, pr.pullState], [issue.number + 1, "open"], "numbers are shared with issues");
	assert.equal((await open("hello")).status, 409, "one open pull request per branch");
	assert.equal((await open("master")).status, 400);
	assert.equal(((await (await as(null)(repo)).json()) as { repo: { openPulls: number; openIssues: number } }).repo.openPulls, 1);
	const issues = (await (await as(null)(`${repo}/issues`)).json()) as { issues: { number: number }[] };
	assert.deepEqual(issues.issues.map((i) => i.number), [issue.number], "pull requests aren't listed as issues");
	const second = ((await (await open("howdy")).json()) as { pull: { number: number } }).pull;

	const files = (await (await as(null)(`${repo}/pulls/${pr.number}/files`)).json()) as { comparison: { commits: unknown[]; diff: { files: { path: string }[] } } };
	assert.deepEqual([files.comparison.commits.length, files.comparison.diff.files.map((f) => f.path)], [1, ["greeting.txt"]]);

	// Anyone signed in comments on lines; only people who can merge approve, and not their own.
	const review = (who: { token: string }, input: unknown) => as(who)(`${repo}/pulls/${pr.number}/reviews`, { method: "POST", body: JSON.stringify(input) });
	assert.equal((await review(bob, { state: "commented", body: "Nice", comments: [{ path: "greeting.txt", line: 1, side: "new", body: "Capitalise?" }] })).status, 201);
	assert.equal((await review(bob, { state: "approved" })).status, 403);
	assert.equal((await review(ada, { state: "approved" })).status, 403, "not your own pull request");
	const detail = (await (await as(null)(`${repo}/pulls/${pr.number}`)).json()) as { reviews: { state: string }[]; reviewComments: { path: string; line: number; body: string }[] };
	assert.deepEqual(detail.reviewComments.map((k) => [k.path, k.line, k.body]), [["greeting.txt", 1, "Capitalise?"]]);

	// A branch that needs a review can't take it unapproved.
	assert.equal((await as(ada)(`${repo}/protection`, { method: "PUT", body: JSON.stringify({ pattern: "master", requireReview: true }) })).status, 200);
	const refused = await as(ada)(`${repo}/pulls/${pr.number}/merge`, { method: "POST", body: JSON.stringify({ method: "squash" }) });
	assert.equal(refused.status, 403);
	assert.equal((await as(ada)(`${repo}/protection?pattern=master`, { method: "DELETE" })).status, 200);
	assert.equal((await as(bob)(`${repo}/pulls/${pr.number}/merge`, { method: "POST", body: "{}" })).status, 403, "only people who can push merge");

	// Squash: one ordinary commit on master, the pull request merged, and the issue it fixes closed.
	const merged = await as(ada)(`${repo}/pulls/${pr.number}/merge`, { method: "POST", body: JSON.stringify({ method: "squash" }) });
	assert.equal(merged.status, 200, await merged.clone().text());
	const { commit } = (await merged.json()) as { commit: string };
	const head = ((await (await as(null)(repo)).json()) as { project: { head: string } }).project.head;
	assert.equal(head, commit);
	const squashed = (await (await as(null)(`${repo}/commits/${commit}`)).json()) as { commit: { parents: string[]; message: string } };
	assert.equal(squashed.commit.parents.length, 1);
	assert.match(squashed.commit.message, new RegExp(`Use hello \\(#${pr.number}\\)`));
	const after = (await (await as(null)(`${repo}/pulls/${pr.number}`)).json()) as { pull: { pullState: string; mergedBy: string } };
	assert.deepEqual([after.pull.pullState, after.pull.mergedBy], ["merged", ada.username]);
	await until(async () => (((await (await as(null)(`${repo}/issues/${issue.number}`)).json()) as { issue: { state: string } }).issue.state === "closed" ? true : undefined));

	// The other branch edits the same line: merging it now conflicts, and nothing changes.
	const conflict = await as(ada)(`${repo}/pulls/${second.number}/merge`, { method: "POST", body: "{}" });
	assert.equal(conflict.status, 409);
	assert.match(((await conflict.json()) as { error: { message: string } }).error.message, /greeting\.txt/);

	// From a fork: bob's change arrives with a merge commit.
	const fork = await as(bob)(`${repo}/forks`, { method: "POST", body: JSON.stringify({}) });
	assert.equal(fork.status, 201, await fork.clone().text());
	const forkDir = join(root, "prs-fork");
	await exec("git", ["clone", "-q", url(bob, `${bob.username}/prs`), forkDir]);
	await writeFile(join(forkDir, "CONTRIBUTING.md"), "Be kind.\n");
	await git(forkDir, "add", "-A");
	await git(forkDir, "commit", "-q", "-m", "Add contributing notes");
	await git(forkDir, "push", "-q", "origin", "HEAD:contrib");
	const fromFork = await open("contrib", "", `${bob.username}/prs`);
	assert.equal(fromFork.status, 201, await fromFork.clone().text());
	const forkPull = ((await fromFork.json()) as { pull: { number: number; headRepo: string } }).pull;
	assert.equal(forkPull.headRepo, `${bob.username}/prs`);
	const viaFork = await as(ada)(`${repo}/pulls/${forkPull.number}/merge`, { method: "POST", body: JSON.stringify({ method: "merge" }) });
	assert.equal(viaFork.status, 200, await viaFork.clone().text());
	const mergeCommit = ((await viaFork.json()) as { commit: string }).commit;
	const mergeDetail = (await (await as(null)(`${repo}/commits/${mergeCommit}`)).json()) as { commit: { parents: string[] }; diff: { files: { path: string }[] } };
	assert.equal(mergeDetail.commit.parents.length, 2);
	assert.deepEqual(mergeDetail.diff.files.map((f) => f.path), ["CONTRIBUTING.md"]);
	const list = (await (await as(null)(`${repo}/pulls?state=all`)).json()) as { pulls: { number: number; pullState: string }[]; open: number };
	assert.deepEqual(list.pulls.map((p) => p.pullState).sort(), ["merged", "merged", "open"]);
});

test("organizations, teams and collaborators: invitations, read for members, write and admin by grant, reviews that count", async () => {
	const ada = await newUser("orga");
	const bob = await newUser("orgb");
	const cy = await newUser("orgc");
	const as = (who: { token: string } | null) => (path: string, init: RequestInit = {}) =>
		fetch(`${api}/api${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...init.headers },
		});
	const orgName = `acme-${run}`.toLowerCase();
	const created = await as(ada)("/orgs", { method: "POST", body: JSON.stringify({ name: orgName, displayName: "Acme" }) });
	assert.equal(created.status, 201, await created.clone().text());
	assert.equal((await as(bob)("/orgs", { method: "POST", body: JSON.stringify({ name: orgName }) })).status, 409, "names are unique");
	assert.equal((await as(ada)("/orgs", { method: "POST", body: JSON.stringify({ name: "settings" }) })).status, 400, "reserved names stay reserved");

	// Members join by accepting an invitation; until then they're nobody.
	assert.equal((await as(bob)(`/orgs/${orgName}/members`, { method: "POST", body: JSON.stringify({ username: cy.username }) })).status, 403);
	assert.equal((await as(ada)(`/orgs/${orgName}/members`, { method: "POST", body: JSON.stringify({ username: bob.username }) })).status, 201);
	const org = await (await as(ada)(`/orgs/${orgName}`)).json() as { org: { members: { username: string; state: string }[] } };
	assert.deepEqual(org.org.members.map((m) => [m.username, m.state]).sort(), [[ada.username, "active"], [bob.username, "invited"]].sort());
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "secret", visibility: "private", readme: true, owner: orgName }) })).status, 201);
	assert.equal((await as(bob)("/repos", { method: "POST", body: JSON.stringify({ name: "nope", owner: orgName }) })).status, 403, "not a member yet");
	const repo = `/repos/${orgName}/secret`;
	assert.equal((await as(bob)(repo)).status, 404);
	const invites = (await (await as(bob)("/invitations")).json()) as { invitations: { kind: string; id: string; name: string }[] };
	assert.deepEqual(invites.invitations.map((i) => [i.kind, i.name]), [["org", orgName]]);
	assert.equal((await as(bob)(`/invitations/org/${invites.invitations[0].id}/accept`, { method: "POST" })).status, 200);

	// Members read every repository; a team grant lets them push; settings stay with owners.
	assert.equal((await as(bob)(repo)).status, 200);
	assert.equal((await as(cy)(repo)).status, 404);
	const exec = promisify(execFile);
	const gitUrl = (who: { username: string; token: string }, path: string) => {
		const u = new URL(`${api}/${path}.git`);
		u.username = who.username;
		u.password = who.token;
		return u.toString();
	};
	const dir = join(root, "org-clone");
	await exec("git", ["clone", "-q", gitUrl(bob, `${orgName}/secret`), dir]);
	const commit = (msg: string) => exec("git", ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-q", "--allow-empty", "-m", msg], { cwd: dir });
	await commit("from bob");
	await assert.rejects(exec("git", ["push", "-q", "origin", "master"], { cwd: dir }), /403|can't push/);
	const team = await as(ada)(`/orgs/${orgName}/teams`, { method: "POST", body: JSON.stringify({ name: "devs" }) });
	const teamId = ((await team.json()) as { org: { teams: { id: string }[] } }).org.teams[0].id;
	assert.equal((await as(ada)(`/orgs/${orgName}/teams/${teamId}/members/${cy.username}`, { method: "PUT" })).status, 400, "teams are for members");
	assert.equal((await as(ada)(`/orgs/${orgName}/teams/${teamId}/members/${bob.username}`, { method: "PUT" })).status, 200);
	assert.equal((await as(ada)(`/orgs/${orgName}/teams/${teamId}/repos/secret`, { method: "PUT", body: JSON.stringify({ permission: "write" }) })).status, 200);
	await exec("git", ["push", "-q", "origin", "master"], { cwd: dir });
	const info = (await (await as(bob)(repo)).json()) as { repo: { canWrite: boolean; canAdmin: boolean } };
	assert.deepEqual([info.repo.canWrite, info.repo.canAdmin], [true, false]);
	assert.equal((await as(bob)(repo, { method: "PATCH", body: JSON.stringify({ description: "mine" }) })).status, 403);
	assert.equal((await as(bob)(`${repo}/hooks`)).status, 404, "webhooks are for admins");
	assert.equal((await as(ada)(repo, { method: "PATCH", body: JSON.stringify({ description: "ours" }) })).status, 200);
	assert.equal((await as(ada)(`/orgs/${orgName}/members/${ada.username}`, { method: "DELETE" })).status, 409, "the last owner can't leave");
	const listed = (await (await as(bob)(`/repos?owner=${orgName}`)).json()) as { repos: { name: string }[] };
	assert.deepEqual(listed.repos.map((r) => r.name), ["secret"], "members see private organization repositories in lists");

	// A collaborator with write access on a personal repository: invited, then their approval counts.
	assert.equal((await as(ada)("/repos", { method: "POST", body: JSON.stringify({ name: "solo", visibility: "private", readme: true }) })).status, 201);
	const solo = `/repos/${ada.username}/solo`;
	assert.equal((await as(ada)(`${solo}/collaborators/${cy.username}`, { method: "PUT", body: JSON.stringify({ permission: "write" }) })).status, 200);
	assert.equal((await as(cy)(solo)).status, 404, "not until they accept");
	const cyInvite = ((await (await as(cy)("/invitations")).json()) as { invitations: { kind: string; id: string }[] }).invitations[0];
	assert.equal((await as(cy)(`/invitations/${cyInvite.kind}/${cyInvite.id}/accept`, { method: "POST" })).status, 200);
	assert.equal((await as(cy)(solo)).status, 200);
	const soloDir = join(root, "solo-clone");
	await exec("git", ["clone", "-q", gitUrl(ada, `${ada.username}/solo`), soloDir]);
	await exec("git", ["checkout", "-q", "-b", "change"], { cwd: soloDir });
	await writeFile(join(soloDir, "x.txt"), "x\n");
	await exec("git", ["add", "-A"], { cwd: soloDir });
	await exec("git", ["-c", "user.name=a", "-c", "user.email=a@a", "commit", "-q", "-m", "change"], { cwd: soloDir });
	await exec("git", ["push", "-q", "origin", "change"], { cwd: soloDir });
	assert.equal((await as(ada)(`${solo}/protection`, { method: "PUT", body: JSON.stringify({ pattern: "master", requireReview: true }) })).status, 200);
	const pr = ((await (await as(ada)(`${solo}/pulls`, { method: "POST", body: JSON.stringify({ title: "Change", base: "master", head: "change" }) })).json()) as { pull: { number: number } }).pull;
	assert.equal((await as(ada)(`${solo}/pulls/${pr.number}/merge`, { method: "POST", body: "{}" })).status, 403);
	assert.equal((await as(cy)(`${solo}/pulls/${pr.number}/reviews`, { method: "POST", body: JSON.stringify({ state: "approved" }) })).status, 201);
	assert.equal(((await (await as(ada)(`${solo}/pulls/${pr.number}`)).json()) as { pull: { decision: string } }).pull.decision, "approved");
	assert.equal((await as(ada)(`${solo}/pulls/${pr.number}/merge`, { method: "POST", body: "{}" })).status, 200);
	assert.equal((await as(cy)(`${solo}/collaborators`)).status, 404, "collaborators are listed to admins only");

	// Transfers into an organization are accepted by its owners.
	const offered = await as(ada)(`${solo}/transfer`, { method: "POST", body: JSON.stringify({ to: orgName }) });
	assert.equal(offered.status, 201, await offered.clone().text());
	const offer = ((await (await as(ada)("/transfers")).json()) as { transfers: { id: string; to: string }[] }).transfers.find((t) => t.to === orgName);
	assert.ok(offer, "an owner sees offers to their organization");
	assert.equal((await as(bob)(`/transfers/${offer.id}/accept`, { method: "POST", body: "{}" })).status, 404, "members can't accept for it");
	const moved = await as(ada)(`/transfers/${offer.id}/accept`, { method: "POST", body: "{}" });
	assert.equal(moved.status, 200, await moved.clone().text());
	assert.equal(((await moved.json()) as { repo: { fullName: string } }).repo.fullName, `${orgName}/solo`);
	assert.equal((await as(bob)(`/repos/${orgName}/solo`)).status, 200, "now members read it");
});
