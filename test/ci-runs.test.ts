// The Actions run engine (src/ci/runs.ts) against a real SQLite (node:sqlite standing in for a Durable
// Object's storage), an in-memory repository store and stand-in job objects: no sandboxes, no Depot.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { CiRuns, type CiHost, type JobStub, type PullTrigger } from "../src/ci/runs.ts";
import type { JobLaunch, JobReport } from "../src/ci/job.ts";
import { sealSecret, verifyCheckoutToken } from "../src/ci/token.ts";
import { HttpError } from "../src/errors.ts";

const API_KEY = "test-api-key";
const REPO = "repo-1";
const FORK = "fork-1";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

/** SqlStorage's cursor, as far as runs.ts uses it. */
function sqlStorage(db: DatabaseSync): SqlStorage {
	const cursor = (rows: Record<string, unknown>[], written: number) => ({
		toArray: () => rows,
		one: () => {
			if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
			return rows[0];
		},
		rowsWritten: written,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	});
	return {
		exec(query: string, ...params: unknown[]) {
			if (params.length === 0 && query.split(";").filter((q) => q.trim()).length > 1) {
				db.exec(query);
				return cursor([], 0);
			}
			const stmt = db.prepare(query);
			const args = params as (string | number | null)[];
			if (stmt.columns().length > 0) {
				const rows = stmt.all(...args) as Record<string, unknown>[];
				return cursor(rows, /^\s*(INSERT|UPDATE|DELETE)/i.test(query) ? rows.length : 0);
			}
			return cursor([], Number(stmt.run(...args).changes));
		},
	} as unknown as SqlStorage;
}

type Files = Record<string, string>;

/** Repositories as commits (`sha` → workflow files in .megit/workflows) and branches (`refs[repo][branch]` → sha). */
function memoryStore(repos: Record<string, Record<string, Files>>, refs: Record<string, Record<string, string>>, failGet: { n: number }) {
	return {
		async get(name: string) {
			if (failGet.n > 0) {
				failGet.n--;
				throw new Error("storage unavailable");
			}
			const commits = repos[name];
			if (!commits) throw new Error(`no repository ${name}`);
			return {
				async log({ ref }: { ref?: string }) {
					const sha = ref && (commits[ref] ? ref : refs[name]?.[ref]);
					return sha && commits[sha] ? [{ hash: sha, treeHash: `root:${sha}` }] : [];
				},
				async readTree(hash: string) {
					const [kind, sha] = hash.split(":");
					const files = commits[sha];
					if (kind === "root") return [{ name: ".megit", type: "tree", hash: `megit:${sha}` }];
					if (kind === "megit") return [{ name: "workflows", type: "tree", hash: `wf:${sha}` }];
					if (kind === "wf") return Object.keys(files).map((f) => ({ name: f, type: "blob", hash: `file:${sha}:${f}` }));
					return null;
				},
				async readBlob(hash: string) {
					const [, sha, file] = hash.split(":");
					return new Blob([commits[sha][file]]);
				},
				[Symbol.dispose]() {},
			};
		},
	};
}

interface Harness {
	ci: CiRuns;
	db: DatabaseSync;
	starts: JobLaunch[];
	cancels: string[];
	events: Record<string, unknown>[];
	failStart: { n: number };
	failCancel: { n: number };
	failGet: { n: number };
	/** Branch heads, `refs[repo][branch]`; tests move them as pushes would. */
	refs: Record<string, Record<string, string>>;
	archived: { on: boolean };
}

