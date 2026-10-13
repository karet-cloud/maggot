// Runs the real Worker (vite dev --mode offline) against the local Artifacts stand-in with Artifacts'
// concurrent-fork failures simulated. Slower than the unit tests: npm run test:e2e
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
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
