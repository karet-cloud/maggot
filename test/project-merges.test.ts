// Exercise the coordinator's real merge slot and rule storage, with controlled Git and D1 awaits.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { BranchRule } from "../src/api.ts";
import { HttpError } from "../src/errors.ts";
import { Workspace } from "../src/git/workspace.ts";
import { sqlStorage } from "./sql.ts";

const workers = `data:text/javascript,${encodeURIComponent(`
export class DurableObject {
	constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}`)}`;
const hooks = registerHooks({
	resolve(specifier, context, next) {
		return specifier === "cloudflare:workers" ? { url: workers, shortCircuit: true } : next(specifier, context);
	},
});
const { ProjectCoordinator } = await import("../src/project.ts");
hooks.deregister();
Reflect.set(globalThis, "WebSocketRequestResponsePair", class {});

const HEAD = "a".repeat(40);
const MERGED = "b".repeat(40);
const input = { base: "master", headRepo: null, headBranch: "feature", method: "merge" as const, message: "Merge feature", author: { name: "t", email: "t@t" }, pull: 1 };
const rule = (patch: Partial<BranchRule> = {}): Omit<BranchRule, "createdAt"> => ({
	pattern: "master", blockDeletions: false, blockForcePushes: false, requireMergeQueue: false, requireReview: false, requireChecks: false, ...patch,
});
const gate = () => Promise.withResolvers<void>();
// Flush all runnable promise continuations without depending on a wall-clock delay.
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(t: TestContext) {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	const sql = sqlStorage(db);
	let approval = async () => ({ approved: 1 });
	const database = {
		prepare(query: string) {
			return { bind() { return this; }, async first() {
				return query.trimStart().startsWith('select 1 from "review"') ? approval() : { id: "pull-1", decision: "approved" };
			} };
		},
	};
	const project = new ProjectCoordinator({
		storage: { sql }, setWebSocketAutoResponse() {}, getWebSockets: () => [],
	} as unknown as DurableObjectState, { ARTIFACTS: {}, DB: database } as unknown as Env);
	const setDefault = (branch: string) => sql.exec("INSERT OR REPLACE INTO meta VALUES ('project', ?)", JSON.stringify({ name: "repo-1", defaultBranch: branch }));
	setDefault("master");
	let pushes = 0;
	let checks = 0;
	Reflect.set(project, "baseAccess", async () => ({ url: "https://git.test/repo", token: "token" }));
	Reflect.set(project, "credentials", async () => ({ remote: "https://git.test/fork", token: "token" }));
	Reflect.set(project, "pushed", async () => {});
	Reflect.set(project, "requestIndex", async () => {});
	Reflect.set(project, "startCi", async () => {});
	Reflect.set(project, "closeReferencedIssues", () => {});
	Reflect.set(project, "notifyOwner", () => {});
	const workspace = {
		syncBase: async () => "base",
		fetchTask: async () => HEAD,
		merge: async () => ({ kind: "merged", oid: MERGED, fastForward: false, changedFiles: ["change.txt"] }),
		push: async () => { pushes++; return true; },
	};
	Reflect.set(project, "workspace", workspace);
	t.mock.method(Workspace.prototype, "syncBase", (...args: unknown[]) => Reflect.apply(workspace.syncBase, workspace, args));
	t.mock.method(Workspace.prototype, "fetchTask", (...args: unknown[]) => Reflect.apply(workspace.fetchTask, workspace, args));
	t.mock.method(Workspace.prototype, "merge", (...args: unknown[]) => Reflect.apply(workspace.merge, workspace, args));
	t.mock.method(Workspace.prototype, "push", (...args: unknown[]) => Reflect.apply(workspace.push, workspace, args));
	Reflect.set(Reflect.get(project, "ci"), "pullChecks", async () => { checks++; return { reason: "Actions have not passed" }; });
	const mergeTask = (id: string): Promise<void> => Reflect.get(project, "mergeTask").call(project, id);
	const addTask = (id: string) => sql.exec("INSERT INTO tasks (id, title, status, repo, remote, created_at, updated_at) VALUES (?, ?, 'queued', 'fork', 'https://git.test/fork', '', '')", id, id);
	return { project, sql, workspace, setDefault, addTask, mergeTask, pushes: () => pushes, checks: () => checks, approve: (fn: typeof approval) => { approval = fn; } };
}

