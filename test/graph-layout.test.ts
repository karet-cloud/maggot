import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutGraph } from "../app/lib/graph-layout.ts";

test("a straight history stays in one lane", () => {
	const { rows, width } = layoutGraph([
		{ hash: "c", parents: ["b"] },
		{ hash: "b", parents: ["a"] },
		{ hash: "a", parents: [] },
	]);
	assert.equal(width, 1);
	assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
	assert.deepEqual(rows.map((r) => r.head), [true, false, false]);
});

test("a merge opens a lane for its second parent, which joins back where the branch started", () => {
	// m merges f into the mainline; f branched from a.
	const { rows, width } = layoutGraph([
		{ hash: "m", parents: ["b", "f"] },
		{ hash: "f", parents: ["a"] },
		{ hash: "b", parents: ["a"] },
		{ hash: "a", parents: [] },
	]);
	assert.equal(width, 2);
	const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
	assert.deepEqual(byHash.m.parentCols, [0, 1]);
	assert.equal(byHash.f.col, 1);
	assert.equal(byHash.b.col, 0);
	// Both lanes wait for a; the second ends there.
	assert.equal(byHash.a.col, 0);
	assert.deepEqual(byHash.a.joining, [1]);
	assert.deepEqual(byHash.a.after, []);
});

test("two branch heads get their own lanes, and freed lanes are reused", () => {
	const { rows } = layoutGraph([
		{ hash: "x", parents: ["a"] },
		{ hash: "y", parents: ["a"] },
		{ hash: "a", parents: ["z"] },
		{ hash: "w", parents: ["z"] },
		{ hash: "z", parents: [] },
	]);
	assert.deepEqual(rows.map((r) => [r.hash, r.col]), [["x", 0], ["y", 1], ["a", 0], ["w", 1], ["z", 0]]);
});

test("commits are ordered newest first, but never before their children, even when dates tie or lie", async () => {
	const { topoOrder } = await import("../src/git/diff.ts");
	const order = topoOrder([
		{ hash: "base", parents: [], committedAt: 100 },
		{ hash: "parent", parents: ["base"], committedAt: 200 },
		// Same second as its parent, and a child dated before its parent.
		{ hash: "child", parents: ["parent"], committedAt: 200 },
		{ hash: "skewed", parents: ["child"], committedAt: 150 },
		{ hash: "other", parents: ["base"], committedAt: 180 },
	]).map((c) => c.hash);
	// Of the two branch tips, "other" is newer; "skewed" still comes before the commits it descends from.
	assert.deepEqual(order, ["other", "skewed", "child", "parent", "base"]);
});