function harness(repos: Record<string, Record<string, Files>>, env: { MEGIT_CI_CLOUDFLARE?: string } = {}): Harness {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const h = {
		db,
		starts: [] as JobLaunch[],
		cancels: [] as string[],
		events: [] as Record<string, unknown>[],
		failStart: { n: 0 },
		failCancel: { n: 0 },
		failGet: { n: 0 },
		refs: {} as Record<string, Record<string, string>>,
		archived: { on: false },
	};
	const job = (id: string): JobStub => ({
		async start(launch) {
			if (h.failStart.n > 0) {
				h.failStart.n--;
				throw new Error("object unreachable");
			}
			h.starts.push(launch);
		},
		async cancel() {
			if (h.failCancel.n > 0) {
				h.failCancel.n--;
				throw new Error("object unreachable");
			}
			h.cancels.push(id);
		},
	});
	const host: CiHost = {
		sql: sqlStorage(db),
		env: { MEGIT_API_KEY: API_KEY, ...env },
		store: memoryStore(repos, h.refs, h.failGet) as unknown as CiHost["store"],
		job,
		repoId: () => REPO,
		repository: () => ({ fullName: "alice/app", url: "https://megit.test/alice/app", cloneUrl: "https://megit.test/alice/app.git", defaultBranch: "main" }),
		emit: (data) => h.events.push(data),
		wake: async () => {},
		archived: () => h.archived.on,
	};
	return { ...h, ci: new CiRuns(host) };
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Depot's ListSandboxes answers OK, so a token can be saved without reaching Depot. */
async function withDepot(h: Harness) {
	globalThis.fetch = (async (url: string | URL) => {
		assert.match(String(url), /depot\.sandbox\.v1\.SandboxService\/ListSandboxes$/);
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	await h.ci.setDepot({ token: "depot-token", orgId: "org1" });
	globalThis.fetch = realFetch;
}

const report = (over: Partial<JobReport> & { seq?: number }): JobReport & { seq?: number } => ({
	status: "in_progress",
	conclusion: null,
	error: null,
	steps: [],
	logs: [],
	startedAt: new Date().toISOString(),
	finishedAt: null,
	...over,
});

const done = (conclusion: "success" | "failure", seq?: number) => report({ status: "completed", conclusion, finishedAt: new Date().toISOString(), seq });

const BUILD = `
name: Build
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
env:
  TOKEN: \${{ secrets.TOKEN }}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "\${{ secrets.TOKEN }} at \${{ github.sha }}"
  test:
    needs: build
    runs-on: depot-4
    steps:
      - run: npm test
`;

test("settings: without a Cloudflare container Depot is the default runner, and Cloudflare can't be chosen", async () => {
	const h = harness({ [REPO]: {} });
	const s = h.ci.getSettings();
	assert.equal(s.cloudflareAvailable, false);
	assert.equal(s.defaultRunner, "depot");
	assert.deepEqual(s.depot, { configured: false, orgId: null });
	assert.throws(() => h.ci.setDefaultRunner("cloudflare"), (e: HttpError) => e.code === "CLOUDFLARE_UNAVAILABLE");
	assert.throws(() => h.ci.setDefaultRunner("gpu"), (e: HttpError) => e.code === "INVALID_INPUT");
	const on = harness({ [REPO]: {} }, { MEGIT_CI_CLOUDFLARE: "on" });
	assert.equal(on.ci.getSettings().defaultRunner, "cloudflare");
	assert.equal(on.ci.setDefaultRunner("depot").defaultRunner, "depot");
});

test("settings: secrets and the Depot token are encrypted at rest, and their values never come back", async () => {
	const h = harness({ [REPO]: {} });
	await h.ci.setSecret("TOKEN", "hunter2-secret");
	await assert.rejects(h.ci.setSecret("GITHUB_TOKEN", "x"), (e: HttpError) => e.code === "INVALID_INPUT");
	await assert.rejects(h.ci.setSecret("1BAD", "x"), (e: HttpError) => e.code === "INVALID_INPUT");
	await withDepot(h);
	const stored = JSON.stringify(h.db.prepare("SELECT * FROM ci_secrets").all()) + JSON.stringify(h.db.prepare("SELECT * FROM meta").all());
	assert.ok(!stored.includes("hunter2-secret") && !stored.includes("depot-token"), "nothing is kept in the clear");
	const s = h.ci.getSettings();
	assert.deepEqual(s.secrets, ["TOKEN"]);
	assert.deepEqual(s.depot, { configured: true, orgId: "org1" });
	assert.ok(!JSON.stringify(s).includes("hunter2"));
	assert.equal(h.ci.removeDepot().depot.configured, false);
	assert.deepEqual(h.ci.deleteSecret("TOKEN").secrets, []);
	assert.throws(() => h.ci.deleteSecret("TOKEN"), (e: HttpError) => e.status === 404);
});

test("settings: a token Depot refuses isn't kept", async () => {
	const h = harness({ [REPO]: {} });
	globalThis.fetch = (async () => new Response(JSON.stringify({ code: "unauthenticated", message: "bad token" }), { status: 401 })) as unknown as typeof fetch;
	await assert.rejects(h.ci.setDepot({ token: "nope" }), (e: HttpError) => e.code === "DEPOT_REJECTED" && /bad token/.test(e.detail));
	assert.equal(h.ci.getSettings().depot.configured, false);
});

test("push: matching workflows run from the pushed commit, broken files fail visibly, and a repeated trigger starts nothing twice", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD, "docs.yml": "on:\n  push:\n    branches: [docs]\njobs:\n  x:\n    steps:\n      - run: echo ok\n", "bad.yml": "on: push\njobs: {}\n" } } });
	await withDepot(h);
	await h.ci.setSecret("TOKEN", "s3cret-value");
	const runs = await h.ci.onPush("main", SHA, "alice");
	assert.deepEqual(runs.map((r) => [r.path, r.status]).sort(), [
		[".megit/workflows/bad.yml", "completed"],
		[".megit/workflows/build.yml", "in_progress"],
	]);
	const bad = runs.find((r) => r.path.endsWith("bad.yml"))!;
	assert.equal(bad.conclusion, "failure");
	assert.ok(bad.error);
	assert.equal(h.events.length, 1, "the broken run is announced");
	assert.equal((await h.ci.onPush("main", SHA, "alice")).length, 0, "the same push again starts nothing");

	// Only the first job starts: the second needs it.
	assert.equal(h.starts.length, 1);
	const launch = h.starts[0];
	assert.equal(launch.repo, REPO);
	assert.deepEqual(launch.runner, { kind: "depot", vcpus: 2, credentials: { token: "depot-token", orgId: "org1" } });
	assert.equal(launch.steps[1].run, `echo "s3cret-value at ${SHA}"`);
	assert.equal(launch.env.TOKEN, "s3cret-value");
	assert.deepEqual(launch.mask, ["s3cret-value"]);
	assert.equal(launch.checkout.sha, SHA);
	assert.equal(launch.checkout.url, "https://megit.test/alice/app.git");
	const token = atob(launch.checkout.auth).slice(2);
	const grant = await verifyCheckoutToken(API_KEY, token);
	assert.deepEqual(grant?.repos, [REPO], "the checkout token reads this repository only");
	assert.ok(grant!.expires <= Date.now() + 30 * 60_000, "and expires once the checkout should be over, whatever the job's time limit");
});

