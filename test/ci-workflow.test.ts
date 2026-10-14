import assert from "node:assert/strict";
import { test } from "node:test";
import { branchMatches, compositeSteps, expandMatrix, fetchDepthFor, filterAllows, parseUses, parseWorkflow, runnerFor, typeAllows, WorkflowError } from "../src/ci/workflow.ts";

const P = ".maggot/workflows/ci.yml";
const parses = (source: string) => parseWorkflow(source, P);
const rejects = (source: string, message: RegExp) => assert.throws(() => parses(source), (err: unknown) => err instanceof WorkflowError && message.test(err.message) && err.message.startsWith(`${P}: `));

test("a typical workflow parses, with defaults filled in", () => {
	const w = parses(`
name: CI
on:
  push:
    branches: [master, "release/**"]
  pull_request:
    types: [opened, synchronize]
  workflow_dispatch:
env:
  NODE_ENV: test
  RETRIES: 3
defaults:
  run:
    working-directory: app
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci
      - name: Test
        run: npm test -- --token "\${{ secrets.NPM_TOKEN }}"
        shell: sh
        working-directory: ./web/
        timeout-minutes: 10
        if: \${{ !cancelled() }}
        continue-on-error: true
  deploy:
    needs: build
    runs-on: depot-8
    steps:
      - run: echo deploy
        if: always()
`);
	assert.equal(w.name, "CI");
	assert.deepEqual(w.on.push, { branches: ["master", "release/**"], branchesIgnore: null });
	assert.deepEqual(w.on.pullRequest?.types, ["opened", "synchronize"]);
	assert.ok(w.on.dispatch);
	assert.deepEqual(w.env, { NODE_ENV: "test", RETRIES: "3" });
	const [build, deploy] = w.jobs;
	assert.deepEqual(build.runsOn, { kind: "default" });
	assert.equal(build.timeoutMinutes, 15);
	assert.equal(build.steps[0].run, null);
	assert.equal(build.steps[0].fetchDepth, 0);
	assert.equal(fetchDepthFor(build.steps), 0);
	assert.equal(build.steps[1].name, "Run npm ci");
	assert.equal(build.steps[1].workingDirectory, "app", "defaults.run applies");
	assert.equal(build.steps[2].shell, "sh");
	assert.equal(build.steps[2].workingDirectory, "web");
	assert.equal(build.steps[2].timeoutMinutes, 10);
	assert.equal(build.steps[2].if, "${{ !cancelled() }}");
	assert.equal(build.steps[2].continueOnError, true);
	assert.deepEqual(deploy.runsOn, { kind: "depot", vcpus: 8 });
	assert.deepEqual(deploy.needs, ["build"]);
	assert.equal(deploy.steps[0].if, "always()");
	assert.equal(build.steps[1].if, "success()", "no if: is success()");
	assert.equal(deploy.timeoutMinutes, 30);
	assert.equal(fetchDepthFor(deploy.steps), 50);
});

test("`on` is a key, not YAML 1.1's boolean", () => {
	assert.ok(parses("on: push\njobs:\n  a:\n    steps:\n      - run: x\n").on.push);
	assert.ok(parses("on: [push, workflow_dispatch]\njobs:\n  a:\n    steps:\n      - run: x\n").on.dispatch);
});

