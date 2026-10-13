/**
 * The steps of one CI job, driven a tick at a time by its Durable Object's alarm (job.ts). Each tick
 * brings the machine up, or moves the checkout or the current step along: starting it detached, then
 * reading its log in slices until its exit code is in. Everything it needs to carry on is in JobState,
 * which the Durable Object saves after every tick, so a restart picks up where it was and nothing runs
 * twice. Kept free of `cloudflare:workers` so it can be tested with a fake machine.
 */

import { DepotApi, DepotError, DepotSandbox, isTerminal, type DepotCredentials } from "./depot.ts";
import { CloudflareSandbox, ExecTimeoutError, type ContainerLike, type Sandbox } from "./sandbox.ts";
import {
	checkoutFile,
	inboxMaskPath,
	inboxPath,
	maskFile,
	ScriptOutputError,
	COLLECT_BYTES,
	COLLECT_SCRIPT,
	completeUtf8,
	KILL_SCRIPT,
	LAUNCH_SCRIPT,
	LogMasker,
	parseCollectSizes,
	collectedPath,
	secretsIn,
	parseEnvFile,
	parsePathFile,
	parsePoll,
	POLL_BYTES,
	POLL_SCRIPT,
	SETUP_ID,
	stepFile,
	stepInterpreter,
	WORKSPACE,
} from "./script.ts";
import { fetchDepthFor, type StepSpec } from "./workflow.ts";

export type StepStatus = "pending" | "in_progress" | "completed";
export type Conclusion = "success" | "failure" | "cancelled" | "skipped";

export interface StepState {
	name: string;
	status: StepStatus;
	conclusion: Conclusion | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface JobLaunch {
	jobId: string;
	/** The coordinator (repository) that owns the run. */
	repo: string;
	runner: { kind: "cloudflare" } | { kind: "depot"; vcpus: number; credentials: DepotCredentials };
	timeoutMinutes: number;
	/** Expressions already filled in. */
	steps: StepSpec[];
	env: Record<string, string>;
	/** Values to hide in the log. */
	mask: string[];
	checkout: { url: string; auth: string; ref: string; sha: string };
}

export interface JobReport {
	status: "in_progress" | "completed";
	conclusion: Conclusion | null;
	error: string | null;
	steps: StepState[];
	logs: { step: number; text: string }[];
	startedAt: string | null;
	finishedAt: string | null;
	/**
	 * Numbers the reports that carry logs, from 1. A report whose answer was lost is sent again with the
	 * same number and logs, so the receiver should keep the logs of each number once.
	 */
	seq?: number;
}

/** The detached process (checkout or step) the job is on. */
interface Process {
	launched: boolean;
	/** When the launch was sent: a launch that's still pending long after it is an error. */
	launchedAt: number | null;
	/** Tries at launching it so far; each uploads its files under its own number. */
	attempt: number;
	/** Bytes of its log read so far. */
	offset: number;
	/** Undecoded bytes at the end of the last slice (part of a UTF-8 character). */
	carry: number[];
	/** Unmasked text held back in case it starts a secret. */
	maskTail: string;
	truncated: boolean;
	/** When it must end (its own or the job's limit). */
	deadline: number;
	/** Set once it's been told to stop: why, when, and whether the hard kill has gone too. */
	stopping: { reason: "cancelled" | "timeout"; at: number; hard: boolean } | null;
}

export interface JobState {
	phase: "provision" | "setup" | "steps" | "done";
	/** Index into launch.steps of the step running or next. */
	step: number;
	process: Process;
	failed: boolean;
	cancelled: boolean;
	/** The cancel has been acted on (the running step told to stop, the deadline brought in). */
	cancelSeen: boolean;
	error: string | null;
	sandboxId: string | null;
	provisionDeadline: number;
	deadline: number;
	/** When the current run of retryable errors began; null after a tick that gets through. */
	failingSince: number | null;
	/** The machine's been stopped (or given up on); until then, `finish` keeps trying. */
	machineStopped: boolean;
	/** Tries at stopping the machine so far, and when to try next. */
	cleanupAttempts: number;
	nextCleanupAt: number;
	/** What steps wrote to $GITHUB_ENV and $GITHUB_PATH, for the steps after them. */
	addedEnv: Record<string, string>;
	addedPath: string[];
	states: StepState[];
	pending: { step: number; text: string }[];
	/** A report that wasn't acknowledged, to send again as it was. */
	unacked: { seq: number; logs: { step: number; text: string }[] } | null;
	seq: number;
	/** The coordinator has the completed report. */
	reportedDone: boolean;
	/** The steps as last acknowledged, and when: a report goes when they change, or as a heartbeat. */
	reportedSteps?: string;
	reportedAt?: number;
	startedAt: string;
	finishedAt: string | null;
}

/** How often the alarm checks on a running step. */
export const TICK_MS = 2_000;
/** How often a job with nothing new reports anyway, so the coordinator knows it's alive. */
export const HEARTBEAT_MS = 60_000;
/** How long a machine has to come up before the job gives up. */
export const PROVISION_MS = 10 * 60_000;
/** After a cancel, how long `always()` and `cancelled()` steps get before the machine is stopped. */
export const CANCEL_GRACE_MS = 5 * 60_000;
/** Between asking a step to stop (SIGTERM) and making it (SIGKILL). */
export const KILL_GRACE_MS = 10_000;
/** How long errors worth retrying (network, Depot, a busy container) may go on before the job fails. */
export const RETRY_WINDOW_MS = 5 * 60_000;
/** How long a launch may stay pending (Depot starts it detached) before the step counts as not started. */
export const LAUNCH_WAIT_MS = 2 * 60_000;
/**
 * How long a job keeps trying to stop its machine after it ends. Past this the provider's own limits
 * stop it: Depot's sandbox timeout (the job's limit plus 15 minutes) and Cloudflare's inactivity
 * timeout (at most 6 hours).
 */
export const CLEANUP_WINDOW_MS = 6 * 3600_000;
const cleanupDelay = (attempts: number) => Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempts, 10));
/** Log kept per step; the rest is skipped (the coordinator keeps 5 MB per job). */
export const MAX_STEP_LOG = 4 * 1024 * 1024;
/** Log text waiting to be reported before reading more: keeps the saved state small. */
export const MAX_PENDING = 96 * 1024;
/** Slices read per tick while a step prints faster than one slice. */
const READS_PER_TICK = 4;