test("needs: a job starts when what it needs succeeds, and is skipped when that fails", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD }, [SHA2]: { "build.yml": BUILD } } });
	await withDepot(h);
	const [run] = await h.ci.onPush("main", SHA, null);
	const build = h.ci.getRun(run.number).jobs.find((j) => j.key === "build")!;
	await h.ci.report(build.id, done("success", 1));
	assert.equal(h.starts.length, 2);
	assert.deepEqual(h.starts[1].runner, { kind: "depot", vcpus: 4, credentials: { token: "depot-token", orgId: "org1" } });
	const test2 = h.ci.getRun(run.number).jobs.find((j) => j.key === "test")!;
	await h.ci.report(test2.id, done("success", 1));
	const finished = h.ci.getRun(run.number);
	assert.equal(finished.status, "completed");
	assert.equal(finished.conclusion, "success");
	assert.equal(h.events.length, 1);

	const [second] = await h.ci.onPush("main", SHA2, null);
	const b2 = h.ci.getRun(second.number).jobs.find((j) => j.key === "build")!;
	await h.ci.report(b2.id, done("failure", 1));
	const failed = h.ci.getRun(second.number);
	assert.equal(failed.conclusion, "failure");
	assert.equal(failed.jobs.find((j) => j.key === "test")!.conclusion, "skipped");
	assert.equal(h.starts.length, 3, "the skipped job never started");
});

test("a job that can't run fails with the reason: no Depot token", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD } } });
	const [run] = await h.ci.onPush("main", SHA, null);
	const detail = h.ci.getRun(run.number);
	assert.equal(detail.conclusion, "failure");
	assert.match(detail.jobs[0].error ?? "", /no Depot token/);
	assert.equal(h.starts.length, 0);
});

test("reports: one delivered twice keeps its log once, and logs page with a cursor until the job is done", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD } } });
	await withDepot(h);
	const [run] = await h.ci.onPush("main", SHA, null);
	const job = h.ci.getRun(run.number).jobs[0];
	const first = report({ seq: 1, logs: [{ step: 0, text: "hello\n" }] });
	assert.deepEqual(await h.ci.report(job.id, first), { cancel: false });
	assert.deepEqual(await h.ci.report(job.id, first), { cancel: false }, "a retry of the same report");
	await h.ci.report(job.id, report({ seq: 2, logs: [{ step: 1, text: "world\n" }] }));
	const page = h.ci.logs(run.number, "build");
	assert.deepEqual(page.logs.map((l) => l.text), ["hello\n", "world\n"]);
	assert.equal(page.next, page.logs[1].seq, "still running: keep polling from here");
	assert.deepEqual(h.ci.logs(run.number, job.id, page.next!).logs, []);
	await h.ci.report(job.id, done("success", 3));
	assert.equal(h.ci.logs(run.number, "build", page.next!).next, null, "finished and fully read");
	assert.throws(() => h.ci.logs(run.number, "nope"), (e: HttpError) => e.status === 404);
	assert.deepEqual(await h.ci.report("no-such-job", first), { cancel: true });
});

test("forks: a fork's pull request waits for approval and never gets secrets; a newer commit cancels older runs", async () => {
	const h = harness({ [REPO]: {}, [FORK]: { [SHA]: { "build.yml": BUILD }, [SHA2]: { "build.yml": BUILD } } });
	await withDepot(h);
	await h.ci.setSecret("TOKEN", "s3cret-value");
	const pull = { number: 7, headRepo: FORK, cloneUrl: "https://megit.test/mallory/app.git", branch: "feature", baseBranch: "main", fromFork: true, actor: "mallory", action: "opened" as const };
	const [waiting] = await h.ci.onPull({ ...pull, sha: SHA });
	assert.equal(waiting.status, "waiting");
	assert.equal(waiting.fromFork, true);
	assert.equal(h.starts.length, 0, "nothing runs before approval");
	const checks = await h.ci.pullChecks({ number: 7, base: "main", headRepo: FORK, sha: SHA });
	assert.equal(checks.state, "waiting");
	assert.match(checks.reason ?? "", /waiting for approval/);

	const approved = await h.ci.approve(waiting.number);
	assert.equal(approved.status, "in_progress");
	const launch = h.starts[0];
	assert.equal(launch.env.TOKEN, "", "secrets are empty for a fork");
	assert.equal(launch.steps[1].run, `echo " at ${SHA}"`);
	assert.deepEqual(launch.mask, []);
	assert.equal(launch.checkout.url, pull.cloneUrl);
	assert.deepEqual((await verifyCheckoutToken(API_KEY, atob(launch.checkout.auth).slice(2)))?.repos, [FORK]);
	await assert.rejects(h.ci.approve(waiting.number), (e: HttpError) => e.code === "NOT_WAITING");

	const [newer] = await h.ci.onPull({ ...pull, sha: SHA2 });
	assert.equal(h.ci.getRun(waiting.number).conclusion, "cancelled");
	assert.deepEqual(h.cancels, [h.ci.getRun(waiting.number).jobs[0].id], "the running job was told to stop");
	assert.equal(newer.status, "waiting");
	// Someone who can merge opened it: no approval needed (still no secrets).
	const h2 = harness({ [REPO]: {}, [FORK]: { [SHA]: { "build.yml": BUILD } } });
	await withDepot(h2);
	const [trusted] = await h2.ci.onPull({ ...pull, sha: SHA, approved: true });
	assert.equal(trusted.status, "in_progress");
	assert.equal(h2.starts[0].env.TOKEN, "");
});

test("cancel and rerun: a lost cancel is retried, a cancelled job's later reports are told to stop, and a rerun starts afresh", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD } } });
	await withDepot(h);
	const [run] = await h.ci.onPush("main", SHA, null);
	const job = h.ci.getRun(run.number).jobs[0];
	h.failCancel.n = 1;
	const cancelled = await h.ci.cancel(run.number);
	assert.equal(cancelled.status, "completed");
	assert.equal(cancelled.conclusion, "cancelled");
	assert.deepEqual(h.cancels, []);
	assert.ok(h.ci.busy(), "the cancel is still owed");
	await h.ci.tick();
	assert.deepEqual(h.cancels, [job.id]);
	assert.deepEqual(await h.ci.report(job.id, report({ seq: 5 })), { cancel: true });
	await assert.rejects(h.ci.cancel(run.number), (e: HttpError) => e.code === "COMPLETED");

	const again = await h.ci.rerun(run.number, "bob");
	assert.notEqual(again.number, run.number);
	assert.equal(again.actor, "bob");
	assert.equal(again.status, "in_progress");
	assert.equal(h.starts.length, 2);
	await assert.rejects(h.ci.rerun(again.number, "bob"), (e: HttpError) => e.code === "IN_PROGRESS");
});