test("anything maggot wouldn't honour is an error, naming where", () => {
	const job = (extra: string) => `on: push\njobs:\n  a:\n    runs-on: cloudflare\n${extra}    steps:\n      - run: x\n`;
	const stepWith = (extra: string) => `on: push\njobs:\n  a:\n    steps:\n      - run: x\n${extra}`;
	rejects("on: schedule\njobs:\n  a:\n    steps:\n      - run: x\n", /on.schedule is a list/);
	rejects("on:\n  schedule:\n    - cron: '* * * * *'\njobs:\n  a:\n    steps:\n      - run: x\n", /at least 5 minutes apart/);
	rejects("on:\n  schedule:\n    - cron: '0 0 31 2 *'\njobs:\n  a:\n    steps:\n      - run: x\n", /never runs/);
	rejects("on:\n  schedule:\n    - cron: '61 * * * *'\njobs:\n  a:\n    steps:\n      - run: x\n", /minute is from 0 to 59/);
	rejects("on: issues\njobs:\n  a:\n    steps:\n      - run: x\n", /on: "issues" isn't supported/);
	rejects("on:\n  push:\n    paths: [src]\njobs:\n  a:\n    steps:\n      - run: x\n", /on.push: "paths" isn't supported/);
	rejects("on:\n  push:\n    types: [created]\njobs:\n  a:\n    steps:\n      - run: x\n", /on.push: "types" isn't supported/);
	rejects("on:\n  pull_request:\n    types: [closed]\njobs:\n  a:\n    steps:\n      - run: x\n", /types: "closed" isn't supported/);
	rejects("on:\n  workflow_dispatch:\n    inputs:\n      x: {}\njobs:\n  a:\n    steps:\n      - run: x\n", /inputs aren't supported/);
	rejects("on: push\nconcurrency: x\njobs:\n  a:\n    steps:\n      - run: x\n", /"concurrency" isn't supported/);
	rejects("on: push\nrun-name: x\njobs:\n  a:\n    steps:\n      - run: x\n", /"run-name" isn't supported/);
	rejects("on: push\npermissions:\n  contents: write\njobs:\n  a:\n    steps:\n      - run: x\n", /read-only token/);
	rejects(job("    strategy:\n      matrix: {}\n"), /makes no jobs/);
	rejects(job("    strategy:\n      matrix: ${{ fromJSON(needs.a.outputs.m) }}\n"), /built by an expression/);
	rejects(job("    strategy:\n      matrix:\n        os: []\n"), /at least one value/);
	rejects(job("    strategy:\n      fail-fast: maybe\n      matrix:\n        os: [a]\n"), /fail-fast is true or false/);
	rejects(job("    services: {}\n"), /"services" isn't supported/);
	rejects(job("    if: steps.x.outputs.y\n"), /steps can't be used here/);
	rejects(job("    outputs:\n      bad name: x\n"), /isn't a valid output name/);
	rejects(stepWith("        continue-on-error: yes please\n"), /continue-on-error is true or false/);
	rejects(stepWith("        with:\n          x: 1\n"), /with is for uses steps/);
	rejects(stepWith("        timeout-minutes: 0\n"), /timeout-minutes is a whole number/);
	rejects(stepWith("        timeout-minutes: 45\n"), /longer than the job's 30 minutes/);
	rejects(stepWith("        working-directory: ../up\n"), /folder inside the repository/);
	rejects(stepWith("        if: github.ref == \n"), /a\.steps\[0\]\.if/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: docker://alpine:3\n", /Docker container actions/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node\n", /owner\/repo@ref/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: x\n", /with.key is required/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          path: x\n          if-no-files-found: shrug\n", /warn, error or ignore/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - id: x\n        run: a\n      - id: x\n        run: b\n", /two steps have the id x/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: other\n", /"ref" isn't supported/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: true\n", /persist-credentials/);
	rejects("on: push\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@v1\n", /reusable workflows/);
	rejects("on: push\njobs:\n  a:\n    needs: b\n    steps:\n      - run: x\n", /needs names "b"/);
	rejects("on: push\njobs:\n  a:\n    needs: b\n    steps:\n      - run: x\n  b:\n    needs: a\n    steps:\n      - run: x\n", /loop: a → b → a/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: x\n  a:\n    steps:\n      - run: y\n", /unique|duplicate/i);
	rejects("on: push\njobs: {}\n", /at least one job/);
	rejects("on: push\njobs:\n  a:\n    steps: []\n", /at least one step/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ nope.x }}\n", /nope isn't a context/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ vars.X }}\n", /vars isn't in maggot yet/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ success() }}\n", /can only be used in if/);
	rejects("on: push\nenv:\n  X: ${{ hashFiles('a') }}\njobs:\n  a:\n    steps:\n      - run: x\n", /hashFiles\(\) can only be used in steps/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n", /GITHUB_TOKEN/);
	rejects("on: push\njobs:\n  a:\n    env:\n      X: ${{ runner.temp }}\n    steps:\n      - run: x\n", /runner can't be used here/);
	rejects("{{{", /ci.yml/);
});

test("runner labels", () => {
	assert.deepEqual(runnerFor("cloudflare", "r"), { kind: "cloudflare" });
	assert.deepEqual(runnerFor("depot", "r"), { kind: "depot", vcpus: 2 });
	assert.deepEqual(runnerFor("depot-ubuntu-24.04-16", "r"), { kind: "depot", vcpus: 16 });
	assert.deepEqual(runnerFor("ubuntu-24.04", "r"), { kind: "default" });
	assert.throws(() => runnerFor("depot-3", "r"), /2, 4, 8, 16, 32 or 64/);
	assert.throws(() => runnerFor("blacksmith-4vcpu-ubuntu-2404", "r"), /Blacksmith runners only take jobs from GitHub Actions/);
	assert.throws(() => runnerFor("ubuntu-24.04-arm", "r"), /x64/);
	assert.throws(() => runnerFor(["self-hosted", "linux"], "r"), /one runner label/);
	assert.throws(() => runnerFor("macos-latest", "r"), /isn't a runner maggot knows/);
});

test("branch filters and pull request types", () => {
	assert.ok(branchMatches(["release/**", "!release/old/**"], "release/1.0"));
	assert.ok(!branchMatches(["release/**", "!release/old/**"], "release/old/x"));
	assert.ok(filterAllows({ branches: null, branchesIgnore: ["wip/*"] }, "master"));
	assert.ok(!filterAllows({ branches: null, branchesIgnore: ["wip/*"] }, "wip/x"));
	assert.ok(typeAllows({ branches: null, branchesIgnore: null, types: null }, "reopened"));
	assert.ok(!typeAllows({ branches: null, branchesIgnore: null, types: ["opened"] }, "synchronize"));
});

test("a matrix makes one job per combination, less exclude, with include added where it fits", () => {
	const combos = expandMatrix(
		{
			os: ["linux", "mac"],
			node: [20, 22],
			exclude: [{ os: "mac", node: 20 }],
			include: [{ node: 22, experimental: true }, { os: "windows", node: 24 }, { os: "linux", node: 20, extra: "x" }],
		},
		"m",
	);
	assert.deepEqual(combos, [
		{ os: "linux", node: 20, extra: "x" },
		{ os: "linux", node: 22, experimental: true },
		{ os: "mac", node: 22, experimental: true },
		{ os: "windows", node: 24 },
	]);
	// Only include: each entry is a job.
	assert.deepEqual(expandMatrix({ include: [{ a: 1 }, { a: 2 }] }, "m"), [{ a: 1 }, { a: 2 }]);
	assert.throws(() => expandMatrix({ a: Array.from({ length: 17 }, (_, i) => i), b: Array.from({ length: 17 }, (_, i) => i) }, "m"), /more than 256 jobs/);
});

test("matrix jobs: keys, names, runs-on and needs", () => {
	const w = parses(`
on: push
jobs:
  test:
    name: Test on \${{ matrix.os }}
    runs-on: \${{ matrix.runner }}
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        os: [linux, mac]
        include:
          - os: linux
            runner: depot-4
          - os: mac
            runner: cloudflare
    steps:
      - run: echo \${{ matrix.os }}
  lint:
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - run: x
  report:
    needs: [test, lint]
    if: always()
    outputs:
      summary: \${{ steps.s.outputs.text }}
    steps:
      - id: s
        run: echo "text=done" >> "$GITHUB_OUTPUT"
`);
	const [linux, mac, lint1, lint2, report] = w.jobs;
	assert.deepEqual([linux.key, mac.key, lint1.key, lint2.key, report.key], ["test.1", "test.2", "lint.1", "lint.2", "report"]);
	assert.equal(linux.group, "test");
	assert.equal(linux.name, "Test on linux");
	assert.equal(lint2.name, "lint (22)");
	assert.deepEqual(linux.runsOn, { kind: "depot", vcpus: 4 });
	assert.deepEqual(mac.runsOn, { kind: "cloudflare" });
	assert.deepEqual(linux.strategy, { failFast: false, maxParallel: 2, index: 0, total: 2 });
	assert.deepEqual(linux.matrix, { os: "linux", runner: "depot-4" });
	assert.deepEqual(report.needs, ["test.1", "test.2", "lint.1", "lint.2"]);
	assert.deepEqual(report.needsGroups, ["test", "lint"]);
	assert.equal(report.if, "always()");
	assert.deepEqual(report.outputs, { summary: "${{ steps.s.outputs.text }}" });
	assert.equal(report.steps[0].id, "s");
});

test("schedules and uses", () => {
	const w = parses("on:\n  schedule:\n    - cron: '*/15 * * * *'\n    - cron: '0 6 * * MON-FRI'\njobs:\n  a:\n    steps:\n      - run: x\n");
	assert.deepEqual(w.on.schedule, ["*/15 * * * *", "0 6 * * MON-FRI"]);
	assert.deepEqual(parseUses("actions/checkout@v4", "u"), { kind: "checkout", ref: null });
	assert.deepEqual(parseUses("actions/cache/restore@v4", "u"), { kind: "cache-restore", ref: null });
	assert.deepEqual(parseUses("Actions/Upload-Artifact@v4", "u"), { kind: "upload-artifact", ref: null });
	assert.deepEqual(parseUses("actions/setup-node@v4", "u"), { kind: "action", ref: { kind: "github", owner: "actions", repo: "setup-node", path: "", ref: "v4" } });
	assert.deepEqual(parseUses("owner/repo/sub/dir@abc123", "u"), { kind: "action", ref: { kind: "github", owner: "owner", repo: "repo", path: "sub/dir", ref: "abc123" } });
	assert.deepEqual(parseUses("./.github/actions/setup", "u"), { kind: "action", ref: { kind: "local", path: ".github/actions/setup" } });
	assert.throws(() => parseUses("./../x", "u"), /isn't a folder/);
	assert.throws(() => parseUses("owner/repo/../x@v1", "u"), /isn't an action/);
});

test("composite action steps say their shell and can't use secrets", () => {
	const steps = compositeSteps([{ run: "echo ${{ inputs.who }}", shell: "bash" }, { uses: "actions/cache@v4", with: { key: "k", path: "p" } }], "runs.steps");
	assert.equal(steps[0].run, "echo ${{ inputs.who }}");
	assert.equal(steps[1].kind, "cache");
	assert.throws(() => compositeSteps([{ run: "x" }], "runs.steps"), /shell is required/);
	assert.throws(() => compositeSteps([{ run: "echo ${{ secrets.X }}", shell: "bash" }], "runs.steps"), /secrets can't be used here/);
	assert.throws(() => compositeSteps([{ uses: "actions/checkout@v4" }], "runs.steps"), /can't be used inside an action/);
});

test("environment variables called __proto__ are kept as values", () => {
	const w = parses(`
on: push
env:
  __proto__: top
jobs:
  build:
    steps:
      - run: echo
`);
	assert.ok(Object.hasOwn(w.env, "__proto__"));
	assert.equal(w.env.__proto__ as unknown, "top");
});