const iso = (ms: number) => new Date(ms).toISOString();

/** Where a job runs: brings the machine up, hands out a Sandbox for it, and stops it. */
export interface Machine {
	/** True once the machine takes commands. Called every tick until then. */
	provision(state: JobState, launch: JobLaunch, save: () => Promise<void>): Promise<boolean>;
	sandbox(state: JobState): Sandbox;
	/** Called each tick while the job runs: false if the machine has gone. */
	alive(state: JobState): Promise<boolean>;
	destroy(state: JobState): Promise<void>;
	/** How the setup log describes it. */
	describe(launch: JobLaunch): string;
}

/** A Cloudflare container attached to the job's Durable Object. */
export class CloudflareMachine implements Machine {
	private readonly box: CloudflareSandbox;
	private kept = 0;

	constructor(container: ContainerLike) {
		this.box = new CloudflareSandbox(container);
	}

	describe(): string {
		return `a Cloudflare container (${this.box.image()})`;
	}

	async provision(state: JobState): Promise<boolean> {
		this.box.start();
		await this.keepAlive(state);
		try {
			await this.box.exec(["true"], { timeoutMs: 15_000 });
			return true;
		} catch {
			// `start` returns before the container is ready; until then commands fail.
			return false;
		}
	}

	sandbox(): Sandbox {
		return this.box;
	}

	/** The inactivity timeout belongs to the Durable Object instance, so it's set again after a restart. */
	private async keepAlive(state: JobState) {
		if (Date.now() - this.kept < 5 * 60_000) return;
		await this.box.keepAlive(state.deadline + 60_000);
		this.kept = Date.now();
	}