test("recovery: an unreachable job object is retried, and a job that goes silent is given up on", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD } } });
	await withDepot(h);
	h.failStart.n = 1;
	const [run] = await h.ci.onPush("main", SHA, null);
	assert.equal(h.starts.length, 0);
	assert.equal(h.ci.getRun(run.number).jobs[0].status, "in_progress");
	await h.ci.tick();
	assert.equal(h.starts.length, 1, "started on the next tick");
	await h.ci.tick();
	assert.equal(h.starts.length, 1, "and only once");

	h.db.prepare("UPDATE ci_jobs SET reported_at = ?").run(Date.now() - 60 * 60_000);
	await h.ci.tick();
	const detail = h.ci.getRun(run.number);
	assert.equal(detail.conclusion, "failure");
	assert.match(detail.jobs[0].error ?? "", /stopped reporting/);
	assert.ok(h.cancels.includes(detail.jobs[0].id), "its sandbox is asked to stop");

	const h2 = harness({ [REPO]: { [SHA]: { "build.yml": BUILD } } });
	await withDepot(h2);
	h2.failStart.n = 100;
	const [doomed] = await h2.ci.onPush("main", SHA, null);
	for (let i = 0; i < 5; i++) await h2.ci.tick();
	assert.match(h2.ci.getRun(doomed.number).jobs[0].error ?? "", /couldn't be started/);
});

test("concurrency: at most four jobs run at once per repository; the rest start as others finish", async () => {
	const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`w${i}.yml`, "on: push\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: echo ok\n"]));
	const h = harness({ [REPO]: { [SHA]: many } });
	await withDepot(h);
	const runs = await h.ci.onPush("main", SHA, null);
	assert.equal(runs.length, 6);
	assert.equal(h.starts.length, 4);
	await h.ci.report(h.starts[0].jobId, done("success"));
	assert.equal(h.starts.length, 5);
});

const sha = (n: number) => n.toString(16).padStart(40, "0");
const PR_ONLY = "name: PR\non:\n  pull_request:\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: echo ok\n";
const PUSH_ONLY = "name: Lint\non: push\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: echo ok\n";
const OPENED_ONLY = "name: Opened\non:\n  pull_request:\n    types: [opened]\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: echo ok\n";
const BASE = sha(0xb);

/** A pull request event from branch `topic` into main; approved (a writer's) unless said otherwise. */
const pr = (over: Partial<PullTrigger> & { sha: string }): PullTrigger => ({
	number: 1,
	headRepo: null,
	cloneUrl: "https://megit.test/alice/app.git",
	branch: "topic",
	baseBranch: "main",
	fromFork: false,
	actor: "alice",
	author: "alice",
	action: "opened",
	approved: true,
	...over,
});

/** Reports every running job finished. */
async function finishAll(h: Harness, conclusion: "success" | "failure") {
	for (const { id } of h.db.prepare("SELECT id FROM ci_jobs WHERE status = 'in_progress'").all() as { id: string }[]) await h.ci.report(id, done(conclusion));
}

const checks = (h: Harness, head: string, number = 1, headRepo: string | null = null) => h.ci.pullChecks({ number, base: "main", headRepo, sha: head });

test("dispatch runs only workflows that allow it, and runs page newest first", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD, "push.yml": PUSH_ONLY } } });
	await withDepot(h);
	await assert.rejects(h.ci.dispatch(".megit/workflows/push.yml", "main", SHA, "alice"), (e: HttpError) => e.code === "INVALID_INPUT");
	await assert.rejects(h.ci.dispatch(".megit/workflows/none.yml", "main", SHA, "alice"), (e: HttpError) => e.status === 404);
	const [manual] = await h.ci.dispatch(".megit/workflows/build.yml", "main", SHA, "alice");
	assert.equal(manual.event, "workflow_dispatch");
	assert.deepEqual(
		(await h.ci.listWorkflows(SHA)).map((w) => [w.path, w.dispatch]),
		[
			[".megit/workflows/build.yml", true],
			[".megit/workflows/push.yml", false],
		],
	);
	const [second] = await h.ci.dispatch(".megit/workflows/build.yml", "main", SHA, "alice");
	const list = h.ci.listRuns({ sha: SHA, limit: 1 });
	assert.deepEqual([list.runs[0].number, list.next], [second.number, second.number]);
	assert.equal(h.ci.listRuns({ before: list.next!, sha: SHA }).runs[0].number, manual.number);
});