test("requiring checks during the final approval await waits for the merge, then protects the next merge", async (t) => {
	const h = harness(t);
	await h.project.setBranchRule(rule({ requireReview: true }));
	const entered = gate();
	const release = gate();
	t.after(() => release.resolve());
	h.approve(async () => { entered.resolve(); await release.promise; return { approved: 1 }; });
	const merging = h.project.mergePull(input);
	await entered.promise;
	let changed = false;
	const changing = h.project.setBranchRule(rule({ requireReview: true, requireChecks: true })).then(() => { changed = true; });
	await turn();
	assert.equal(changed, false, "rule updates must wait through the final approval query and push");
	assert.equal(h.pushes(), 0);
	release.resolve();
	await merging;
	await changing;
	assert.equal(h.pushes(), 1);
	await assert.rejects(h.project.mergePull(input), (err) => err instanceof HttpError && err.code === "CHECKS_REQUIRED");
	assert.equal(h.checks(), 1);
	assert.equal(h.pushes(), 1);
});

for (const operation of ["create", "delete"] as const) {
	test(`branch rule ${operation} waits for a merge's push`, async (t) => {
		const h = harness(t);
		if (operation === "delete") await h.project.setBranchRule(rule({ blockDeletions: true }));
		const entered = gate();
		const release = gate();
		t.after(() => release.resolve());
		h.workspace.push = async () => { entered.resolve(); await release.promise; return true; };
		const merging = h.project.mergePull(input);
		await entered.promise;
		let changed = false;
		const changing = (operation === "create" ? h.project.setBranchRule(rule({ requireReview: true })) : h.project.deleteBranchRule("master")).then(() => { changed = true; });
		await turn();
		assert.equal(changed, false);
		assert.equal((await h.project.getBranchRules()).length, operation === "create" ? 0 : 1);
		release.resolve();
		await Promise.all([merging, changing]);
		assert.equal((await h.project.getBranchRules()).length, operation === "create" ? 1 : 0);
	});
}

test("task merges waiting for the slot read rules after an earlier rule update", async (t) => {
	const h = harness(t);
	h.addTask("one");
	h.addTask("two");
	const entered = gate();
	const release = gate();
	t.after(() => release.resolve());
	h.workspace.fetchTask = async () => { entered.resolve(); await release.promise; return HEAD; };
	const first = h.mergeTask("one");
	await entered.promise;
	let changed = false;
	const changing = h.project.setBranchRule(rule({ requireChecks: true })).then(() => { changed = true; });
	const second = h.mergeTask("two");
	await turn();
	assert.equal(changed, false, "task merges must also hold rule changes until their push");
	release.resolve();
	await Promise.all([first, changing, second]);
	assert.deepEqual(h.sql.exec("SELECT id, status FROM tasks ORDER BY id").toArray().map((r) => [r.id, r.status]), [["one", "merged"], ["two", "failed"]]);
	assert.equal(h.pushes(), 1);
	assert.match(String(h.sql.exec("SELECT error FROM tasks WHERE id = 'two'").one().error), /requires Actions/);
});

test("mergePull decides default-branch status after acquiring the slot and before post-push awaits", async (t) => {
	const h = harness(t);
	const entered = gate();
	const release = gate();
	t.after(() => release.resolve());
	h.workspace.fetchTask = async () => { entered.resolve(); await release.promise; return HEAD; };
	const first = h.project.mergePull(input);
	await entered.promise;
	const second = h.project.mergePull(input);
	// Stand in for the separate default-branch change implementation; no API exists on this branch yet.
	h.setDefault("release");
	release.resolve();
	assert.equal((await first).onDefaultBranch, false);
	assert.equal((await second).onDefaultBranch, false);
	h.setDefault("master");
	Reflect.set(h.project, "pushed", async () => { h.setDefault("release"); });
	assert.equal((await h.project.mergePull(input)).onDefaultBranch, true, "post-push work cannot change the captured result");
});