	async alive(state: JobState): Promise<boolean> {
		if (!this.box.running) return false;
		await this.keepAlive(state);
		return true;
	}

	async destroy(): Promise<void> {
		await this.box.destroy();
	}
}

/** A Depot sandbox paid for with the repository's Depot token. */
export class DepotMachine implements Machine {
	private readonly api: DepotApi;
	private readonly vcpus: number;
	private checked = 0;

	constructor(credentials: DepotCredentials, vcpus: number, opts: { fetch?: typeof fetch } = {}) {
		this.api = new DepotApi(credentials, opts);
		this.vcpus = vcpus;
	}

	describe(): string {
		return `a Depot sandbox (${this.vcpus} vCPUs)`;
	}

	async provision(state: JobState, launch: JobLaunch, save: () => Promise<void>): Promise<boolean> {
		if (!state.sandboxId) {
			const name = `megit-${launch.jobId}`;
			// Its lifetime counts from now; the job's own deadline comes first, so this only reaps it if megit can't.
			const minutes = Math.ceil((state.deadline - Date.now()) / 60_000) + 15;
			try {
				state.sandboxId = (await this.api.create({ name, vcpus: this.vcpus, timeoutMinutes: minutes })).id;
			} catch (err) {
				// Created before a restart lost the answer: find it by its name, unique in the organization.
				if (!(err instanceof DepotError && err.code === "already_exists")) throw err;
				const found = await this.api.findByName(name);
				if (!found) throw new DepotError("already_exists", `Depot has a sandbox called ${name} that megit can't find`);
				state.sandboxId = found.id;
			}
			await save();
		}
		const sandbox = await this.api.get(state.sandboxId);
		if (isTerminal(sandbox.status)) throw new DepotError("failed_precondition", `The Depot sandbox stopped before the job could start (${sandbox.status}${sandbox.errorMessage ? `: ${sandbox.errorMessage}` : ""})`);
		return sandbox.status === "running";
	}

	sandbox(state: JobState): Sandbox {
		return new DepotSandbox(this.api, state.sandboxId!);
	}

	/** Asks Depot every half minute; in between, a lost sandbox shows up as a failing command anyway. */
	async alive(state: JobState): Promise<boolean> {
		if (Date.now() - this.checked < 30_000) return true;
		const ok = !isTerminal((await this.api.get(state.sandboxId!)).status);
		this.checked = Date.now();
		return ok;
	}

	async destroy(state: JobState): Promise<void> {
		if (state.sandboxId) await this.api.kill(state.sandboxId);
	}
}

/** The exit code given to a process that ended without recording one. */
const LOST = -1;

/** The machine's gone (stopped, replaced, or it lost the step), so the job can't go on. */
class MachineLost extends Error {}

/** Worth another try next tick, rather than failing the job. */
function transient(err: unknown): boolean {
	if (err instanceof MachineLost) return false;
	// A control command that failed without saying so: the machine may be busy; poll again.
	if (err instanceof ScriptOutputError) return true;
	if (err instanceof DepotError) return err.transient;
	// Container commands that time out or fail to start are usually the host being busy.
	return err instanceof ExecTimeoutError || err instanceof TypeError || /network|connection|reset|timed? ?out|unavailable|overloaded/i.test(String(err));
}

const freshProcess = (deadline: number): Process => ({ launched: false, launchedAt: null, attempt: 0, offset: 0, carry: [], maskTail: "", truncated: false, deadline, stopping: null });

export function newJobState(launch: JobLaunch, nowMs = Date.now()): JobState {
	const step = (name: string): StepState => ({ name, status: "pending", conclusion: null, startedAt: null, finishedAt: null });
	const deadline = nowMs + launch.timeoutMinutes * 60_000;
	return {
		phase: "provision",
		step: 0,
		process: freshProcess(deadline),
		failed: false,
		cancelled: false,
		cancelSeen: false,
		error: null,
		sandboxId: null,
		provisionDeadline: nowMs + PROVISION_MS,
		deadline,
		failingSince: null,
		machineStopped: false,
		cleanupAttempts: 0,
		nextCleanupAt: 0,
		addedEnv: {},
		addedPath: [],
		states: [step("Set up job"), ...launch.steps.map((s) => step(s.name)), step("Complete job")],
		pending: [],
		unacked: null,
		seq: 0,
		reportedDone: false,
		startedAt: iso(nowMs),
		finishedAt: null,
	};
}