test("pull request checks: a failing push run on the head shows and blocks; a passing unrelated run doesn't hide a missing required one", async () => {
	const H = sha(1);
	const h = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [H]: { "pr.yml": PR_ONLY, "lint.yml": PUSH_ONLY } } });
	h.refs[REPO] = { main: BASE, topic: H };
	await withDepot(h);
	await h.ci.onPush("topic", H, "alice");
	await finishAll(h, "failure");
	let c = await checks(h, H);
	assert.equal(c.state, "failure");
	assert.deepEqual(c.runs.map((r) => [r.workflow, r.event]), [["Lint", "push"]], "the push run is counted, not only the pull request's");
	assert.match(c.reason ?? "", /Actions failed on 0000000 \(Lint\)/);

	// The push run passes this time, but the pull request's own required run never started.
	const h2 = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [H]: { "pr.yml": PR_ONLY, "lint.yml": PUSH_ONLY } } });
	h2.refs[REPO] = { main: BASE, topic: H };
	await withDepot(h2);
	await h2.ci.onPush("topic", H, "alice");
	await finishAll(h2, "success");
	c = await checks(h2, H);
	assert.deepEqual([c.state, c.missing], ["missing", [".megit/workflows/pr.yml"]]);
	assert.match(c.reason ?? "", /pr\.yml hasn't run/);
	// A writer starts what's missing. The pull request's event never arrived, so nothing vouches for its
	// code: the run waits for approval like a reader's would.
	await h2.ci.startPull(pr({ sha: H }), c.missing);
	assert.equal((await checks(h2, H)).state, "waiting");
	await h2.ci.approve(h2.ci.listRuns({ pull: 1 }).runs[0].number);
	assert.equal((await checks(h2, H)).state, "pending");
	await finishAll(h2, "success");
	c = await checks(h2, H);
	assert.deepEqual([c.state, c.reason, c.missing], ["success", null, []]);
});

test("pull request checks: types [opened] is required on the head it was opened at, not on later ones", async () => {
	const [H1, H2, H3] = [sha(1), sha(2), sha(3)];
	const files = { "opened.yml": OPENED_ONLY };
	const h = harness({ [REPO]: { [BASE]: files, [H1]: files, [H2]: files, [H3]: files } });
	h.refs[REPO] = { main: BASE, topic: H1 };
	await withDepot(h);
	await h.ci.queuePull(pr({ sha: H1, action: "opened" }));
	assert.equal((await checks(h, H1)).state, "pending");
	await finishAll(h, "success");
	assert.equal((await checks(h, H1)).reason, null);

	h.refs[REPO].topic = H2;
	await h.ci.queuePull(pr({ sha: H2, action: "synchronize" }));
	const c = await checks(h, H2);
	assert.deepEqual([c.state, c.missing, c.reason], ["none", [], null], "nothing runs for new commits, and nothing is waited for");
	// A head whose event was lost counts as new commits too: no dead end.
	assert.equal((await checks(h, H3)).reason, null);
});

test("pull request checks: a head without the base's required workflow runs the base's definition", async () => {
	const H = sha(1);
	const h = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY } }, [FORK]: { [H]: {} } });
	h.refs[REPO] = { main: BASE };
	h.refs[FORK] = { topic: H };
	await withDepot(h);
	assert.match((await checks(h, H, 1, FORK)).reason ?? "", /pr\.yml hasn't run/, "deleting the file doesn't satisfy the rule");
	await h.ci.queuePull(pr({ sha: H, headRepo: FORK, fromFork: true, approved: false, author: "mallory" }));
	const [run] = h.ci.listRuns({ pull: 1 }).runs;
	assert.deepEqual([run.path, run.status, run.fromFork], [".megit/workflows/pr.yml", "waiting", true]);
	await h.ci.approve(run.number);
	assert.equal(h.starts[0].checkout.sha, H, "the fork's commit, checked out under the base's workflow");
	await finishAll(h, "success");
	assert.equal((await checks(h, H, 1, FORK)).reason, null);
	assert.equal((await h.ci.rerun(run.number, "alice")).path, ".megit/workflows/pr.yml", "a re-run uses the definition it ran with");
});

test("pull request events: one that fails is retried by the alarm; a late one for an older head can't cancel the current head's runs", async () => {
	const [A, B] = [sha(0xa), sha(0xc)];
	const files = { "pr.yml": PR_ONLY };
	const h = harness({ [REPO]: { [BASE]: files, [A]: files, [B]: files } });
	h.refs[REPO] = { main: BASE, topic: A };
	await withDepot(h);
	h.failGet.n = 1;
	await h.ci.queuePull(pr({ sha: A }));
	assert.equal(h.ci.listRuns({ pull: 1 }).runs.length, 0);
	assert.ok(h.ci.busy(), "kept for the alarm");
	await h.ci.tick();
	assert.equal(h.ci.listRuns({ pull: 1, sha: A }).runs.length, 1);

	h.refs[REPO].topic = B;
	await h.ci.queuePull(pr({ sha: B, action: "synchronize" }));
	const current = h.ci.listRuns({ pull: 1, sha: B }).runs[0];
	assert.equal(h.ci.listRuns({ pull: 1, sha: A }).runs[0].conclusion, "cancelled");
	// The event for A arrives again, late (a retried push, a slow "opened").
	await h.ci.queuePull(pr({ sha: A }));
	assert.equal(h.ci.getRun(current.number).status, "in_progress", "B's run carries on");
	assert.equal(h.ci.listRuns({ pull: 1, sha: A }).runs.length, 1, "and nothing new starts for A");
	assert.ok(!h.ci.busy() || h.db.prepare("SELECT COUNT(*) AS n FROM ci_pull_queue").get()!.n === 0, "the stale event is dropped, not retried");
});

