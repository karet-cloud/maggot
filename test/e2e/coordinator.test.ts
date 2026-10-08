// Runs the real Worker (vite dev --mode offline) against the local Artifacts stand-in with Artifacts'
// concurrent-fork failures simulated. Slower than the unit tests: npm run test:e2e
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { GitCredentials, Project, Task, TaskAccess } from "../../src/api.ts";
import { startLocalArtifacts } from "../../scripts/local-artifacts.ts";

let api = "";
let artifacts: Awaited<ReturnType<typeof startLocalArtifacts>>;
let worker: ChildProcess;
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
	worker = spawn("npx", ["vite", "dev", "--mode", "offline"], {
		env: { ...process.env, LOCAL_ARTIFACTS_URL: artifacts.url, MEGIT_PORT: String(port), CF_QUIET: "1" },
		stdio: ["ignore", "pipe", "pipe"],
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
	worker.kill("SIGINT");
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

	// The commands the dashboard shows, against a repo whose local branch isn't called main.
	const { json: creds } = await call<GitCredentials>("POST", `/projects/${project}/credentials`, {});
	const url = new URL(creds.remote);
	url.username = "x";
	url.password = creds.token.split("?expires=")[0];
	const dir = join(root, "pushed");
	const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: dir });
	await promisify(execFile)("git", ["init", "-q", "-b", "master", dir]);
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
