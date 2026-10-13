import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyMatch } from "../app/lib/fuzzy.ts";

const PATHS = [
	"README.md",
	"src/index.ts",
	"src/git/diff.ts",
	"src/git/protocol.ts",
	"app/routes/$owner.$repo.index.tsx",
	"app/components/diff.tsx",
	"test/diff.test.ts",
	"docs/introduction.md",
];

test("characters match in order, anywhere in the path", () => {
	assert.ok(fuzzyMatch("sgp", "src/git/protocol.ts"));
	assert.equal(fuzzyMatch("pgs", "src/git/protocol.ts"), null);
	assert.deepEqual(fuzzyMatch("diff", "src/git/diff.ts")?.positions, [8, 9, 10, 11]);
});

test("file names, word starts and runs rank first", () => {
	assert.equal(fuzzyFilter("diff", PATHS)[0].path, "src/git/diff.ts");
	assert.equal(fuzzyFilter("index", PATHS)[0].path, "src/index.ts");
	assert.equal(fuzzyFilter("proto", PATHS)[0].path, "src/git/protocol.ts");
	assert.equal(fuzzyFilter("cdiff", PATHS)[0].path, "app/components/diff.tsx");
	assert.equal(fuzzyFilter("README", PATHS)[0].path, "README.md");
});

test("an empty query lists paths as they are, and the limit holds", () => {
	assert.deepEqual(fuzzyFilter("", PATHS, 2).map((m) => m.path), PATHS.slice(0, 2));
	assert.equal(fuzzyFilter("t", PATHS, 3).length, 3);
	assert.deepEqual(fuzzyFilter("zzz", PATHS), []);
});
