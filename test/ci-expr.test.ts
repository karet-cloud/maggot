import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRun, parseCron } from "../src/ci/cron.ts";
import { evaluate, hashFileCalls, parseCondition, parseExpression, parseTemplate, render, renderValue, type Scope } from "../src/ci/expr.ts";
import { buildPlan, type ResolvedAction } from "../src/ci/plan.ts";
import type { StepSpec } from "../src/ci/workflow.ts";

const scope = (extra: Partial<Scope> = {}): Scope => ({
	contexts: {
		github: { sha: "abc123", event_name: "push", ref: "refs/heads/main" },
		env: { A: "1", EMPTY: "" },
		secrets: { TOKEN: "t0k" },
		matrix: { node: 22, os: "Linux", list: [1, 2] },
		steps: { build: { outputs: { dir: "dist", "cache-hit": "true" }, outcome: "success", conclusion: "success" } },
		needs: { a: { result: "success", outputs: { v: "1" } }, b: { result: "failure", outputs: {} } },
	},
	...extra,
});
const ev = (text: string, s = scope()) => evaluate(parseExpression(text), s);

test("contexts, properties and indexes, case-insensitively, with null for what's missing", () => {
	assert.equal(ev("github.sha"), "abc123");
	assert.equal(ev("GitHub.SHA"), "abc123");
	assert.equal(ev("steps.build.outputs.dir"), "dist");
	assert.equal(ev("steps.build.outputs['cache-hit']"), "true");
	assert.equal(ev("steps.build.outputs.cache-hit"), "true", "names may have dashes");
	assert.equal(ev("matrix.node"), 22);
	assert.equal(ev("matrix.list[1]"), 2);
	assert.equal(ev("github.nope"), null);
	assert.equal(ev("secrets.constructor"), null, "only own properties");
	assert.deepEqual(ev("needs.*.result"), ["success", "failure"]);
	assert.equal(ev("contains(needs.*.result, 'failure')"), true);
	assert.deepEqual(ev("needs.*.outputs.v"), ["1", null]);
	assert.throws(() => ev("nope.x"), /nope isn't available/);
});

test("operators follow GitHub's coercions", () => {
	assert.equal(ev("github.event_name == 'PUSH'"), true, "strings compare without case");
	assert.equal(ev("matrix.node == '22'"), true, "a number and a numeric string");
	assert.equal(ev("matrix.node > 20 && matrix.node <= 22"), true);
	assert.equal(ev("'' == 0"), true);
	assert.equal(ev("null == 0"), true);
	assert.equal(ev("'abc' == 0"), false, "NaN equals nothing");
	assert.equal(ev("true == 1"), true);
	assert.equal(ev("!env.EMPTY"), true);
	assert.equal(ev("env.EMPTY || 'fallback'"), "fallback", "|| gives back an operand");
	assert.equal(ev("env.A && 'yes'"), "yes");
	assert.equal(ev("(1 == 2) || (2 == 2)"), true);
	assert.equal(ev("0x10 == 16"), true);
	assert.equal(ev("-1.5e1 < 0"), true);
});

test("functions", () => {
	assert.equal(ev("contains('Hello', 'ell')"), true);
	assert.equal(ev("contains(matrix.list, 2)"), true);
	assert.equal(ev("startsWith(github.ref, 'refs/heads/')"), true);
	assert.equal(ev("endsWith('a.yml', '.YML')"), true);
	assert.equal(ev("format('{0}-{1} {{x}}', 'a', matrix.node)"), "a-22 {x}");
	assert.equal(ev("join(matrix.list, '+')"), "1+2");
	assert.equal(ev("fromJSON('{\"a\":[1,2]}').a[0]"), 1);
	assert.equal(ev("toJSON(matrix.list)"), "[\n  1,\n  2\n]");
	assert.throws(() => ev("format('{1}', 'a')"), /has no argument/);
	assert.throws(() => ev("success()"), /only be used in if/);
	assert.throws(() => parseExpression("nope(1)"), /isn't a function/);
	assert.throws(() => parseExpression("contains(1)"), /takes 2 arguments/);
	assert.throws(() => parseExpression("'unclosed"), /isn't closed/);
	assert.throws(() => parseExpression("a ==="), /unexpected/);
	assert.throws(() => parseExpression("(".repeat(60) + "1" + ")".repeat(60)), /nests too deeply/);
});

test("templates and conditions", () => {
	assert.equal(render(parseTemplate("node-${{ matrix.node }}-${{ github.sha }}"), scope()), "node-22-abc123");
	assert.equal(render(parseTemplate("${{ 'a }} b' }}!"), scope()), "a }} b!", "}} inside a string doesn't end it");
	assert.equal(renderValue(parseTemplate("${{ matrix.node }}"), scope()), 22);
	assert.throws(() => parseTemplate("${{ x"), /isn't closed/);
	const status = (success: boolean, failure: boolean, cancelled: boolean) => scope({ status: { success, failure, cancelled } });
	const runs = (text: string, s: Scope) => Boolean(evaluate(parseCondition(text), s));
	assert.ok(runs("github.event_name == 'push'", status(true, false, false)));
	assert.ok(!runs("github.event_name == 'push'", status(false, true, false)), "success() && … when there's no status check");
	assert.ok(runs("${{ failure() }}", status(false, true, false)));
	assert.ok(runs("always()", status(false, true, true)));
	assert.ok(runs("!cancelled()", status(false, true, false)));
	assert.ok(!runs("!cancelled()", status(false, false, true)));
	assert.ok(runs("steps.build.outputs.cache-hit != 'true' || failure()", status(false, true, false)));
	assert.ok(!runs("steps.build.outputs.cache-hit != 'true'", status(true, false, false)));
});

test("hashFiles is worked out first, then read back", () => {
	const node = parseExpression("format('{0}-{1}', runner.os, hashFiles('**/package-lock.json', '!x/**'))");
	const s = scope();
	s.contexts.runner = { os: "Linux" };
	assert.deepEqual(hashFileCalls([node], s), [["**/package-lock.json", "!x/**"]]);
	assert.throws(() => evaluate(node, s), /only be used in steps/);
	assert.equal(evaluate(node, { ...s, hashes: new Map([[JSON.stringify(["**/package-lock.json", "!x/**"]), "f00d"]]) }), "Linux-f00d");
});

test("cron schedules", () => {
	const at = (iso: string) => Date.parse(iso);
	const next = (cron: string, from: string) => new Date(nextRun(parseCron(cron), at(from))!).toISOString();
	assert.equal(next("*/15 * * * *", "2026-10-14T10:07:30Z"), "2026-10-14T10:15:00.000Z");
	assert.equal(next("0 6 * * MON-FRI", "2026-10-16T07:00:00Z"), "2026-10-19T06:00:00.000Z", "Friday after six: Monday");
	assert.equal(next("30 2 1 * *", "2026-10-14T00:00:00Z"), "2026-11-01T02:30:00.000Z");
	assert.equal(next("0 0 * 2 0", "2026-10-14T00:00:00Z"), "2027-02-07T00:00:00.000Z", "Sundays in February");
	assert.equal(next("0 12 13 * 5", "2026-10-14T00:00:00Z"), "2026-10-16T12:00:00.000Z", "day of month or day of week");
	assert.equal(next("0 0 * * 7", "2026-10-14T00:00:00Z"), "2026-10-18T00:00:00.000Z", "7 is Sunday");
	assert.equal(parseCron("*/5 * * * *").minGapMinutes, 5);
	assert.equal(parseCron("0,30 * * * *").minGapMinutes, 30);
	assert.equal(parseCron("5/20 * * * *").minGapMinutes, 20);
	assert.throws(() => parseCron("* * * *"), /five fields/);
	assert.throws(() => parseCron("0 0 30 2 *"), /never runs/);
	assert.throws(() => parseCron("0 25 * * *"), /hour is from 0 to 23/);
	assert.throws(() => parseCron("0 5-1 * * *"), /backwards/);
});

const step = (name: string, extra: Partial<StepSpec> = {}): StepSpec => ({
	kind: "run",
	id: null,
	name,
	run: "x",
	uses: null,
	with: {},
	shell: "bash",
	workingDirectory: null,
	env: {},
	if: "success()",
	continueOnError: false,
	timeoutMinutes: null,
	...extra,
});

test("a plan: pre steps first, post steps last in reverse, composite actions as one shown step", () => {
	const node = (name: string, pre: boolean): ResolvedAction => ({
		meta: { name, inputs: {}, outputs: {}, runs: { using: "node", main: "main.js", pre: pre ? "pre.js" : null, post: "post.js", preIf: "always()", postIf: "always()" } },
		dir: `/a/${name}`,
		repository: `o/${name}`,
		ref: "v1",
		archive: { owner: "o", repo: name, sha: "s".repeat(40), root: `/a/${name}` },
		nested: [],
	});
	const composite: ResolvedAction = {
		meta: { name: "comp", inputs: {}, outputs: { out: "${{ steps.inner.outputs.x }}" }, runs: { using: "composite", steps: [step("inner one"), step("uses node", { kind: "action" })] } },
		dir: "/w/comp",
		repository: "me/repo",
		ref: "",
		archive: null,
		nested: [null, node("inner-node", true)],
	};
	const steps = [step("Check out", { kind: "checkout", run: null }), step("Setup", { kind: "action" }), step("Cache", { kind: "cache", with: { key: "k", path: "p" } }), step("Composite", { kind: "action", id: "c" }), step("Test")];
	const plan = buildPlan(steps, [null, node("setup", true), null, composite, null]);
	assert.deepEqual(plan.ui, ["Set up job", "Pre Setup", "Check out", "Setup", "Cache", "Composite", "Test", "Post uses node", "Post Cache", "Post Setup", "Complete job"]);
	const shown = plan.units.map((u) => `${u.kind}${u.kind === "node" ? `:${u.phase}` : ""}@${u.ui}${u.scope ? `/${u.scope}` : ""}`);
	assert.deepEqual(shown, ["node:pre@1", "checkout@2", "node:main@3", "cache-restore@4", "enter@5", "run@5/1", "node:main@5/1", "exit@5", "run@6", "node:post@7/1", "cache-save@8", "node:post@9"]);
	// Pre steps of actions inside composite actions don't run (as on GitHub); post ones do.
	const enter = plan.units[4];
	assert.ok(enter.kind === "enter" && enter.end === 7 && enter.scope === "");
	const exit = plan.units[7];
	assert.ok(exit.kind === "exit" && exit.enter === 4);
	const posts = plan.units.filter((u) => (u.kind === "node" && u.phase !== "main") || (u.kind === "cache-save" && u.main !== null));
	assert.deepEqual(
		posts.map((u) => (u as { main: number }).main),
		[2, 6, 3, 2],
		"each pre and post unit points at its main unit",
	);
	assert.equal(plan.actions.length, 3);
});
