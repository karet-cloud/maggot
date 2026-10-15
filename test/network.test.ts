// Fork networks: where a pull request into a repository can come from, and who sees which forks.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createIssue, ensureSchema, getPull, hiddenHeads, insertRepo, listNetwork, listPulls, networkRoot, ownerInNetwork, sameNetwork, toPull, unreadableRepos, type RepoRow } from "../src/db.ts";
import { d1Database } from "./sql.ts";

const now = Date.parse("2026-10-01T00:00:00Z");

async function empty() {
	const database = d1Database(new DatabaseSync(":memory:"));
	await ensureSchema(database);
	for (const name of ["ada", "bob", "cy", "dee"]) {
		const at = new Date(now).toISOString();
		await database
			.prepare(`insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "username") values (?, ?, ?, 1, ?, ?, ?)`)
			.bind(name, name, `${name}@example.com`, at, at, name)
			.run();
	}
	let at = 0;
	const repo = async (id: string, owner: string, forkOf: string | null, { visibility = "public", name = "app" }: { visibility?: "public" | "private"; name?: string } = {}) => {
		const row = { id, ownerId: owner, owner, name, description: null, visibility, defaultBranch: "trunk", createdAt: new Date(now + at++).toISOString(), bytes: 0, forkOf } as RepoRow;
		await insertRepo(database, row, 100, 1e9);
		return row;
	};
	return { database, repo };
}

/** ada/app ← bob/app ← cy/app (a fork of a fork), dee's private fork of ada/app, and an unrelated bob/other. */
async function setup() {
	const { database, repo } = await empty();
	const rows = {
		ada: await repo("r-ada", "ada", null),
		bob: await repo("r-bob", "bob", "r-ada"),
		cy: await repo("r-cy", "cy", "r-bob"),
		dee: await repo("r-dee", "dee", "r-ada", { visibility: "private" }),
		other: await repo("r-other", "bob", null, { name: "other" }),
	};
	return { database, repo, rows };
}

test("a fork network is everything forked, at any depth, from the same root", async () => {
	const { database, rows } = await setup();
	assert.equal(await networkRoot(database, "r-cy"), "r-ada");
	assert.equal(await networkRoot(database, "r-ada"), "r-ada");
	assert.ok(await sameNetwork(database, rows.ada, rows.cy), "a fork of a fork");
	assert.ok(await sameNetwork(database, rows.cy, rows.dee), "siblings' forks");
	assert.ok(!(await sameNetwork(database, rows.ada, rows.other)), "an unrelated repository");
});

test("a long chain of forks is still one network, with one root", async () => {
	const { database, repo } = await empty();
	const chain: RepoRow[] = [await repo("c0", "ada", null)];
	for (let i = 1; i <= 40; i++) chain.push(await repo(`c${i}`, i % 2 ? "bob" : "cy", chain[i - 1].id, { name: `app${i}` }));
	for (const i of [16, 17, 40]) assert.equal(await networkRoot(database, `c${i}`), "c0", `c${i}'s root`);
	assert.ok(await sameNetwork(database, chain[17], chain[16]), "a fork and its parent");
	assert.ok(await sameNetwork(database, chain[40], chain[0]));
	assert.equal((await listNetwork(database, "c40", null, { limit: 500 })).length, 41);
});

test("listing a network shows the repository first, then the newest, private forks only to their readers", async () => {
	const { database } = await setup();
	const names = async (id: string, viewer: string | null, opts = {}) => (await listNetwork(database, id, viewer, opts)).map((r) => r.owner);
	assert.deepEqual(await names("r-ada", null), ["ada", "cy", "bob"], "anonymous: public only");
	assert.deepEqual(await names("r-ada", "dee"), ["ada", "dee", "cy", "bob"], "dee sees her own private fork");
	assert.deepEqual(await names("r-ada", null, { everything: true }), ["ada", "dee", "cy", "bob"], "the admin key sees everything");
	assert.deepEqual(await names("r-cy", "bob"), ["cy", "bob", "ada"], "from a fork of a fork, the whole network");
	assert.deepEqual(await names("r-ada", null, { query: "CY/" }), ["cy"], "searched by owner/name");
	await database.prepare(`insert into "repo_collaborator" ("repoId", "userId", "permission", "state", "createdAt") values ('r-dee', 'ada', 'read', 'active', ?)`).bind(new Date().toISOString()).run();
	assert.deepEqual(await names("r-ada", "ada"), ["ada", "dee", "cy", "bob"], "a collaborator on the private fork sees it too");
	// A deleted fork in the middle splits the network.
	await database.prepare(`delete from "repo" where "id" = 'r-bob'`).run();
	assert.deepEqual(await names("r-cy", null), ["cy"]);
	assert.equal(await networkRoot(database, "r-cy"), "r-cy");
});