/** Whether a step's `if` lets it run, given how the job has gone so far. */
export function shouldRun(condition: StepSpec["if"], failed: boolean, cancelled: boolean): boolean {
	if (condition === "always") return true;
	if (condition === "cancelled") return cancelled;
	if (cancelled) return false;
	if (condition === "failure") return failed;
	if (condition === "notCancelled") return true;
	return !failed;
}

/** The base64 checkout token and the token inside it, which the log must never show. */
function checkoutSecrets(auth: string): string[] {
	if (!auth) return [];
	try {
		const decoded = atob(auth);
		return [auth, decoded, decoded.slice(decoded.indexOf(":") + 1)];
	} catch {
		return [auth];
	}
}

export class JobRunner {
	readonly state: JobState;
	private readonly launch: JobLaunch;
	private readonly machine: Machine;
	private readonly save: () => Promise<void>;
	private readonly secrets: string[];

	constructor(launch: JobLaunch, state: JobState, machine: Machine, save: () => Promise<void> = async () => {}) {
		this.launch = launch;
		this.state = state;
		this.machine = machine;
		this.save = save;
		this.secrets = [...launch.mask, ...checkoutSecrets(launch.checkout.auth)];
	}

	get done(): boolean {
		return this.state.phase === "done";
	}

	/** Log text read but not yet reported. */
	get backlog(): number {
		return this.state.pending.reduce((n, e) => n + e.text.length, 0);
	}

	log(index: number, text: string) {
		if (!text) return;
		const last = this.state.pending.at(-1);
		if (last && last.step === index) last.text += text;
		else this.state.pending.push({ step: index, text });
	}

	/** One tick: moves the job on, or settles it. True if there's more log to read at once. */
	async tick(): Promise<boolean> {
		const { state } = this;
		if (state.phase === "done") {
			await this.cleanUp();
			return false;
		}
		try {
			const more = await this.advance();
			state.failingSince = null;
			return more;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const now = Date.now();
			state.failingSince ??= now;
			if (transient(err) && now - state.failingSince < RETRY_WINDOW_MS && now < state.deadline) {
				console.warn(`ci: job ${this.launch.jobId}: retrying after: ${message}`);
				return false;
			}
			// Anything else ends the job as failed, with the reason shown, rather than looping forever.
			this.fail(message);
			await this.finish();
			return false;
		}
	}

	cancel() {
		this.state.cancelled = true;
	}

	private fail(message: string) {
		const { state } = this;
		state.failed = true;
		state.error ??= message;
		const index = state.phase === "provision" || state.phase === "setup" ? 0 : state.step + 1;
		const s = state.states[index];
		if (s && s.status !== "completed") {
			this.log(index, `\n${message}\n`);
			Object.assign(s, { status: "completed", conclusion: "failure", startedAt: s.startedAt ?? iso(Date.now()), finishedAt: iso(Date.now()) });
		}
	}