test("approval: a reader's pull request waits even from a branch here; waiting runs are capped, cancelled on close, and expire", async () => {
	const files = { "pr.yml": PR_ONLY.replace("echo ok", "echo ${{ secrets.TOKEN }}") };
	const heads = Array.from({ length: 22 }, (_, i) => sha(0x100 + i));
	const h = harness({ [REPO]: Object.fromEntries([[BASE, files], ...heads.map((x) => [x, files])]) });
	h.refs[REPO] = { main: BASE, ...Object.fromEntries(heads.map((x, i) => [`b${i}`, x])) };
	await withDepot(h);
	await h.ci.setSecret("TOKEN", "s3cret-value");
	for (let i = 0; i < 21; i++) await h.ci.queuePull(pr({ number: i + 1, branch: `b${i}`, sha: heads[i], approved: false, author: "eve", actor: "eve" }));
	const waiting = h.ci.listRuns({ limit: 100 }).runs.filter((r) => r.status === "waiting");
	assert.equal(waiting.length, 20, "at most 20 waiting per author");
	assert.equal(h.starts.length, 0, "nothing ran on the repository's runner");
	const last = await checks(h, heads[20], 21);
	assert.equal(last.state, "missing", "past the cap, the run is left for a writer to start");
	// Approved, a same-repository pull request's run has the repository's secrets (its code was pushed by a writer).
	await h.ci.approve(waiting[0].number);
	assert.ok(h.starts[0].mask.includes("s3cret-value"));

	await h.ci.closePull(2, false);
	assert.equal(h.ci.listRuns({ pull: 2 }).runs[0].conclusion, "cancelled");
	h.db.prepare("UPDATE ci_runs SET created_at = ? WHERE status = 'waiting'").run(new Date(Date.now() - 8 * 86_400_000).toISOString());
	assert.ok(h.ci.waitingExpiry()! < Date.now());
	await h.ci.tick();
	assert.equal(h.ci.listRuns({ limit: 100 }).runs.filter((r) => r.status === "waiting").length, 0, "unapproved runs expire");
	// A closed pull request's late event starts nothing; reopening does.
	await h.ci.queuePull(pr({ number: 2, branch: "b1", sha: heads[1], approved: false, author: "eve", action: "synchronize" }));
	assert.equal(h.ci.listRuns({ pull: 2 }).runs.length, 1);
	await h.ci.queuePull(pr({ number: 2, branch: "b1", sha: heads[1], approved: true, action: "reopened" }));
	const [again, cancelled] = h.ci.listRuns({ pull: 2 }).runs;
	assert.deepEqual([cancelled.conclusion, again.status], ["cancelled", "in_progress"], "reopening (by a writer here) starts again what closing cancelled");
});

test("retention: only finished runs count toward the cap, and an open pull request's head keeps its runs", async () => {
	const many = Array.from({ length: 305 }, (_, i) => sha(0x1000 + i));
	const H = sha(1);
	const files = { "pr.yml": PR_ONLY, "lint.yml": PUSH_ONLY };
	const h = harness({ [REPO]: Object.fromEntries([[BASE, files], [H, files], ...many.map((x) => [x, { "lint.yml": PUSH_ONLY }])]) });
	h.refs[REPO] = { main: BASE, topic: H };
	await withDepot(h);
	await h.ci.queuePull(pr({ sha: H }));
	await finishAll(h, "success");
	// Readers' waiting runs don't push finished ones out.
	for (let i = 0; i < 5; i++) await h.ci.onPull(pr({ number: 50 + i, sha: H, branch: "topic", approved: false, author: `r${i}` }));
	for (const x of many) {
		await h.ci.onPush("main", x, null);
		await finishAll(h, "failure");
	}
	const completed = h.db.prepare("SELECT COUNT(*) AS n FROM ci_runs WHERE status = 'completed'").get()!.n as number;
	// 300, the run that was still going when the last prune ran, and the open pull request's.
	assert.equal(completed, 302);
	assert.equal((await checks(h, H)).reason, null, "the open pull request's passing run is still there");
	assert.equal(h.ci.listRuns({ sha: many[0] }).runs.length, 0, "the oldest unrelated run went");
});

test("archived: nothing new starts or dispatches, and cancelling still works", async () => {
	const h = harness({ [REPO]: { [SHA]: { "build.yml": BUILD }, [BASE]: { "build.yml": BUILD } } });
	h.refs[REPO] = { main: BASE, topic: SHA };
	await withDepot(h);
	h.failStart.n = 1;
	const [run] = await h.ci.onPush("main", SHA, null);
	assert.equal(h.starts.length, 0);
	h.archived.on = true;
	await h.ci.tick();
	assert.equal(h.starts.length, 0, "an undispatched job isn't handed to a runner");
	assert.equal(h.ci.getRun(run.number).jobs[0].conclusion, "cancelled");
	assert.deepEqual(await h.ci.onPush("main", BASE, null), []);
	await h.ci.queuePull(pr({ sha: SHA }));
	assert.equal(h.ci.listRuns({ pull: 1 }).runs.length, 0);
	await assert.rejects(h.ci.dispatch(".megit/workflows/build.yml", "main", SHA, "alice"), (e: HttpError) => e.code === "ARCHIVED");
	await assert.rejects(h.ci.rerun(run.number, "alice"), (e: HttpError) => e.code === "ARCHIVED");
	h.archived.on = false;
	const [other] = await h.ci.onPush("main", BASE, null);
	h.archived.on = true;
	await h.ci.cancelAll("The repository was archived");
	assert.equal(h.ci.getRun(other.number).conclusion, "cancelled");
});

test("secrets: values too short to hide in logs aren't accepted, and a job using an old one doesn't run", async () => {
	const uses = "on: push\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: deploy ${{ secrets.PIN }}\n";
	const h = harness({ [REPO]: { [SHA]: { "deploy.yml": uses } } });
	await withDepot(h);
	await assert.rejects(h.ci.setSecret("PIN", "ab"), (e: HttpError) => e.code === "INVALID_INPUT" && /at least 3/.test(e.detail));
	assert.deepEqual((await h.ci.setSecret("OK", "abc")).secrets, ["OK"], "3 characters are masked, so they're accepted");
	// Saved before the rule.
	h.db.prepare("INSERT INTO ci_secrets (name, value, updated_at) VALUES ('PIN', ?, '')").run(await sealSecret(API_KEY, REPO, "ab"));
	const [run] = await h.ci.onPush("main", SHA, null);
	const job = h.ci.getRun(run.number).jobs[0];
	assert.equal(job.conclusion, "failure");
	assert.match(job.error ?? "", /PIN is shorter than 3 characters/);
	assert.ok(!(job.error ?? "").includes("ab "));
	assert.equal(h.starts.length, 0);
});

