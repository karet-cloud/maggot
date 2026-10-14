import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlan } from "../src/ci/plan.ts";
import { CLEANUP_WINDOW_MS, JobRunner, newJobState, RETRY_WINDOW_MS, type JobLaunch, type JobReport, type JobState, type Machine } from "../src/ci/runner.ts";
import type { Sandbox } from "../src/ci/sandbox.ts";
import type { StepSpec } from "../src/ci/workflow.ts";
import { LocalSandbox, NamespaceSandbox } from "./ci-local.ts";

const step = (name: string, run: string | null, extra: Partial<StepSpec> = {}): StepSpec => ({
	kind: run === null ? "checkout" : "run",
	id: null,
	name,
	run,
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

/** A repository with one commit, cloneable over file://. */
function repository(): { url: string; sha: string } {
	const dir = mkdtempSync(join(tmpdir(), "mgci-repo-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
	git("init", "-q", "-b", "master");
	writeFileSync(join(dir, "hello.txt"), "hello from the repo\n");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	return { url: `file://${dir}`, sha: git("rev-parse", "HEAD") };
}

const SECRET = "s3cr3t-value-123";
const TOKEN = "mgci_checkout-token-xyz";

function launchFor(steps: StepSpec[], repo = repository()): JobLaunch {
	return {
		jobId: "job-1",
		repo: "repo-1",
		runner: { kind: "cloudflare" },
		timeoutMinutes: 5,
		plan: buildPlan(steps, steps.map(() => null)),
		env: { CI: "true", API_KEY: SECRET },
		contexts: { github: { sha: repo.sha, ref: "refs/heads/master" }, matrix: {}, needs: {}, strategy: {}, inputs: {} },
		secrets: {},
		outputs: {},
		mask: [SECRET],
		checkout: { url: repo.url, auth: btoa(`x:${TOKEN}`), ref: "refs/heads/master", sha: repo.sha, depth: 50 },
		api: { url: "http://127.0.0.1:1", token: "mgjob_test-job-token" },
	};
}

/** Runs commands on this machine. */
class LocalMachine implements Machine {
	readonly box: LocalSandbox;
	constructor(box: LocalSandbox = new LocalSandbox()) {
		this.box = box;
	}
	ready = 0;
	destroyed = false;
	/** Destroy calls that fail before one works. */
	destroyFailures = 0;
	destroyCalls = 0;
	async provision() {
		return this.ready-- <= 0;
	}
	sandbox(): Sandbox {
		return this.box;
	}
	async alive() {
		return true;
	}
	async destroy() {
		this.destroyCalls++;
		if (this.destroyFailures-- > 0) throw new Error("Depot answered 503");
		this.destroyed = true;
	}
	describe() {
		return "this machine";
	}
}

/** Ticks until the job settles, delivering reports like the coordinator would. */
async function run(runner: JobRunner, opts: { onTick?: (n: number, logs: Map<number, string>) => void; dropEvery?: number } = {}): Promise<{ reports: JobReport[]; logs: Map<number, string> }> {
	const reports: JobReport[] = [];
	const logs = new Map<number, string>();
	const seen = new Set<number>();
	for (let n = 0; n < 2000 && !runner.settled; n++) {
		opts.onTick?.(n, logs);
		await runner.tick();
		const report = runner.nextReport(64 * 1024);
		// A lost answer: the coordinator got it, but the job doesn't know.
		const lost = opts.dropEvery !== undefined && n % opts.dropEvery === 1;
		reports.push(report);
		if (report.seq === undefined || !seen.has(report.seq)) {
			if (report.seq !== undefined) seen.add(report.seq);
			for (const l of report.logs) logs.set(l.step, (logs.get(l.step) ?? "") + l.text);
		}
		if (!lost) runner.acked(report);
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(runner.settled, "the job settled");
	return { reports, logs };
}

test("a job checks out, runs steps with their environment, masks secrets and settles", async () => {
	const machine = new LocalMachine();
	machine.ready = 2;
	const steps = [
		step("Check out", null),
		step("Show", 'cat hello.txt; echo "key=$API_KEY"; echo "token $MAGGOT_CLONE_AUTH"; git rev-parse --abbrev-ref HEAD; echo "FROM_STEP=yes" >> "$GITHUB_ENV"; echo /opt/extra >> "$GITHUB_PATH"'),
		step("Env", 'echo "from=$FROM_STEP"; echo "$PATH" | cut -d: -f1; printf "héllo 🎉\\n"'),
		step("Fails", "echo before; exit 4", { continueOnError: true }),
		step("Fails hard", "exit 2"),
		step("Skipped", "echo never"),
		step("Always", "echo cleanup", { if: "always()" }),
		step("On failure", "echo it failed", { if: "failure()" }),
	];
	const launch = launchFor(steps);
	const state = newJobState(launch);
	const runner = new JobRunner(launch, state, machine);
	const { reports, logs } = await run(runner);
	const final = reports.at(-1)!;
	assert.equal(final.status, "completed");
	assert.equal(final.conclusion, "failure");
	assert.deepEqual(
		final.steps.map((s) => s.conclusion),
		["success", "success", "success", "success", "success", "failure", "skipped", "success", "success", "success"],
	);
	assert.match(logs.get(0)!, /Checked out [0-9a-f]+ first/);
	const show = logs.get(2)!;
	assert.match(show, /hello from the repo/);
	assert.match(show, /key=\*\*\*/);
	assert.ok(!show.includes(SECRET));
	assert.match(show, /^master$/m, "a push checks out the branch");
	assert.match(show, /token \n/, "the checkout's token isn't in the steps' environment");
	assert.match(logs.get(3)!, /from=yes/);
	assert.match(logs.get(3)!, /^\/opt\/extra$/m);
	assert.match(logs.get(3)!, /héllo 🎉/);
	assert.match(logs.get(4)!, /exited with code 4 \(continue-on-error/);
	assert.match(logs.get(7)!, /cleanup/);
	assert.match(logs.get(8)!, /it failed/);
	for (const text of logs.values()) {
		assert.ok(!text.includes(SECRET), "no secret anywhere");
		assert.ok(!text.includes(TOKEN), "no token anywhere");
	}
	assert.ok(machine.destroyed);
	// Reports are numbered, and each number is sent with the same logs until it's acknowledged.
	const seqs = reports.map((r) => r.seq).filter((s) => s !== undefined);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a! - b!));
});

test("lost report answers are resent with the same number, so logs arrive once", async () => {
	const launch = launchFor([step("Print", "for i in $(seq 1 200); do echo line $i; done")]);
	const runner = new JobRunner(launch, newJobState(launch), new LocalMachine());
	const { reports, logs } = await run(runner, { dropEvery: 3 });
	const lines = logs.get(1)!.trim().split("\n");
	assert.equal(lines.length, 200);
	assert.equal(lines[199], "line 200");
	const bySeq = new Map<number, string>();
	for (const r of reports) {
		if (r.seq === undefined) continue;
		const text = JSON.stringify(r.logs);
		if (bySeq.has(r.seq)) assert.equal(bySeq.get(r.seq), text, "a resent report carries the same logs");
		bySeq.set(r.seq, text);
	}
});

test("a cancel stops the running step, then runs always() and cancelled() steps", async () => {
	const launch = launchFor([step("Long", "echo started; sleep 30"), step("Next", "echo no"), step("Cleanup", "echo cleaning", { if: "always()" }), step("Cancelled", "echo was cancelled", { if: "cancelled()" })]);
	const runner = new JobRunner(launch, newJobState(launch), new LocalMachine());
	const started = Date.now();
	const { reports, logs } = await run(runner, {
		onTick: (_, seen) => {
			if (seen.get(1)?.includes("started")) runner.cancel();
		},
	});
	assert.ok(Date.now() - started < 20_000, "the sleep didn't run out");
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "cancelled");
	assert.deepEqual(
		final.steps.map((s) => s.conclusion),
		["success", "cancelled", "skipped", "success", "success", "success"],
	);
	assert.match(logs.get(3)!, /cleaning/);
	assert.match(logs.get(4)!, /was cancelled/);
});

test("a step past its time limit is stopped and fails the job", async () => {
	const launch = launchFor([step("Slow", "sleep 30", { timeoutMinutes: 1 }), step("After", "echo after")]);
	const state = newJobState(launch);
	const runner = new JobRunner(launch, state, new LocalMachine());
	const { reports, logs } = await run(runner, {
		onTick: () => {
			// Bring the step's deadline forward once it's running.
			if (state.phase === "steps" && state.process.launched && !state.process.stopping) state.process.deadline = Date.now() - 1;
		},
	});
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "failure");
	assert.equal(final.steps[1].conclusion, "failure");
	assert.equal(final.steps[2].conclusion, "skipped");
	assert.match(logs.get(1)!, /ran past its 1-minute limit/);
});

test("a step stopped for its time limit fails even if it exits 0 on TERM", async () => {
	// No secrets, so no mask filter: the step's own exit code is what's recorded.
	const launch = { ...launchFor([step("Trapped", "trap 'exit 0' TERM; echo trapped; sleep 30", { timeoutMinutes: 1 })]), mask: [] };
	const state = newJobState(launch);
	const runner = new JobRunner(launch, state, new LocalMachine());
	const { reports } = await run(runner, {
		onTick: () => {
			// Once the step has set its trap (and said so).
			const p = state.process;
			if (state.phase === "steps" && p.launched && !p.stopping && p.offset > 0) p.deadline = Date.now() - 1;
		},
	});
	assert.equal(reports.at(-1)!.conclusion, "failure");
	assert.equal(reports.at(-1)!.steps[1].conclusion, "failure");
});

test("a failed checkout fails the job without running steps", async () => {
	const repo = repository();
	const launch = launchFor([step("Never", "echo never")], { url: repo.url, sha: "0".repeat(40) });
	const runner = new JobRunner(launch, newJobState(launch), new LocalMachine());
	const { reports, logs } = await run(runner);
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "failure");
	assert.deepEqual(
		final.steps.map((s) => s.conclusion),
		["failure", "skipped", "success"],
	);
	assert.match(logs.get(0)!, /isn't on refs\/heads\/master/);
	assert.match(final.error!, /Checking out 0000000 failed/);
});

test("a job restarted part-way picks up where it was without running a step twice", async () => {
	const launch = launchFor([step("Count", 'echo ran >> "$HOME/count"; sleep 1; echo done')]);
	const machine = new LocalMachine();
	const state = newJobState(launch);
	let runner = new JobRunner(launch, state, machine);
	for (let i = 0; i < 6 && !(state.phase === "steps" && state.process.launched); i++) await runner.tick();
	assert.ok(state.process.launched);
	// A new object from the saved state, as after a restart; the launch command runs again harmlessly.
	const saved = structuredClone(state) as JobState;
	saved.process.launched = false;
	runner = new JobRunner(launch, saved, machine);
	await run(runner);
	assert.equal(execFileSync("cat", [join(machine.box.root, "count")]).toString(), "ran\n");
	assert.equal(saved.states[1].conclusion, "success");
});

/** A machine whose commands fail in a scripted way. */
class FlakyMachine implements Machine {
	failures: number;
	lost = false;
	destroyed = false;
	constructor(failures: number) {
		this.failures = failures;
	}
	async provision() {
		if (this.failures-- > 0) throw new TypeError("network connection lost");
		return true;
	}
	sandbox(): Sandbox {
		return {
			writeFile: async () => {},
			readFile: async () => "",
			exec: async (argv) => {
				const script = argv[2] ?? "";
				if (script.includes("mkdir \"$f.lock\"")) return { exitCode: 0, stdout: "", stderr: "" };
				if (script.includes("collect-")) return { exitCode: 0, stdout: "0\n0\n", stderr: "" };
				return { exitCode: 0, stdout: this.lost ? "missing\n0\n\n" : "running\n0\n\n", stderr: "" };
			},
		};
	}
	async alive() {
		return true;
	}
	async destroy() {
		this.destroyed = true;
	}
	describe() {
		return "a flaky machine";
	}
}

test("transient errors are retried for a while; past the window the job fails", async () => {
	const launch = launchFor([step("S", "true")]);
	const ok = new JobRunner(launch, newJobState(launch), new FlakyMachine(30));
	for (let i = 0; i < 31; i++) await ok.tick();
	assert.equal(ok.state.phase, "setup", "thirty quick failures in a row are still inside the window");
	assert.equal(ok.state.failingSince, null);

	const machine = new FlakyMachine(100);
	const bad = new JobRunner(launch, newJobState(launch), machine);
	await bad.tick();
	assert.equal(bad.state.phase, "provision");
	bad.state.failingSince = Date.now() - RETRY_WINDOW_MS - 1;
	await bad.tick();
	assert.equal(bad.state.phase, "done");
	assert.equal(bad.conclusion(), "failure");
	assert.match(bad.state.error!, /network connection lost/);
	assert.ok(machine.destroyed);
});

test("a machine that loses the step fails the job at once", async () => {
	const launch = launchFor([step("S", "true")]);
	const machine = new FlakyMachine(0);
	const runner = new JobRunner(launch, newJobState(launch), machine);
	await runner.tick(); // provision + launch the checkout
	machine.lost = true;
	await runner.tick();
	assert.equal(runner.state.phase, "done");
	assert.match(runner.state.error!, /replaced/);
});

test("a cancel before the machine is up ends the job straight away", async () => {
	const launch = launchFor([step("S", "true")]);
	const machine = new LocalMachine();
	machine.ready = 100;
	const runner = new JobRunner(launch, newJobState(launch), machine);
	await runner.tick();
	runner.cancel();
	await runner.tick();
	assert.equal(runner.conclusion(), "cancelled");
	assert.ok(machine.destroyed);
});

test("a machine that won't stop is tried again, with backoff, until it does", async () => {
	const launch = launchFor([step("S", "echo hi")]);
	const machine = new LocalMachine();
	machine.destroyFailures = 2;
	const runner = new JobRunner(launch, newJobState(launch), machine);
	const { logs } = await run(runner, {
		onTick: () => {
			// Skip the backoff's wait.
			runner.state.nextCleanupAt = 0;
		},
	});
	assert.equal(machine.destroyCalls, 3);
	assert.ok(machine.destroyed);
	assert.ok(runner.settled);
	assert.match(logs.get(2)!, /it'll be tried again/);
});

test("a job isn't settled while its machine runs, and wakes for the next try", async () => {
	const launch = launchFor([step("S", "true")]);
	const machine = new LocalMachine();
	machine.destroyFailures = 100;
	const runner = new JobRunner(launch, newJobState(launch), machine);
	for (let i = 0; i < 50 && !(runner.done && !runner.reportsDue); i++) {
		await runner.tick();
		runner.acked(runner.nextReport(1 << 20));
	}
	assert.ok(runner.done && !runner.reportsDue, "everything was reported");
	assert.ok(!runner.settled);
	const wake = runner.nextWake()!;
	assert.ok(wake >= runner.state.nextCleanupAt && wake > Date.now(), "it waits for the backoff");
	// Past the window, it gives up (the provider's own limit stops the machine).
	runner.state.finishedAt = new Date(Date.now() - CLEANUP_WINDOW_MS - 1).toISOString();
	runner.state.nextCleanupAt = 0;
	await runner.tick();
	assert.ok(runner.settled);
	assert.equal(runner.nextWake(), null);
});

test("a cancel leaves a running always() step to finish", async () => {
	const launch = launchFor([step("Cleanup", "echo begin; sleep 1; echo end", { if: "always()" }), step("Next", "echo no")]);
	const runner = new JobRunner(launch, newJobState(launch), new LocalMachine());
	const { reports, logs } = await run(runner, {
		onTick: (_, seen) => {
			if (seen.get(1)?.includes("begin")) runner.cancel();
		},
	});
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "cancelled");
	assert.equal(final.steps[1].conclusion, "success");
	assert.equal(final.steps[2].conclusion, "skipped");
	assert.match(logs.get(1)!, /end/);
});

test("$GITHUB_ENV from a failed continue-on-error step reaches the next step", async () => {
	const launch = launchFor([step("Sets", 'echo "FROM_FAILED=yes" >> "$GITHUB_ENV"; exit 1', { continueOnError: true }), step("Reads", 'echo "got=$FROM_FAILED"')]);
	const runner = new JobRunner(launch, newJobState(launch), new LocalMachine());
	const { logs } = await run(runner);
	assert.match(logs.get(2)!, /got=yes/);
});

test("a launch started detached (as on Depot) is waited for while pending", async () => {
	const machine = new LocalMachine();
	machine.box.asyncDetached = true;
	const launch = launchFor([step("S", "echo detached-ok")]);
	const runner = new JobRunner(launch, newJobState(launch), machine);
	const { reports, logs } = await run(runner);
	assert.equal(reports.at(-1)!.conclusion, "success");
	assert.match(logs.get(1)!, /detached-ok/);
	const launches = machine.box.calls.filter((c) => c.argv[2]?.includes("mkdir \"$f.lock\""));
	assert.ok(launches.length >= 2 && launches.every((c) => c.opts.detached), "launches are detached");
	// No secret or token in any command's arguments or environment: they only travel as files.
	for (const c of machine.box.calls) {
		const text = JSON.stringify(c);
		assert.ok(!text.includes(SECRET) && !text.includes(TOKEN) && !text.includes(btoa(`x:${TOKEN}`)), text.slice(0, 200));
	}
	assert.ok(machine.box.files.some((f) => f.content.includes(SECRET)), "the step's file carries the environment");
});

test("a launch still pending after the wait fails the job", async () => {
	const launch = launchFor([step("S", "true")]);
	const machine = new FlakyMachine(0);
	const runner = new JobRunner(launch, newJobState(launch), machine);
	machine.sandbox = () => ({
		writeFile: async () => {},
		readFile: async () => "",
		exec: async () => ({ exitCode: 0, stdout: "pending\n0\n\n", stderr: "" }),
	});
	await runner.tick(); // launch
	runner.state.process.launchedAt = Date.now() - 3 * 60_000;
	await runner.tick();
	assert.equal(runner.state.phase, "done");
	assert.match(runner.state.error!, /didn't start/);
});

test("garbled control output is retried within the window, then fails the job", async () => {
	const launch = launchFor([step("S", "true")]);
	const machine = new FlakyMachine(0);
	machine.sandbox = () => ({ writeFile: async () => {}, readFile: async () => "", exec: async () => ({ exitCode: 0, stdout: "???", stderr: "" }) });
	const runner = new JobRunner(launch, newJobState(launch), machine);
	await runner.tick(); // launch (its answer is fine)
	await runner.tick(); // the poll prints garbage: retried
	assert.equal(runner.state.phase, "setup");
	assert.ok(runner.state.failingSince !== null);
	runner.state.failingSince = Date.now() - RETRY_WINDOW_MS - 1;
	await runner.tick();
	assert.equal(runner.state.phase, "done");
	assert.match(runner.state.error!, /printed "\?\?\?"/);
});

const namespaces = NamespaceSandbox.available();

test("steps run as the machine's user, and can't reach the checkout token, the masks or unused secrets", { skip: !namespaces && "no unprivileged user namespaces here" }, async () => {
	const box = new NamespaceSandbox();
	await box.ready();
	try {
		const UNUSED = "unused-secret-value-4321";
		const launch = launchFor([
			step("Who", 'id -u; umask; echo "TOK=$API_KEY" >> "$GITHUB_ENV"; echo started; sleep 2; touch built && stat -c %a built'),
			step("Then", 'echo "tok-len=${#TOK}"; ls /tmp/maggot 2>&1 | head -1 || true; git rev-parse --abbrev-ref HEAD'),
		]);
		launch.mask = [SECRET, UNUSED];
		// The repository must be readable by the namespace's root, which it is (it's ours).
		const runner = new JobRunner(launch, newJobState(launch), new LocalMachine(box));
		const leaks: string[] = [];
		let scanned = false;
		const { reports, logs } = await run(runner, {
			onTick: async (_, seen) => {
				if (scanned || !seen.get(1)?.includes("started")) return;
				scanned = true;
				// Everything uid 1000 can read while a step runs.
				const list = await box.exec(["sh", "-c", `find ${box.root} -type f -readable 2>/dev/null`]);
				for (const file of list.stdout.split("\n").filter(Boolean)) {
					const content = (await box.exec(["cat", file])).stdout;
					for (const needle of [TOKEN, btoa(`x:${TOKEN}`), UNUSED, btoa(UNUSED)]) if (content.includes(needle)) leaks.push(`${file}: ${needle}`);
				}
			},
		});
		assert.ok(scanned, "the scan ran while the step did");
		assert.deepEqual(leaks, []);
		const final = reports.at(-1)!;
		assert.equal(final.conclusion, "success", JSON.stringify([...logs]));
		const who = logs.get(1)!;
		assert.match(who, /^1000$/m, "the step ran as the machine's user");
		assert.match(who, /^0022$/m);
		assert.match(who, /^644$/m, "files it makes are readable by others");
		const then = logs.get(2)!;
		assert.match(then, new RegExp(`tok-len=${SECRET.length}`), "$GITHUB_ENV came back by file and reached the next step");
		assert.match(then, /Permission denied/, "root's state directory is closed to steps");
		assert.match(then, /^master$/m, "the workspace belongs to the step's user");
	} finally {
		box.close();
	}
});

test("state, scripts and masks on the machine are root's and private", { skip: !namespaces && "no unprivileged user namespaces here" }, async () => {
	const box = new NamespaceSandbox();
	await box.ready();
	try {
		const launch = launchFor([step("Hold", "echo started; sleep 2")]);
		const runner = new JobRunner(launch, newJobState(launch), new LocalMachine(box));
		let modes = "";
		await run(runner, {
			onTick: async (_, seen) => {
				if (modes || !seen.get(1)?.includes("started")) return;
				modes = (await box.exec(["sh", "-c", `stat -c '%n %u %a' ${box.state} ${box.state}/step-0.mask ${box.user} ${box.user}/step-0.sh`], { root: true })).stdout;
			},
		});
		const [state, mask, user, script] = modes.trim().split("\n").map((l) => l.split(" ").slice(1).join(" "));
		assert.equal(state, "0 700");
		assert.equal(mask, "0 600");
		assert.equal(user, "1000 711");
		assert.equal(script, "1000 600", "the step's own script is its user's alone");
	} finally {
		box.close();
	}
});