	private async advance(): Promise<boolean> {
		const { state } = this;
		const now = Date.now();
		if (state.cancelled && !state.cancelSeen) {
			state.cancelSeen = true;
			state.error ??= "The run was cancelled";
			// Before the steps there's nothing to clean up after; during them, always() and cancelled() steps get a while.
			if (state.phase !== "steps") return this.finish().then(() => false);
			state.deadline = Math.min(state.deadline, now + CANCEL_GRACE_MS);
			state.process.deadline = Math.min(state.process.deadline, state.deadline);
			// A step that would run anyway once cancelled (always(), cancelled()) is left to finish, as on GitHub.
			const spec = this.launch.steps[state.step];
			if (state.process.launched && !state.process.stopping && spec && !shouldRun(spec.if, state.failed, true)) await this.stop("cancelled", false);
		}
		if (now > state.deadline) {
			if (!state.cancelled) this.fail(`The job ran longer than its ${this.launch.timeoutMinutes}-minute limit (timeout-minutes), so it was stopped`);
			await this.finish();
			return false;
		}
		const setup = state.states[0];
		if (state.phase === "provision") {
			if (setup.status === "pending") {
				Object.assign(setup, { status: "in_progress", startedAt: iso(now) });
				this.log(0, `Starting ${this.machine.describe(this.launch)}…\n`);
			}
			if (!(await this.machine.provision(state, this.launch, this.save))) {
				if (Date.now() > state.provisionDeadline) throw new MachineLost(`The machine didn't come up within ${PROVISION_MS / 60_000} minutes`);
				return false;
			}
			this.log(0, "The machine is up.\n");
			state.phase = "setup";
			state.process = freshProcess(state.deadline);
		} else if (!(await this.machine.alive(state))) {
			throw new MachineLost("The machine running the job stopped unexpectedly");
		}
		if (state.phase === "setup") {
			const { launch } = this;
			const file = checkoutFile({ ...launch.checkout, depth: fetchDepthFor(launch.steps) });
			// The checkout runs as root; its log is masked for the checkout token alone.
			const result = await this.drive(SETUP_ID, 0, file, "sh -e", false, checkoutSecrets(launch.checkout.auth));
			if (result.exitCode === null) return result.more;
			if (result.exitCode !== 0) {
				this.fail(`Checking out ${launch.checkout.sha.slice(0, 7)} failed (${result.exitCode === LOST ? "the checkout ended without an exit code" : `exit code ${result.exitCode}`})`);
				await this.finish();
				return false;
			}
			Object.assign(setup, { status: "completed", conclusion: "success", finishedAt: iso(Date.now()) });
			state.phase = "steps";
			state.process = freshProcess(state.deadline);
		}
		// Steps that finish at once (checkout, skipped ones) shouldn't each cost a tick.
		for (let guard = 0; guard < 200 && state.phase === "steps"; guard++) {
			const r = await this.runStep();
			if (r !== "next") return r === "more";
		}
		return false;
	}

	/** Tells the current process to stop: SIGTERM, then SIGKILL once the grace is up. */
	private async stop(reason: "cancelled" | "timeout", hard: boolean) {
		const { process } = this.state;
		const id = this.state.phase === "setup" ? SETUP_ID : String(this.state.step);
		await this.machine.sandbox(this.state).exec(["sh", "-c", KILL_SCRIPT], { env: { MEGIT_ID: id, MEGIT_SIGNAL: hard ? "KILL" : "TERM" }, root: true });
		process.stopping = { reason, at: process.stopping?.at ?? Date.now(), hard };
	}

