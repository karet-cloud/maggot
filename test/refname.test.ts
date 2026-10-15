import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGitBranchName, MAX_BRANCH_BYTES } from "../src/git/refname.ts";

describe("isGitBranchName", () => {
	it("accepts what git check-ref-format --branch accepts", () => {
		for (const name of ["master", "release+2026", "feature/x", "a.b", "v1.2.3", "a@b", "x=y", "ünïcode", "a,b", "a#b", "a{b}", "@x", "a-", "_"]) {
			assert.ok(isGitBranchName(name), name);
		}
	});

	it("rejects what git rejects", () => {
		const bad = [
			"",
			"a b",
			"a\tb",
			"a\nb",
			"a\u0000b",
			"a\u007fb",
			"a~b",
			"a^b",
			"a:b",
			"a?b",
			"a*b",
			"a[b",
			"a\\b",
			"a..b",
			"a@{b",
			"/a",
			"a/",
			"a//b",
			".a",
			"a/.b",
			"a.",
			"a.lock",
			"a.lock/b",
			"@",
			"-a",
			"HEAD",
			"\ud800",
		];
		for (const name of bad) assert.equal(isGitBranchName(name), false, JSON.stringify(name));
	});

	it("caps the length in bytes", () => {
		assert.ok(isGitBranchName("a".repeat(MAX_BRANCH_BYTES)));
		assert.equal(isGitBranchName("a".repeat(MAX_BRANCH_BYTES + 1)), false);
		assert.equal(isGitBranchName("é".repeat(MAX_BRANCH_BYTES / 2 + 1)), false);
	});
});