const BROKEN = "name: [unclosed\n";

test("required fallback: a head that keeps the file but narrows its trigger runs the base's definition", async () => {
	// Review r2 R1: switched to push only.
	const H = sha(1);
	const h = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [H]: { "pr.yml": PUSH_ONLY } } });
	h.refs[REPO] = { main: BASE, topic: H };
	await withDepot(h);
	await h.ci.queuePull(pr({ sha: H }));
	const [run] = h.ci.listRuns({ pull: 1 }).runs;
	assert.deepEqual([run.path, run.workflow, run.status], [".megit/workflows/pr.yml", "PR", "in_progress"], "the base's PR workflow, not nothing");
	assert.equal((await checks(h, H)).state, "pending");

	// R2: narrowed to types [opened], then a new push.
	const [H1, H2] = [sha(2), sha(3)];
	const narrowed = OPENED_ONLY.replace("name: Opened", "name: Narrowed");
	const h2 = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [H1]: { "pr.yml": narrowed }, [H2]: { "pr.yml": narrowed } } });
	h2.refs[REPO] = { main: BASE, topic: H1 };
	await withDepot(h2);
	await h2.ci.queuePull(pr({ sha: H1 }));
	assert.equal(h2.ci.listRuns({ sha: H1 }).runs[0].workflow, "Narrowed", "on opened the head's own version runs");
	await finishAll(h2, "success");
	h2.refs[REPO].topic = H2;
	await h2.ci.queuePull(pr({ sha: H2, action: "synchronize" }));
	const [next] = h2.ci.listRuns({ sha: H2 }).runs;
	assert.deepEqual([next?.workflow, next?.path], ["PR", ".megit/workflows/pr.yml"], "on synchronize the base's runs instead");
	assert.deepEqual((await checks(h2, H2)).missing, []);
});

test("pull request events are acted on one drain at a time, so a slow drain for an older head can't undo a newer one", async () => {
	// Review r2 R3: the first drain's head read is held back while the head moves and a second event arrives.
	const [A, B] = [sha(0xa), sha(0xc)];
	const files = { "pr.yml": PR_ONLY };
	const h = harness({ [REPO]: { [BASE]: files, [A]: files, [B]: files } });
	h.refs[REPO] = { main: BASE, topic: A };
	await withDepot(h);
	const store = (h.ci as unknown as { host: CiHost }).host.store as unknown as { get(name: string): Promise<{ log(o: unknown): Promise<unknown> }> };
	const realGet = store.get.bind(store);
	let release: () => void = () => {};
	let hold = true;
	store.get = async (name: string) => {
		const repo = await realGet(name);
		if (hold) {
			hold = false;
			const log = repo.log.bind(repo);
			repo.log = async (o: unknown) => {
				const out = await log(o);
				await new Promise<void>((r) => (release = r));
				return out;
			};
		}
		return repo;
	};
	const first = h.ci.queuePull(pr({ sha: A }));
	await new Promise((r) => setTimeout(r, 10));
	h.refs[REPO].topic = B;
	const second = h.ci.queuePull(pr({ sha: B, action: "synchronize" }));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(h.ci.listRuns({ sha: B }).runs.length, 0, "B's event waits for the drain in progress");
	release();
	await Promise.all([first, second]);
	const [b] = h.ci.listRuns({ sha: B }).runs;
	assert.equal(b.status, "in_progress", "B's run carries on");
	assert.equal(h.ci.listRuns({ sha: A }).runs[0]?.conclusion ?? "cancelled", "cancelled");
	assert.deepEqual(h.db.prepare("SELECT sha FROM ci_pulls").all().map((r) => r.sha), [B]);
	assert.equal((await checks(h, B)).state, "pending");
});

test("unapproved runs (a fork's broken workflow files, expired waits) are capped apart and can't push writers' runs out", async () => {
	// Review r2 R4.
	const broken = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`b${i}.yml`, BROKEN]));
	const heads = Array.from({ length: 16 }, (_, i) => sha(0x500 + i));
	const M = sha(0x77);
	const h = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [M]: { "lint.yml": PUSH_ONLY } }, [FORK]: Object.fromEntries(heads.map((x) => [x, broken])) });
	h.refs[REPO] = { main: BASE };
	h.refs[FORK] = {};
	await withDepot(h);
	await h.ci.onPush("feature", M, "alice");
	await finishAll(h, "success");
	for (const x of heads) {
		h.refs[FORK].topic = x;
		await h.ci.queuePull(pr({ sha: x, headRepo: FORK, fromFork: true, approved: false, author: "mallory", action: "synchronize", number: 9 }));
	}
	const unapproved = h.db.prepare("SELECT COUNT(*) AS n FROM ci_runs WHERE status = 'completed' AND approved = 0").get()!.n;
	assert.ok((unapproved as number) <= 20 + 20, `kept ${unapproved}: at most 20 per author, plus the current head's`);
	assert.equal(h.ci.listRuns({ sha: M }).runs.length, 1, "the writer's push run is still there");
});