test("owner:branch means that owner's one readable repository in the network, or is ambiguous", async () => {
	const { database, repo } = await setup();
	const owned = async (owner: string, viewer: string | null, everything = false) => (await ownerInNetwork(database, "r-ada", owner, viewer, everything)).map((r) => r.id);
	assert.deepEqual(await owned("BOB", null), ["r-bob"], "bob/other isn't in the network");
	assert.deepEqual(await owned("dee", "bob"), [], "a private fork is nobody else's to name");
	assert.deepEqual(await owned("dee", "dee"), ["r-dee"]);
	assert.deepEqual(await owned("dee", null, true), ["r-dee"], "unless it's the admin key asking");
	// ada forks her own repository under another name: ada: now names two, the base among them.
	await repo("r-ada2", "ada", "r-bob", { name: "app-copy" });
	assert.deepEqual(await owned("ada", null), ["r-ada", "r-ada2"]);
});

test("pull requests from a private fork don't name it to people who can't read it", async () => {
	const { database } = await setup();
	await createIssue(database, "r-ada", "dee", "From dee", "", [], { headRepoId: "r-dee", headBranch: "secret-plan", baseBranch: "trunk" });
	await createIssue(database, "r-ada", "bob", "From bob", "", [], { headRepoId: "r-bob", headBranch: "open-plan", baseBranch: "trunk" });
	const heads = async (viewer: string | null, everything = false) =>
		(await listPulls(database, "r-ada", { viewerId: viewer, everything }, { state: "all" })).pulls.map((p) => `${p.headRepo}:${p.head}`);
	assert.deepEqual(await heads(null), ["bob/app:open-plan", "(private fork):"]);
	assert.deepEqual(await heads("ada"), ["bob/app:open-plan", "(private fork):"], "owning the base isn't reading the fork");
	assert.deepEqual(await heads("dee"), ["bob/app:open-plan", "dee/app:secret-plan"]);
	assert.deepEqual(await heads(null, true), ["bob/app:open-plan", "dee/app:secret-plan"]);
	const pull = (await getPull(database, "r-ada", 1))!;
	const shown = toPull(pull, { edit: false, label: false, merge: false }, { review: false, checks: false }, await hiddenHeads(database, [pull], { viewerId: "bob" }));
	assert.deepEqual([shown.headRepo, shown.head], ["(private fork)", ""]);
});


test("head access uses current view permissions and hides deleted repositories", async () => {
	const { database } = await setup();
	assert.deepEqual(await unreadableRepos(database, ["r-ada", "r-dee", "gone", "r-dee"], { viewerId: "ada" }), new Set(["r-dee", "gone"]));
	assert.deepEqual(await unreadableRepos(database, ["r-dee"], { viewerId: "dee" }), new Set());
	assert.deepEqual(await unreadableRepos(database, ["r-dee"], { viewerId: null }), new Set(["r-dee"]), "webhooks have no viewer");
	assert.deepEqual(await unreadableRepos(database, ["r-dee"], { viewerId: null, everything: true }), new Set());
	await database.prepare(`insert into "repo_collaborator" ("repoId", "userId", "permission", "state", "createdAt") values ('r-dee', 'ada', 'read', 'active', ?)`).bind(new Date().toISOString()).run();
	assert.deepEqual(await unreadableRepos(database, ["r-dee"], { viewerId: "ada" }), new Set(), "view, not edit, is sufficient");
	await database.prepare(`delete from "repo" where "id" = 'r-dee'`).run();
	assert.deepEqual(await unreadableRepos(database, ["r-dee"], { viewerId: "dee" }), new Set(["r-dee"]));
});