	/**
	 * Starts the process if it hasn't been, enforces its deadline, and reads its log. Its exit code once
	 * it's ended and its log has been read; `more` when there's log left to read now.
	 */
	private async drive(id: string, index: number, file: string, interpreter: string, asUser: boolean, maskFor: string[]): Promise<{ exitCode: number | null; more: boolean }> {
		// Control commands run as root; the step itself, as the machine's user when asUser (see script.ts).
		const root = true;
		const { state } = this;
		const p = state.process;
		const sandbox = this.machine.sandbox(state);
		if (!p.launched) {
			// The script (which holds the environment, secrets included) goes as a file; the launch only names it.
			// Each try writes files of its own, numbered, saved first: a delayed launch from an earlier try
			// (Depot's are detached) only ever takes files that were written whole before it was sent.
			const attempt = ++p.attempt;
			await this.save();
			// The mask holds only what this process could print: the secrets in its own script.
			const mask = maskFile(maskFor);
			if (mask) await sandbox.writeFile(inboxMaskPath(id, attempt), mask);
			await sandbox.writeFile(inboxPath(id, attempt), file);
			const env = { MEGIT_ID: id, MEGIT_ATTEMPT: String(attempt), MEGIT_INTERPRETER: interpreter, MEGIT_AS_USER: asUser ? "1" : "0" };
			const result = await sandbox.exec(["sh", "-c", LAUNCH_SCRIPT], { env, root, detached: true });
			if (result.exitCode !== 0) throw new Error(`The step couldn't start: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
			p.launched = true;
			p.launchedAt = Date.now();
			await this.save();
			return { exitCode: null, more: false };
		}
		const now = Date.now();
		if (!p.stopping && now > p.deadline) await this.stop("timeout", false);
		else if (p.stopping && !p.stopping.hard && now > p.stopping.at + KILL_GRACE_MS) await this.stop(p.stopping.reason, true);
		const masker = new LogMasker(this.secrets, p.maskTail);
		const decoder = new TextDecoder();
		for (let read = 0; read < READS_PER_TICK; read++) {
			const max = p.truncated ? 0 : Math.min(POLL_BYTES, MAX_STEP_LOG - p.offset);
			const out = await sandbox.exec(["sh", "-c", POLL_SCRIPT], { env: { MEGIT_ID: id, MEGIT_OFFSET: String(p.offset), MEGIT_MAX: String(max) }, root });
			if (out.exitCode !== 0) throw new ScriptOutputError(`Checking on the step failed (exit code ${out.exitCode}): ${out.stderr.trim().slice(0, 300)}`);
			const poll = parsePoll(out.stdout);
			if (poll.state === "missing") throw new MachineLost("The machine running the job was replaced, and the step with it");
			if (poll.state === "pending") {
				if (Date.now() - (p.launchedAt ?? 0) > LAUNCH_WAIT_MS) throw new MachineLost(`The step didn't start within ${LAUNCH_WAIT_MS / 60_000} minutes of being launched`);
				return { exitCode: null, more: false };
			}
			const exitCode = poll.state === "lost" ? LOST : poll.state === "running" ? null : poll.state;
			p.offset += poll.bytes.length;
			const [whole, rest] = completeUtf8(new Uint8Array([...p.carry, ...poll.bytes]));
			p.carry = [...rest];
			this.log(index, masker.push(decoder.decode(whole)));
			if (!p.truncated && p.offset >= MAX_STEP_LOG && poll.size > p.offset) {
				p.truncated = true;
				this.log(index, masker.flush() + `\n… this step printed more than ${MAX_STEP_LOG / 1024 / 1024} MB, so the rest of its output isn't shown\n`);
			}
			const readAll = p.truncated || p.offset >= poll.size;
			if (exitCode !== null && readAll) {
				this.log(index, masker.flush() + (p.carry.length ? decoder.decode(new Uint8Array(p.carry)) : ""));
				if (exitCode === LOST) this.log(index, "\nThe step's process ended without recording how (the machine may have killed it for using too much memory)\n");
				p.carry = [];
				p.maskTail = "";
				return { exitCode, more: false };
			}
			p.maskTail = masker.tail;
			if (readAll || this.backlog >= MAX_PENDING) return { exitCode: null, more: !readAll };
		}
		return { exitCode: null, more: true };
	}

