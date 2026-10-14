// Fork networks: where a pull request into a repository can come from, and who sees which forks.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ensureSchema, insertRepo, listNetwork, networkRoot, sameNetwork, type RepoRow } from "../src/db.ts";
import { d1Database } from "./sql.ts";

async function setup() {
	const database = d1Database(new DatabaseSync(":memory:"));
	await ensureSchema(database);
	const now = new Date().toISOString();
	for (const name of ["ada", "bob", "cy", "dee"]) {
		await database
			.prepare(`insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "username") values (?, ?, ?, 1, ?, ?, ?)`)
			.bind(name, name, `${name}@example.com`, now, now, name)
			.run();
	}
	let at = 0;
	const repo = async (id: string, owner: string, forkOf: string | null, visibility: "public" | "private" = "public") => {
		const row = { id, ownerId: owner, owner, name: "app", description: null, visibility, defaultBranch: owner === "ada" ? "main" : "trunk", createdAt: new Date(Date.parse(now) + at++).toISOString(), bytes: 0, forkOf } as RepoRow;
		await insertRepo(database, row, 100, 1e9);
	};
	// ada/app ← bob/app ← cy/app (a fork of a fork), and dee's private fork of ada/app; plus an unrelated repo.
	await repo("r-ada", "ada", null);
	await repo("r-bob", "bob", "r-ada");
	await repo("r-cy", "cy", "r-bob");
	await repo("r-dee", "dee", "r-ada", "private");
	await database.prepare(`insert into "repo" ("id", "ownerId", "owner", "name", "visibility", "defaultBranch", "createdAt") values ('r-other', 'bob', 'bob', 'other', 'public', 'main', ?)`).bind(now).run();
	return database;
}

test("a fork network is everything forked, at any depth, from the same root", async () => {
	const database = await setup();
	assert.equal(await networkRoot(database, "r-cy"), "r-ada");
	assert.equal(await networkRoot(database, "r-ada"), "r-ada");
	assert.ok(await sameNetwork(database, "r-ada", "r-cy"), "a fork of a fork");
	assert.ok(await sameNetwork(database, "r-cy", "r-dee"), "siblings' forks");
	assert.ok(!(await sameNetwork(database, "r-ada", "r-other")), "an unrelated repository");
});

test("listing a network shows the repository first, then the rest oldest first, private forks only to their readers", async () => {
	const database = await setup();
	const names = async (id: string, viewer: string | null) => (await listNetwork(database, id, viewer)).map((r) => r.owner);
	assert.deepEqual(await names("r-ada", null), ["ada", "bob", "cy"], "anonymous: public only");
	assert.deepEqual(await names("r-ada", "dee"), ["ada", "bob", "cy", "dee"], "dee sees her own private fork");
	assert.deepEqual(await names("r-cy", "bob"), ["cy", "ada", "bob"], "from a fork of a fork, the whole network");
	await database.prepare(`insert into "repo_collaborator" ("repoId", "userId", "permission", "state", "createdAt") values ('r-dee', 'ada', 'read', 'active', ?)`).bind(new Date().toISOString()).run();
	assert.deepEqual(await names("r-ada", "ada"), ["ada", "bob", "cy", "dee"], "a collaborator on the private fork sees it too");
	// A deleted fork in the middle splits the network.
	await database.prepare(`delete from "repo" where "id" = 'r-bob'`).run();
	assert.deepEqual(await names("r-cy", null), ["cy"]);
	assert.ok(!(await sameNetwork(database, "r-ada", "r-cy")));
});
