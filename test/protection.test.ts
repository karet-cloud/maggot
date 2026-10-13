import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchRule } from "../src/api.ts";
import { acceptedRefs, checkPush, isAncestor, parseCommands, patternMatches, readReport, refusalReport, rewriteReport } from "../src/protection.ts";

const enc = new TextEncoder();
const pkt = (s: string) => `${(enc.encode(s).length + 4).toString(16).padStart(4, "0")}${s}`;
const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);
const rule = (pattern: string, flags: Partial<BranchRule>): BranchRule => ({
	pattern,
	blockDeletions: false,
	blockForcePushes: false,
	requireMergeQueue: false,
	requireReview: false,
	createdAt: "",
	...flags,
});

test("patterns: * stays in a segment, ** crosses them, everything else is literal", () => {
	assert.ok(patternMatches("master", "master"));
	assert.ok(!patternMatches("master", "master2"));
	assert.ok(patternMatches("release/*", "release/1.0"));
	assert.ok(!patternMatches("release/*", "release/1.0/hotfix"));
	assert.ok(patternMatches("release/**", "release/1.0/hotfix"));
	assert.ok(!patternMatches("v1.0", "v1x0"), "dots are literal");
});

test("push commands and capabilities are read from the request's start", () => {
	const head = enc.encode(`${pkt(`shallow ${A}\n`)}${pkt(`${A} ${B} refs/heads/master\0report-status side-band-64k\n`)}${pkt(`${Z} ${A} refs/heads/new\n`)}0000`);
	const { commands, capabilities } = parseCommands(head);
	assert.deepEqual(commands, [
		{ old: A, new: B, ref: "refs/heads/master" },
		{ old: Z, new: A, ref: "refs/heads/new" },
	]);
	assert.deepEqual(capabilities, ["report-status", "side-band-64k"]);
});

test("rules refuse deletions and direct pushes outright, and mark updates that must fast-forward", () => {
	const rules = [rule("master", { blockDeletions: true, blockForcePushes: true }), rule("release/*", { requireMergeQueue: true })];
	const push = checkPush(rules, [
		{ old: A, new: Z, ref: "refs/heads/master" },
		{ old: A, new: B, ref: "refs/heads/release/1" },
		{ old: A, new: B, ref: "refs/heads/feature" },
		{ old: Z, new: B, ref: "refs/tags/master" },
	]);
	assert.deepEqual([...push.refused.keys()], ["refs/heads/master", "refs/heads/release/1"]);
	const update = checkPush(rules, [{ old: A, new: B, ref: "refs/heads/master" }, { old: Z, new: B, ref: "refs/heads/master" }]);
	assert.equal(update.refused.size, 0);
	assert.deepEqual(update.fastForwardOnly.map((c) => c.old), [A], "creating the branch isn't a force push");
});

test("reports: refusals name every ref, and rewrites keep side-band progress", () => {
	const commands = [{ old: A, new: Z, ref: "refs/heads/master" }, { old: A, new: B, ref: "refs/heads/x" }];
	const plain = readReport(refusalReport(commands, new Map([["refs/heads/master", "protected"]]), ["report-status"]));
	assert.deepEqual(plain.lines, ["unpack ok", "ng refs/heads/master protected", "ng refs/heads/x another ref in this push was refused"]);

	const inner = `${pkt("unpack ok\n")}${pkt("ok refs/heads/master\n")}${pkt("ok refs/heads/x\n")}0000`;
	const response = enc.encode(`${pkt("\x02Resolving deltas\n")}${pkt(`\x01${inner}`)}0000`);
	assert.deepEqual([...acceptedRefs(response)], ["refs/heads/master", "refs/heads/x"]);
	const rewritten = readReport(rewriteReport(response, new Map([["refs/heads/master", "no force pushes"]]), ["report-status", "side-band-64k"]));
	assert.ok(rewritten.sideband);
	assert.equal(rewritten.progress.length, 1);
	assert.deepEqual(rewritten.lines, ["unpack ok", "ng refs/heads/master no force pushes", "ok refs/heads/x"]);
});

test("ancestry: found through any parent, refused for unrelated history, unknown past the budget", async () => {
	// c1 <- c2 <- c4 (merge of c2 and c3); c3 branches from c1; x is unrelated.
	const commits: Record<string, { parents: string[]; committedAt: number }> = {
		c1: { parents: [], committedAt: 100 },
		c2: { parents: ["c1"], committedAt: 200 },
		c3: { parents: ["c1"], committedAt: 210 },
		c4: { parents: ["c2", "c3"], committedAt: 300 },
		x: { parents: [], committedAt: 400 },
	};
	const repo = {
		readCommit: async (hash: string) => (commits[hash] ? { hash, treeHash: "", message: "", author: { name: "", email: "" }, ...commits[hash] } : null),
		readTree: async () => null,
		readBlob: async () => null,
	};
	assert.equal(await isAncestor(repo, "c3", "c4"), true);
	assert.equal(await isAncestor(repo, "c1", "c4"), true);
	assert.equal(await isAncestor(repo, "c4", "c2"), false);
	assert.equal(await isAncestor(repo, "c2", "x"), false);
	assert.equal(await isAncestor(repo, "c1", "c4", 1), null);
});

test("patterns match in time proportional to their size, however they're written", () => {
	const started = Date.now();
	assert.equal(patternMatches(`${"*a".repeat(30)}b`, "a".repeat(100)), false);
	assert.ok(Date.now() - started < 200, "no backtracking blow-up");
	assert.ok(patternMatches("caf?", "café"), "? is one character, not one byte");
});

test("quarantine sends fast-forward-only updates to a holding ref and leaves everything else alone", async () => {
	const { quarantine, INCOMING } = await import("../src/protection.ts");
	const head = enc.encode(`${pkt(`${A} ${B} refs/heads/master\0report-status side-band-64k\n`)}${pkt(`${Z} ${A} refs/heads/other\n`)}0000`);
	const { head: rewritten, staged } = quarantine(head, [{ old: A, new: B, ref: "refs/heads/master" }]);
	assert.equal(staged.length, 1);
	assert.ok(staged[0].temp.startsWith(INCOMING) && staged[0].temp.endsWith("/master"));
	const { commands, capabilities } = parseCommands(rewritten);
	assert.deepEqual(commands, [
		{ old: Z, new: B, ref: staged[0].temp },
		{ old: Z, new: A, ref: "refs/heads/other" },
	]);
	assert.deepEqual(capabilities, ["report-status", "side-band-64k"], "capabilities stay on the first line");
	assert.equal(checkPush([], [{ old: Z, new: A, ref: `${INCOMING}x/master` }]).refused.size, 1, "nobody pushes there directly");
});