	/** Moves the current step along: "next" when it's finished, "more" when there's log to read now. */
	private async runStep(): Promise<"next" | "more" | "wait"> {
		const { state, launch } = this;
		if (state.step >= launch.steps.length) {
			await this.finish();
			return "wait";
		}
		const spec = launch.steps[state.step];
		const index = state.step + 1;
		const s = state.states[index];
		const next = () => {
			state.step++;
			state.process = freshProcess(state.deadline);
			return "next" as const;
		};
		if (!state.process.launched && !shouldRun(spec.if, state.failed, state.cancelled)) {
			Object.assign(s, { status: "completed", conclusion: "skipped" });
			return next();
		}
		if (spec.run === null) {
			Object.assign(s, { status: "completed", conclusion: "success", startedAt: iso(Date.now()), finishedAt: iso(Date.now()) });
			this.log(index, `The commit was checked out into ${WORKSPACE} when the job was set up.\n`);
			return next();
		}
		if (!state.process.launched) {
			Object.assign(s, { status: "in_progress", startedAt: iso(Date.now()) });
			if (spec.timeoutMinutes) state.process.deadline = Math.min(state.deadline, Date.now() + spec.timeoutMinutes * 60_000);
		}
		const file = stepFile(spec, launch.env, state.addedEnv, state.addedPath);
		const { exitCode, more } = await this.drive(String(state.step), index, file, stepInterpreter(spec), true, secretsIn(file, launch.mask));
		if (exitCode === null) return more ? "more" : "wait";
		const stopped = state.process.stopping;
		// As on GitHub, what a step wrote to $GITHUB_ENV counts for the steps after it however it ended.
		await this.collect(index);
		// A step stopped for its time limit failed, whatever its exit code (a TERM trap can exit 0).
		const ok = exitCode === 0 && stopped?.reason !== "timeout";
		let conclusion: Conclusion = ok || spec.continueOnError ? "success" : "failure";
		if (stopped?.reason === "cancelled") {
			conclusion = "cancelled";
			this.log(index, "\nThe step was stopped because the run was cancelled\n");
		} else if (stopped?.reason === "timeout") {
			this.log(index, `\nThe step ran past its ${spec.timeoutMinutes ? `${spec.timeoutMinutes}-minute limit` : "job's time limit"}, so it was stopped\n`);
		} else if (!ok && exitCode !== LOST) {
			this.log(index, `\nProcess exited with code ${exitCode}${spec.continueOnError ? " (continue-on-error is set, so the job goes on)" : ""}\n`);
		}
		Object.assign(s, { status: "completed", conclusion, finishedAt: iso(Date.now()) });
		if (!ok && !spec.continueOnError && stopped?.reason !== "cancelled") state.failed = true;
		return next();
	}

	/** Takes in what the step wrote to $GITHUB_ENV and $GITHUB_PATH, for the steps after it. */
	private async collect(index: number) {
		const { state } = this;
		const sandbox = this.machine.sandbox(state);
		const id = String(state.step);
		// The command prints only sizes; the content (which may hold secrets) comes back as files.
		const result = await sandbox.exec(["sh", "-c", COLLECT_SCRIPT], { env: { MEGIT_ID: id }, root: true });
		if (result.exitCode !== 0) throw new ScriptOutputError(`Collecting $GITHUB_ENV failed (exit code ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`);
		const sizes = parseCollectSizes(result.stdout);
		const env = await sandbox.readFile(collectedPath(id, "env"));
		const path = await sandbox.readFile(collectedPath(id, "path"));
		const envCut = Math.max(0, sizes.env - COLLECT_BYTES);
		const pathCut = Math.max(0, sizes.path - COLLECT_BYTES);
		for (const [name, cut] of [["$GITHUB_ENV", envCut], ["$GITHUB_PATH", pathCut]] as const) {
			if (cut) this.log(index, `${name} had ${cut} bytes past the first ${COLLECT_BYTES / 1024} KB, which were left out\n`);
		}
		const parsed = parseEnvFile(env);
		state.addedEnv = { ...state.addedEnv, ...parsed.env };
		for (const error of parsed.errors) this.log(index, `${error}\n`);
		for (const dir of parsePathFile(path)) if (!state.addedPath.includes(dir)) state.addedPath.push(dir);
	}

	/** Stops the machine and settles the job. */
	async finish(): Promise<void> {
		const { state } = this;
		if (state.phase === "done") return;
		const last = state.states.length - 1;
		const t = iso(Date.now());
		Object.assign(state.states[last], { status: "in_progress", startedAt: t });
		for (const s of state.states.slice(0, last)) {
			if (s.status !== "completed") Object.assign(s, { status: "completed", conclusion: state.cancelled ? "cancelled" : "skipped", finishedAt: s.startedAt ? t : null });
		}
		state.phase = "done";
		state.process = freshProcess(state.deadline);
		state.addedEnv = {};
		state.nextCleanupAt = Date.now();
		if (await this.cleanUp()) this.log(last, "Stopped the machine.\n");
		else this.log(last, "Stopping the machine failed; it'll be tried again until it works.\n");
		Object.assign(state.states[last], { status: "completed", conclusion: "success", finishedAt: iso(Date.now()) });
		state.finishedAt = iso(Date.now());
	}

