import assert from "node:assert/strict";
import { test } from "node:test";
import { branchMatches, expand, fetchDepthFor, filterAllows, parseWorkflow, runnerFor, typeAllows, WorkflowError } from "../src/ci/workflow.ts";

const P = ".megit/workflows/ci.yml";
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
	assert.equal(build.steps[2].if, "notCancelled");
	assert.equal(build.steps[2].continueOnError, true);
	assert.deepEqual(deploy.runsOn, { kind: "depot", vcpus: 8 });
	assert.deepEqual(deploy.needs, ["build"]);
	assert.equal(deploy.steps[0].if, "always");
	assert.equal(deploy.timeoutMinutes, 30);
	assert.equal(fetchDepthFor(deploy.steps), 50);
});

test("`on` is a key, not YAML 1.1's boolean", () => {
	assert.ok(parses("on: push\njobs:\n  a:\n    steps:\n      - run: x\n").on.push);
	assert.ok(parses("on: [push, workflow_dispatch]\njobs:\n  a:\n    steps:\n      - run: x\n").on.dispatch);
});

test("anything megit wouldn't honour is an error, naming where", () => {
	const job = (extra: string) => `on: push\njobs:\n  a:\n    runs-on: cloudflare\n${extra}    steps:\n      - run: x\n`;
	const stepWith = (extra: string) => `on: push\njobs:\n  a:\n    steps:\n      - run: x\n${extra}`;
	rejects("on: schedule\njobs:\n  a:\n    steps:\n      - run: x\n", /on: "schedule" isn't supported/);
	rejects("on:\n  push:\n    paths: [src]\njobs:\n  a:\n    steps:\n      - run: x\n", /on.push: "paths" isn't supported/);
	rejects("on:\n  push:\n    types: [created]\njobs:\n  a:\n    steps:\n      - run: x\n", /on.push: "types" isn't supported/);
	rejects("on:\n  pull_request:\n    types: [closed]\njobs:\n  a:\n    steps:\n      - run: x\n", /types: "closed" isn't supported/);
	rejects("on:\n  workflow_dispatch:\n    inputs:\n      x: {}\njobs:\n  a:\n    steps:\n      - run: x\n", /inputs aren't supported/);
	rejects("on: push\nconcurrency: x\njobs:\n  a:\n    steps:\n      - run: x\n", /"concurrency" isn't supported/);
	rejects("on: push\nrun-name: x\njobs:\n  a:\n    steps:\n      - run: x\n", /"run-name" isn't supported/);
	rejects("on: push\npermissions:\n  contents: write\njobs:\n  a:\n    steps:\n      - run: x\n", /read-only token/);
	rejects(job("    strategy:\n      matrix: {}\n"), /jobs.a: "strategy" isn't supported/);
	rejects(job("    services: {}\n"), /"services" isn't supported/);
	rejects(job("    if: always()\n"), /"if" isn't supported/);
	rejects(stepWith("        continue-on-error: yes please\n"), /continue-on-error is true or false/);
	rejects(stepWith("        with:\n          x: 1\n"), /with is for uses steps/);
	rejects(stepWith("        timeout-minutes: 0\n"), /timeout-minutes is a whole number/);
	rejects(stepWith("        timeout-minutes: 45\n"), /longer than the job's 30 minutes/);
	rejects(stepWith("        working-directory: ../up\n"), /folder inside the repository/);
	rejects(stepWith("        if: github.ref == 'x'\n"), /understands success\(\)/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n", /isn't supported yet/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: other\n", /"ref" isn't supported/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: true\n", /persist-credentials/);
	rejects("on: push\njobs:\n  a:\n    uses: org/repo/.github/workflows/x.yml@v1\n", /reusable workflows/);
	rejects("on: push\njobs:\n  a:\n    needs: b\n    steps:\n      - run: x\n", /needs names "b"/);
	rejects("on: push\njobs:\n  a:\n    needs: b\n    steps:\n      - run: x\n  b:\n    needs: a\n    steps:\n      - run: x\n", /loop: a → b → a/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: x\n  a:\n    steps:\n      - run: y\n", /unique|duplicate/i);
	rejects("on: push\njobs: {}\n", /at least one job/);
	rejects("on: push\njobs:\n  a:\n    steps: []\n", /at least one step/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ github.nope }}\n", /github.nope isn't available/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ matrix.os }}\n", /understands/);
	rejects("on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n", /GITHUB_TOKEN/);
	rejects("on: push\njobs:\n  a:\n    env:\n      X: ${{ runner.temp }}\n    steps:\n      - run: x\n", /runner.temp isn't available/);
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
	assert.throws(() => runnerFor("macos-latest", "r"), /isn't a runner megit knows/);
});

test("branch filters and pull request types", () => {
	assert.ok(branchMatches(["release/**", "!release/old/**"], "release/1.0"));
	assert.ok(!branchMatches(["release/**", "!release/old/**"], "release/old/x"));
	assert.ok(filterAllows({ branches: null, branchesIgnore: ["wip/*"] }, "master"));
	assert.ok(!filterAllows({ branches: null, branchesIgnore: ["wip/*"] }, "wip/x"));
	assert.ok(typeAllows({ branches: null, branchesIgnore: null, types: null }, "reopened"));
	assert.ok(!typeAllows({ branches: null, branchesIgnore: null, types: ["opened"] }, "synchronize"));
});

test("expressions fill in secrets, env and github, and nothing else", () => {
	const ctx = { secrets: { TOKEN: "t0k" }, github: { sha: "abc" }, env: { A: "1" } };
	assert.equal(expand("${{ secrets.TOKEN }}-${{github.sha}}-${{ env.A }}-${{ secrets.MISSING }}-${{ runner.os }}", ctx, "w"), "t0k-abc-1--Linux");
	assert.equal(expand("${{ secrets.constructor }}", ctx, "w"), "", "only the object's own values");
	assert.equal(expand("${{ env.toString }}", ctx, "w"), "");
	assert.throws(() => expand("${{ github.toString }}", ctx, "w"), /isn't available/);
	assert.throws(() => expand("${{ secrets.TOKEN || 'x' }}", ctx, "w"), /understands/);
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
