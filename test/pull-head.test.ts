// How compare and new pull request URLs name a head: refs here (agent forks too), owner:branch, or headRepo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headSearch, ownerRepo, parseHead } from "../app/lib/pull-head.ts";

test("task:<id> stays an agent fork here, not an owner called task", () => {
	assert.deepEqual(parseHead("task:t1a2b3"), { branch: "task:t1a2b3" });
	assert.deepEqual(parseHead("feature/x"), { branch: "feature/x" });
	assert.deepEqual(parseHead("Bob:feature/x"), { owner: "bob", branch: "feature/x" });
	assert.deepEqual(parseHead("bob:"), { owner: "bob", branch: undefined });
	assert.deepEqual(parseHead(undefined), {});
});

test("owner: picks that owner's only readable repository, and says when there are none or several", () => {
	assert.deepEqual(ownerRepo([{ fullName: "bob/app" }]), { repo: "bob/app" });
	assert.deepEqual(ownerRepo([]), { problem: "unknown" });
	assert.deepEqual(ownerRepo([{ fullName: "ada/app" }, { fullName: "ada/app-copy" }]), { problem: "ambiguous" });
});

test("picked heads go in the URL unambiguously", () => {
	assert.deepEqual(headSearch("ada/app", "ADA/app", "main"), { head: "main", headRepo: undefined });
	assert.deepEqual(headSearch("ada/app", "ada/app-copy", "main"), { head: "main", headRepo: "ada/app-copy" });
	assert.deepEqual(headSearch("ada/app", "bob/app", "trunk"), { head: "trunk", headRepo: "bob/app" });
});