	/**
	 * Stops the machine once the job is done, if that hasn't worked yet: tried again with backoff, for
	 * CLEANUP_WINDOW_MS after the job ended. True once it's stopped (or given up on).
	 */
	async cleanUp(): Promise<boolean> {
		const { state } = this;
		if (state.machineStopped) return true;
		if (Date.now() < state.nextCleanupAt) return false;
		try {
			await this.machine.destroy(state);
			state.machineStopped = true;
		} catch (err) {
			state.cleanupAttempts++;
			state.nextCleanupAt = Date.now() + cleanupDelay(state.cleanupAttempts);
			const ended = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
			console.error(`ci: job ${this.launch.jobId}: stopping the machine failed (attempt ${state.cleanupAttempts}): ${err instanceof Error ? err.message : String(err)}`);
			if (Date.now() - ended > CLEANUP_WINDOW_MS) {
				console.error(`ci: job ${this.launch.jobId}: gave up stopping the machine; the provider's own limit will`);
				state.machineStopped = true;
			}
		}
		return state.machineStopped;
	}

	/** Whether there's anything the coordinator doesn't have yet, or a heartbeat is due. */
	get reportsDue(): boolean {
		const { state } = this;
		if (state.pending.length > 0 || state.unacked !== null) return true;
		if (state.reportedDone) return false;
		if (state.phase === "done") return true;
		return JSON.stringify(state.states) !== state.reportedSteps || Date.now() - (state.reportedAt ?? 0) >= HEARTBEAT_MS;
	}

	/** When the job next needs a tick, or null once it's settled. */
	nextWake(nowMs = Date.now()): number | null {
		if (this.settled) return null;
		if (this.state.phase === "done" && !this.reportsDue) return Math.max(nowMs, this.state.nextCleanupAt);
		return nowMs + TICK_MS;
	}

	conclusion(): Conclusion | null {
		const { state } = this;
		if (state.phase !== "done") return null;
		return state.cancelled ? "cancelled" : state.failed ? "failure" : "success";
	}

	/**
	 * The next report: the one that wasn't acknowledged, else a new one with up to `maxBytes` of
	 * pending log. Call `acked` once the coordinator has it.
	 */
	nextReport(maxBytes: number): JobReport {
		const { state } = this;
		if (!state.unacked && state.pending.length) {
			const logs: { step: number; text: string }[] = [];
			let size = 0;
			while (state.pending.length && size < maxBytes) {
				const entry = state.pending[0];
				const room = maxBytes - size;
				if (entry.text.length <= room) {
					logs.push(state.pending.shift()!);
					size += entry.text.length;
				} else {
					logs.push({ step: entry.step, text: entry.text.slice(0, room) });
					entry.text = entry.text.slice(room);
					size = maxBytes;
				}
			}
			state.unacked = { seq: ++state.seq, logs };
		}
		const done = state.phase === "done" && state.pending.length === 0;
		return {
			status: done ? "completed" : "in_progress",
			conclusion: done ? this.conclusion() : null,
			error: state.error,
			steps: state.states,
			logs: state.unacked?.logs ?? [],
			startedAt: state.startedAt,
			finishedAt: done ? state.finishedAt : null,
			...(state.unacked ? { seq: state.unacked.seq } : {}),
		};
	}

	/** The coordinator has `report`. */
	acked(report: JobReport) {
		this.state.unacked = null;
		this.state.reportedSteps = JSON.stringify(report.steps);
		this.state.reportedAt = Date.now();
		if (report.status === "completed") this.state.reportedDone = true;
	}

	/** Whether everything, the final state included, has reached the coordinator, and the machine is stopped. */
	get settled(): boolean {
		return !this.reportsDue && this.state.machineStopped;
	}
}