test("archived: queued pull request events are dropped, not turned into runs", async () => {
	// Review r2 R5.
	const H = sha(1);
	const h = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [H]: { "pr.yml": PR_ONLY } } });
	h.refs[REPO] = { main: BASE, topic: H };
	await withDepot(h);
	h.failGet.n = 1;
	await h.ci.queuePull(pr({ sha: H }));
	h.archived.on = true;
	await h.ci.tick();
	assert.deepEqual(h.ci.listRuns({}).runs, []);
	assert.equal(h.ci.busy(), false, "nothing keeps the alarm waking");
	// Archiving itself forgets them too.
	h.archived.on = false;
	h.failGet.n = 1;
	await h.ci.queuePull(pr({ sha: H }));
	await h.ci.cancelAll("The repository was archived");
	assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM ci_pull_queue").get()!.n, 0);
});

test("the launch's mask holds only the secrets the job uses", async () => {
	// Review r2 B1.
	const uses = "on: push\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: echo ${{ secrets.USED }}\n";
	const h = harness({ [REPO]: { [SHA]: { "u.yml": uses } } });
	await withDepot(h);
	await h.ci.setSecret("USED", "used-value");
	await h.ci.setSecret("PROD_DEPLOY_KEY", "unrelated-prod-key");
	await h.ci.onPush("main", SHA, null);
	assert.deepEqual(h.starts[0].mask, ["used-value"]);
	assert.ok(!JSON.stringify(h.starts[0]).includes("unrelated-prod-key"), "the unrelated secret isn't in the launch at all");
});

test("Start missing checks creates only the listed workflows, waiting for approval where the pull request's runs would", async () => {
	// UI review r2 finding 1: a fork author past the waiting cap, whose head changes pr.yml and adds a depot-64 workflow.
	const forkPr = "name: PR\non:\n  pull_request:\njobs:\n  j:\n    runs-on: depot\n    steps:\n      - run: echo fork-controlled-pr\n";
	const extra = "name: Extra\non:\n  pull_request:\njobs:\n  j:\n    runs-on: depot-64\n    steps:\n      - run: echo fork-added-workflow\n";
	const heads = Array.from({ length: 21 }, (_, i) => sha(0x300 + i));
	const H = heads[20];
	const h = harness({
		[REPO]: { [BASE]: { "pr.yml": PR_ONLY } },
		[FORK]: Object.fromEntries([...heads.slice(0, 20).map((x) => [x, { "pr.yml": PR_ONLY }]), [H, { "pr.yml": forkPr, "extra.yml": extra }]]),
	});
	h.refs[REPO] = { main: BASE };
	h.refs[FORK] = Object.fromEntries(heads.map((x, i) => [`b${i}`, x]));
	await withDepot(h);
	for (let i = 0; i < 20; i++) await h.ci.queuePull(pr({ number: i + 1, branch: `b${i}`, sha: heads[i], headRepo: FORK, fromFork: true, approved: false, author: "mallory" }));
	await h.ci.queuePull(pr({ number: 21, branch: "b20", sha: H, headRepo: FORK, fromFork: true, approved: false, author: "mallory" }));
	assert.equal(h.ci.listRuns({ pull: 21 }).runs.length, 0, "past the author's cap, nothing was created");
	const before = await checks(h, H, 21, FORK);
	assert.deepEqual(before.missing, [".megit/workflows/pr.yml"]);

	await h.ci.startPull(pr({ number: 21, branch: "b20", sha: H, headRepo: FORK, fromFork: true, actor: "alice", author: "mallory" }), before.missing);
	const runs = h.ci.listRuns({ pull: 21 }).runs;
	assert.deepEqual(
		runs.map((r) => [r.path, r.status]),
		[[".megit/workflows/pr.yml", "waiting"]],
		"only the listed workflow, waiting for approval; extra.yml isn't created",
	);
	assert.equal(h.starts.length, 0, "nothing was dispatched");
	assert.equal((await checks(h, H, 21, FORK)).state, "waiting");

	// A writer's own pull request whose required workflow arrived on the base later: Start runs it at once.
	const W = sha(0x400);
	const h2 = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY, "late.yml": PR_ONLY.replace("name: PR", "name: Late") }, [W]: { "pr.yml": PR_ONLY } } });
	h2.refs[REPO] = { main: BASE, topic: W };
	await withDepot(h2);
	h2.db.prepare("INSERT INTO ci_pulls (pull, sha, open, approved) VALUES (1, ?, 1, 1)").run(W);
	h2.db.prepare("INSERT INTO ci_pull_events (pull, sha, action) VALUES (1, ?, 'opened')").run(W);
	const missing = (await checks(h2, W)).missing;
	assert.deepEqual(missing, [".megit/workflows/late.yml", ".megit/workflows/pr.yml"]);
	await h2.ci.startPull(pr({ sha: W }), [".megit/workflows/late.yml"]);
	assert.deepEqual(h2.ci.listRuns({ pull: 1 }).runs.map((r) => [r.workflow, r.status]), [["Late", "in_progress"]]);
});

test("reopening a pull request starts the runs closing cancelled (waiting again for a reader's)", async () => {
	const H = sha(1);
	const h = harness({ [REPO]: { [BASE]: { "pr.yml": PR_ONLY }, [H]: { "pr.yml": PR_ONLY } } });
	h.refs[REPO] = { main: BASE, topic: H };
	await withDepot(h);
	await h.ci.queuePull(pr({ sha: H, approved: false, author: "eve", actor: "eve" }));
	await h.ci.closePull(1, false);
	assert.equal((await checks(h, H)).state, "failure", "closing cancelled it");
	await h.ci.queuePull(pr({ sha: H, action: "reopened", approved: false, author: "eve", actor: "eve" }));
	const c = await checks(h, H);
	assert.equal(c.state, "waiting");
	assert.equal(h.starts.length, 0);
});
