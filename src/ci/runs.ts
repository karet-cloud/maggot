import type { PullChecks, CiArtifact, CiCache, CiConclusion, CiEvent, CiJob as CiJobInfo, CiLogChunk, CiRun, CiRunList, CiRunner, CiRunSummary, CiSettings, CiStatus, CiStep, CiWorkflow } from "../api.ts";
import { HttpError } from "../errors.ts";
import type { RepositoryRef } from "../hooks.ts";
import type { RepoStore } from "../store.ts";
import { ActionFetchError, GitHubActions, resolveActions, type ActionSource } from "./actions.ts";
import { nextRun, parseCron } from "./cron.ts";
import { checkDepotCredentials, DepotError, type DepotCredentials } from "./depot.ts";
import { evaluate, ExpressionError, parseCondition, parseTemplate, propertiesOf, render, truthy, type Expression, type Value } from "./expr.ts";
import type { JobLaunch, JobReport } from "./job.ts";
import { buildPlan } from "./plan.ts";
import { MIN_MASKED_LENGTH } from "./script.ts";
import { CiStorage } from "./storage.ts";
import { mintCheckoutToken, mintJobToken, openSecret, sealSecret, type JobGrant } from "./token.ts";
import {
	fetchDepthFor,
	filterAllows,
	jobTexts,
	MAX_WORKFLOWS,
	parseWorkflow,
	typeAllows,
	WORKFLOW_DIR,
	WorkflowError,
	type JobSpec,
	type PullRequestType,
	type WorkflowSpec,
} from "./workflow.ts";

/**
 * A repository's Actions runs, kept in its coordinator's SQLite: runs, their jobs, the jobs' logs,
 * and the repository's CI settings and secrets (encrypted). Each job runs in its own CiJob Durable
 * Object, which reports back here; this starts jobs as their `needs` finish, a few at a time, and the
 * coordinator's alarm (`tick`) retries what didn't get through: starting a job, cancelling one, and
 * giving up on a job that stopped reporting.
 */

/** Jobs running at once per repository; the rest wait their turn. */
const MAX_RUNNING_JOBS = 4;
/** Finished runs kept per repository, newest first; older ones go with their logs (but not those on an open pull request's head). */
const MAX_RUNS = 300;
/**
 * Finished runs nobody who can write approved (a reader's or fork's: broken workflow files, expired or
 * cancelled waiting runs) are kept apart from MAX_RUNS, so they can't push writers' history out.
 */
const MAX_UNAPPROVED_RUNS = 100;
const MAX_UNAPPROVED_RUNS_PER_AUTHOR = 20;
/** Runs waiting for approval at once, per repository and per pull request author; past that, a writer starts them. */
const MAX_WAITING = 100;
const MAX_WAITING_PER_AUTHOR = 20;
/** A run nobody approved in this long is cancelled. */
const WAITING_TTL_MS = 7 * 24 * 3600_000;
/** Shortest secret value the runner hides in logs; shorter ones would match ordinary text. */
export const MIN_SECRET_LENGTH = MIN_MASKED_LENGTH;
/** Log kept per job. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Log kept per repository; the oldest finished runs' logs go first. */
const MAX_TOTAL_LOG_BYTES = 512 * 1024 * 1024;
const MAX_SECRETS = 100;
const MAX_SECRET_BYTES = 48 * 1024;
const MAX_WORKFLOW_BYTES = 256 * 1024;
/** Attempts at handing a job to its Durable Object before it fails. */
const MAX_DISPATCH_ATTEMPTS = 5;
/** Attempts at starting a pull request's runs before it's left for someone to start them by hand. */
const MAX_PULL_ATTEMPTS = 10;
/** Workflow files read per commit are kept in memory for this many commits. */
const WORKFLOW_CACHE = 50;
/** A job that hasn't reported for this long is presumed lost (its object reports every few seconds). */
const SILENCE_MS = 15 * 60_000;
/** How often the alarm looks in while jobs are queued or running. */
const TICK_MS = 30_000;
/**
 * How long a job's checkout token works. The commit is checked out once, while the job is set up: its
 * sandbox has 10 minutes to come up (runner.ts's PROVISION_MS), and the fetch itself takes the rest.
 */
const CHECKOUT_TOKEN_MS = 30 * 60_000;
/** How long after a job's time limit its job token (caches, artifacts, actions) still works: its post steps and cleanup. */
const JOB_TOKEN_GRACE_MS = 30 * 60_000;
/** How often caches and artifacts past their time are cleared out. */
const STORAGE_PRUNE_MS = 3600_000;
/** A scheduled run that's this late (the alarm was held up) still runs once; later ones are skipped to the next. */
const SCHEDULE_SLACK_MS = 15 * 60_000;

/** The job's Durable Object, as far as the run engine uses it. */
export interface JobStub {
	start(launch: JobLaunch): Promise<void>;
	cancel(): Promise<void>;
}

export interface CiHost {
	sql: SqlStorage;
	env: { MAGGOT_API_KEY?: string; MAGGOT_CI_CLOUDFLARE?: string; CI_BUCKET?: R2Bucket };
	store: RepoStore;
	/** Where actions on GitHub are read from (tests pass a stand-in). */
	github?: Pick<GitHubActions, "resolve" | "readFile">;
	/** The CiJob Durable Object for a job id. */
	job(id: string): JobStub;
	/** This repository's id, also its storage name and its coordinator's name. */
	repoId(): string;
	repository(): RepositoryRef;
	/** A run finished: for the feed and workflow_run webhooks. `headRepo` is where its code came from, when not here. */
	emit(data: Record<string, unknown>, headRepo: string | null): void;
	/** Runs were created or jobs started: open pages refresh (not recorded in the feed). */
	changed(): void;
	/** Asks for `tick` at (or before) `at`. */
	wake(at: number): Promise<void>;
	/** An archived repository starts nothing; what was running is cancelled when it's archived. */
	archived(): boolean;
}

/**
 * A run of a private fork's code (its pull request's workflows), as shown to people who can't read the
 * fork, and in webhooks: that it ran, on what commit and how it ended, but not its branch or workflow.
 */
export function privateRun<T extends Pick<CiRunSummary, "workflow" | "path" | "branch">>(run: T): T {
	return { ...run, workflow: "(private fork)", path: "", branch: "", ...("error" in run ? { error: null } : {}) };
}

/** What started a run, kept so a re-run starts the same way. */
export interface Trigger {
	event: CiEvent;
	branch: string;
	sha: string;
	pull: number | null;
	/** Storage name of the repository holding the commit (a fork's, for its pull requests); null for this one. */
	headRepo: string | null;
	/** Where jobs clone the commit from; for this repository it's looked up again when a job starts. */
	cloneUrl: string;
	fromFork: boolean;
	actor: string | null;
	baseBranch: string | null;
}

export interface PullTrigger {
	number: number;
	headRepo: string | null;
	cloneUrl: string;
	branch: string;
	sha: string;
	baseBranch: string;
	fromFork: boolean;
	actor: string | null;
	/** What happened: opened, reopened, or new commits (synchronize); `on.pull_request.types` filters on it. */
	action: PullRequestType;
	/**
	 * Whoever caused it can write to the repository, so its runs needn't wait for approval. Runs for
	 * anyone else (a reader's pull request, a fork's) wait for someone who can merge.
	 */
	approved?: boolean;
	/** The pull request's author, for the cap on runs waiting for approval. */
	author?: string | null;
	/**
	 * Start missing checks: create runs only for these workflow paths, and past the waiting cap (someone
	 * who can merge asked). Whether they wait is the head's own (see `startPull`), not the asker's.
	 */
	only?: string[];
}

/** What a job hears back from a report: stop if the run was cancelled or is gone. */
export interface ReportAck {
	cancel: boolean;
}

/** `seq` numbers reports, so one delivered twice (its answer lost) doesn't add its log twice. */
export type SequencedReport = JobReport & { seq?: number };

export type ChecksState = "none" | "pending" | "success" | "failure";

/** What a run summary needs: everything but the stored workflow and trigger, which can be large. */
const SUMMARY = "number, workflow, path, event, branch, sha, pull, from_fork, actor, status, conclusion, error, created_at, started_at, finished_at";
type SummaryRow = Omit<RunRow, "spec" | "trigger" | "author" | "approved">;

type RunRow = {
	number: number;
	workflow: string;
	path: string;
	event: CiEvent;
	branch: string;
	sha: string;
	pull: number | null;
	from_fork: number;
	actor: string | null;
	status: CiStatus;
	conclusion: CiConclusion | null;
	error: string | null;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	spec: string;
	trigger: string;
	author: string | null;
	approved: number;
};

type JobRow = {
	id: string;
	run: number;
	key: string;
	name: string;
	runner: CiRunner;
	vcpus: number | null;
	needs: string;
	status: CiStatus;
	conclusion: CiConclusion | null;
	error: string | null;
	steps: string;
	started_at: string | null;
	finished_at: string | null;
	log_bytes: number;
	timeout_minutes: number;
	dispatched: number;
	dispatch_attempts: number;
	cancel_pending: number;
	report_seq: number;
	reported_at: number | null;
	/** The job's id as written; a matrix's jobs share it. Null for jobs made before matrices. */
	grp: string | null;
	/** Its outputs (JSON), once it has finished. */
	outputs: string | null;
};

type Settings = { defaultRunner?: CiRunner; depotToken?: string; depotOrg?: string | null };

const now = () => new Date().toISOString();
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class CiRuns {
	private readonly host: CiHost;
	readonly storage: CiStorage;
	/** A commit's workflow files never change; checks are polled, so they're kept a while. */
	private readonly workflowCache = new Map<string, Promise<{ path: string; spec: WorkflowSpec | null; error: string | null }[]>>();
	/**
	 * The pull request event drain in progress. One at a time: a drain reads the head, waits on storage,
	 * then acts, and the coordinator takes other requests while it waits, so a second drain could act on
	 * a newer head in between and then be undone by the first.
	 */
	private draining: Promise<void> = Promise.resolve();

	constructor(host: CiHost) {
		this.host = host;
		this.storage = new CiStorage(host.sql, host.env.CI_BUCKET, () => host.repoId());
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS ci_runs (
				number INTEGER PRIMARY KEY AUTOINCREMENT,
				workflow TEXT NOT NULL,
				path TEXT NOT NULL,
				event TEXT NOT NULL,
				branch TEXT NOT NULL,
				sha TEXT NOT NULL,
				pull INTEGER,
				from_fork INTEGER NOT NULL DEFAULT 0,
				actor TEXT,
				status TEXT NOT NULL,
				conclusion TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				started_at TEXT,
				finished_at TEXT,
				spec TEXT NOT NULL,
				trigger TEXT NOT NULL,
				author TEXT,
				-- 0 for a run nobody who can write asked for or approved (see MAX_UNAPPROVED_RUNS).
				approved INTEGER NOT NULL DEFAULT 1
			);
			CREATE INDEX IF NOT EXISTS ci_runs_sha ON ci_runs (sha);
			CREATE INDEX IF NOT EXISTS ci_runs_pull ON ci_runs (pull);
			CREATE INDEX IF NOT EXISTS ci_runs_status ON ci_runs (status);
			CREATE TABLE IF NOT EXISTS ci_jobs (
				id TEXT PRIMARY KEY,
				run INTEGER NOT NULL,
				key TEXT NOT NULL,
				name TEXT NOT NULL,
				runner TEXT NOT NULL,
				vcpus INTEGER,
				needs TEXT NOT NULL,
				status TEXT NOT NULL,
				conclusion TEXT,
				error TEXT,
				steps TEXT NOT NULL DEFAULT '[]',
				started_at TEXT,
				finished_at TEXT,
				log_bytes INTEGER NOT NULL DEFAULT 0,
				timeout_minutes INTEGER NOT NULL DEFAULT 30,
				dispatched INTEGER NOT NULL DEFAULT 0,
				dispatch_attempts INTEGER NOT NULL DEFAULT 0,
				cancel_pending INTEGER NOT NULL DEFAULT 0,
				report_seq INTEGER NOT NULL DEFAULT 0,
				reported_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS ci_jobs_run ON ci_jobs (run);
			CREATE INDEX IF NOT EXISTS ci_jobs_status ON ci_jobs (status);
			CREATE TABLE IF NOT EXISTS ci_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, step INTEGER NOT NULL, text TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS ci_logs_job ON ci_logs (job, seq);
			CREATE TABLE IF NOT EXISTS ci_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
			-- Pull request events not yet acted on, oldest first; each is retried until its runs start.
			CREATE TABLE IF NOT EXISTS ci_pull_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, pull INTEGER NOT NULL, input TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
			-- Each pull request's head as last acted on, and whether it's open.
			-- approved: whether the head's runs needed no approval (whoever caused them could write), for Start missing checks.
			CREATE TABLE IF NOT EXISTS ci_pulls (pull INTEGER PRIMARY KEY, sha TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0);
			-- Which events (opened, reopened, synchronize) each head of a pull request had, for on.pull_request.types.
			CREATE TABLE IF NOT EXISTS ci_pull_events (pull INTEGER NOT NULL, sha TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY (pull, sha, action));
			-- The default branch's scheduled workflows, and when each schedule next runs (ms).
			CREATE TABLE IF NOT EXISTS ci_schedules (path TEXT NOT NULL, cron TEXT NOT NULL, next_at INTEGER NOT NULL, PRIMARY KEY (path, cron));
		`);
		// Added with matrices and job outputs: the job's id as written (shared by a matrix's jobs), and its outputs once done.
		const columns = new Set(host.sql.exec<{ name: string }>("PRAGMA table_info(ci_jobs)").toArray().map((c) => c.name));
		if (!columns.has("grp")) host.sql.exec("ALTER TABLE ci_jobs ADD COLUMN grp TEXT");
		if (!columns.has("outputs")) host.sql.exec("ALTER TABLE ci_jobs ADD COLUMN outputs TEXT");
	}

	private get sql() {
		return this.host.sql;
	}

	private get apiKey(): string {
		const key = this.host.env.MAGGOT_API_KEY;
		if (!key) throw new HttpError(500, "MISCONFIGURED", "MAGGOT_API_KEY is not set");
		return key;
	}

	// ── Settings and secrets ─────────────────────────────────────────────────

	private settings(): Settings {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'ci'").toArray()[0];
		return row ? JSON.parse(row.value) : {};
	}

	private saveSettings(s: Settings) {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('ci', ?)", JSON.stringify(s));
	}

	/** Whether this deployment attached a container to CiJob (MAGGOT_CI_CLOUDFLARE is "on" only then). */
	cloudflareAvailable(): boolean {
		return this.host.env.MAGGOT_CI_CLOUDFLARE === "on";
	}

	/** The repository's choice, or Cloudflare where it's available and Depot where it isn't. */
	private defaultRunner(): CiRunner {
		const chosen = this.settings().defaultRunner;
		if (chosen === "depot" || (chosen === "cloudflare" && this.cloudflareAvailable())) return chosen;
		return this.cloudflareAvailable() ? "cloudflare" : "depot";
	}

	getSettings(): CiSettings {
		const s = this.settings();
		return {
			defaultRunner: this.defaultRunner(),
			cloudflareAvailable: this.cloudflareAvailable(),
			depot: { configured: Boolean(s.depotToken), orgId: s.depotOrg ?? null },
			secrets: this.sql
				.exec<{ name: string }>("SELECT name FROM ci_secrets ORDER BY name")
				.toArray()
				.map((r) => r.name),
		};
	}

	setDefaultRunner(runner: unknown): CiSettings {
		if (runner !== "cloudflare" && runner !== "depot") throw new HttpError(400, "INVALID_INPUT", "defaultRunner is cloudflare or depot");
		if (runner === "cloudflare" && !this.cloudflareAvailable()) {
			throw new HttpError(400, "CLOUDFLARE_UNAVAILABLE", "This server has no Cloudflare container runner; jobs run on Depot");
		}
		this.saveSettings({ ...this.settings(), defaultRunner: runner });
		return this.getSettings();
	}

	/** Keeps a Depot token (encrypted) once Depot accepts it; `orgId` is needed for organization-less tokens. */
	async setDepot(input: { token: unknown; orgId?: unknown }): Promise<CiSettings> {
		if (typeof input.token !== "string" || !input.token.trim() || input.token.length > 4096) throw new HttpError(400, "INVALID_INPUT", "Paste a Depot organization or user token");
		if (input.orgId !== undefined && input.orgId !== null && typeof input.orgId !== "string") throw new HttpError(400, "INVALID_INPUT", "orgId is a Depot organization id");
		const token = input.token.trim();
		const org = (input.orgId as string | null | undefined)?.trim() || null;
		if (org && !/^[A-Za-z0-9_-]{1,64}$/.test(org)) throw new HttpError(400, "INVALID_INPUT", "That doesn't look like a Depot organization id");
		// Checked before it's kept (listing sandboxes, which costs nothing), so a typo shows up here rather than as failed jobs.
		try {
			await checkDepotCredentials({ token, orgId: org });
		} catch (err) {
			throw new HttpError(400, "DEPOT_REJECTED", `Depot didn't accept that token: ${err instanceof DepotError ? err.message : message(err)}`);
		}
		this.saveSettings({ ...this.settings(), depotToken: await sealSecret(this.apiKey, this.host.repoId(), token), depotOrg: org });
		return this.getSettings();
	}

	removeDepot(): CiSettings {
		const { depotToken: _, depotOrg: __, ...rest } = this.settings();
		this.saveSettings(rest);
		return this.getSettings();
	}

	async setSecret(name: string, value: unknown): Promise<CiSettings> {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name) || /^(GITHUB|MAGGOT|RUNNER)_/i.test(name)) {
			throw new HttpError(400, "INVALID_INPUT", "Secret names are letters, digits and _, not starting with a digit, GITHUB_, MAGGOT_ or RUNNER_");
		}
		if (typeof value !== "string") throw new HttpError(400, "INVALID_INPUT", "value is a string");
		// Shorter values can't be hidden in logs reliably (they'd match ordinary text).
		if (value.length < MIN_SECRET_LENGTH) throw new HttpError(400, "INVALID_INPUT", `A secret is at least ${MIN_SECRET_LENGTH} characters, so it can be hidden in logs`);
		if (new TextEncoder().encode(value).length > MAX_SECRET_BYTES) throw new HttpError(400, "INVALID_INPUT", `A secret is at most ${MAX_SECRET_BYTES / 1024} KB`);
		const exists = this.sql.exec("SELECT 1 FROM ci_secrets WHERE name = ?", name).toArray().length > 0;
		if (!exists && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ci_secrets").one().n >= MAX_SECRETS) {
			throw new HttpError(403, "QUOTA_EXCEEDED", `A repository can have at most ${MAX_SECRETS} secrets`);
		}
		this.sql.exec("INSERT OR REPLACE INTO ci_secrets (name, value, updated_at) VALUES (?, ?, ?)", name, await sealSecret(this.apiKey, this.host.repoId(), value), now());
		return this.getSettings();
	}

	deleteSecret(name: string): CiSettings {
		if (this.sql.exec("DELETE FROM ci_secrets WHERE name = ?", name).rowsWritten === 0) throw new HttpError(404, "NOT_FOUND", `There's no secret called ${name}`);
		return this.getSettings();
	}

	private async secrets(): Promise<Record<string, string>> {
		const out: [string, string][] = [];
		for (const r of this.sql.exec<{ name: string; value: string }>("SELECT name, value FROM ci_secrets").toArray()) {
			out.push([r.name, await openSecret(this.apiKey, this.host.repoId(), r.value)]);
		}
		// Own properties throughout, so secrets called __proto__ or constructor are ordinary names.
		return Object.fromEntries(out);
	}

	private async depotCredentials(): Promise<DepotCredentials | null> {
		const s = this.settings();
		if (!s.depotToken) return null;
		return { token: await openSecret(this.apiKey, this.host.repoId(), s.depotToken), orgId: s.depotOrg ?? null };
	}

	// ── Workflows ────────────────────────────────────────────────────────────

	/** The workflow files at a commit of `repoName`: each parsed, or with the reason it can't run. */
	workflowsAt(repoName: string, sha: string): Promise<{ path: string; spec: WorkflowSpec | null; error: string | null }[]> {
		const key = `${repoName}@${sha}`;
		let hit = this.workflowCache.get(key);
		if (!hit) {
			hit = this.readWorkflows(repoName, sha);
			// A failed read (storage briefly unavailable) is tried again next time.
			hit.catch(() => this.workflowCache.delete(key));
			this.workflowCache.set(key, hit);
			if (this.workflowCache.size > WORKFLOW_CACHE) this.workflowCache.delete(this.workflowCache.keys().next().value!);
		}
		return hit;
	}

	private async readWorkflows(repoName: string, sha: string): Promise<{ path: string; spec: WorkflowSpec | null; error: string | null }[]> {
		using repo = await this.host.store.get(repoName);
		const [commit] = await repo.log({ ref: sha, limit: 1 });
		// Thrown, not an empty list, so the cache drops it and a store that lags the event is asked again.
		if (!commit) throw new Error(`commit ${sha} isn't in ${repoName}`);
		let hash = commit.treeHash;
		for (const part of WORKFLOW_DIR.split("/")) {
			const next = (await repo.readTree(hash))?.find((e) => e.name === part && e.type === "tree");
			if (!next) return [];
			hash = next.hash;
		}
		const files = ((await repo.readTree(hash)) ?? []).filter((e) => e.type !== "tree" && /\.ya?ml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
		const out: { path: string; spec: WorkflowSpec | null; error: string | null }[] = [];
		for (const file of files.slice(0, MAX_WORKFLOWS)) {
			const path = `${WORKFLOW_DIR}/${file.name}`;
			const blob = await repo.readBlob(file.hash);
			if (!blob) continue;
			if (blob.size > MAX_WORKFLOW_BYTES) {
				out.push({ path, spec: null, error: `${path} is bigger than ${MAX_WORKFLOW_BYTES / 1024} KB` });
				continue;
			}
			try {
				out.push({ path, spec: parseWorkflow(await blob.text(), path), error: null });
			} catch (err) {
				if (!(err instanceof WorkflowError)) throw err;
				out.push({ path, spec: null, error: err.message });
			}
		}
		return out;
	}

	async listWorkflows(sha: string): Promise<CiWorkflow[]> {
		return (await this.workflowsAt(this.host.repoId(), sha)).map((w) => ({
			path: w.path,
			name: w.spec?.name ?? w.path.split("/").pop()!,
			error: w.error,
			dispatch: Boolean(w.spec?.on.dispatch),
			schedule: w.spec?.on.schedule ?? [],
		}));
	}

	// ── Starting runs ────────────────────────────────────────────────────────

	/**
	 * Whether a run for this workflow, event and commit was already made (a trigger delivered twice).
	 * `ignoreCancelled`: cancelled runs don't count (reopening a pull request whose runs closing cancelled).
	 */
	private exists(path: string, trigger: Trigger, ignoreCancelled = false): boolean {
		return (
			this.sql
				.exec(
					`SELECT 1 FROM ci_runs WHERE path = ? AND event = ? AND sha = ? AND branch = ? AND pull IS ? ${ignoreCancelled ? "AND conclusion IS NOT 'cancelled'" : ""} LIMIT 1`,
					path,
					trigger.event,
					trigger.sha,
					trigger.branch,
					trigger.pull,
				)
				.toArray().length > 0
		);
	}

	/** The commit a branch of `repoName` points at, or null if there's no such branch. */
	private async tipOf(repoName: string, branch: string): Promise<string | null> {
		using repo = await this.host.store.get(repoName);
		return (await repo.log({ ref: branch, limit: 1 }))[0]?.hash ?? null;
	}

	/** Starts the push workflows (as of the pushed commit) that want this branch. */
	async onPush(branch: string, sha: string, actor: string | null): Promise<CiRunSummary[]> {
		if (this.host.archived()) return [];
		const trigger: Trigger = { event: "push", branch, sha, pull: null, headRepo: null, cloneUrl: this.host.repository().cloneUrl, fromFork: false, actor, baseBranch: null };
		const created: number[] = [];
		for (const w of await this.workflowsAt(this.host.repoId(), sha)) {
			if (this.exists(w.path, trigger)) continue;
			if (w.spec?.on.push && filterAllows(w.spec.on.push, branch)) created.push(this.createRun(w.path, w.spec, trigger, true, null));
			// A broken file still says so where people look.
			else if (w.error) created.push(this.createBrokenRun(w.path, w.error, trigger));
		}
		await this.started(created);
		if (branch === this.host.repository().defaultBranch) await this.refreshSchedules(sha);
		return created.map((n) => this.summary(this.runRow(n)));
	}

	// ── Schedules ────────────────────────────────────────────────────────────

	/** Records the default branch's scheduled workflows (as of `sha`), keeping the next run of schedules that didn't change. */
	async refreshSchedules(sha: string): Promise<void> {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('ciSchedulesFrom', ?)", this.host.repository().defaultBranch);
		const wanted = new Map<string, string>();
		for (const w of await this.workflowsAt(this.host.repoId(), sha)) for (const cron of w.spec?.on.schedule ?? []) wanted.set(`${w.path}\0${cron}`, cron);
		const have = this.sql.exec<{ path: string; cron: string }>("SELECT path, cron FROM ci_schedules").toArray();
		for (const row of have) if (!wanted.has(`${row.path}\0${row.cron}`)) this.sql.exec("DELETE FROM ci_schedules WHERE path = ? AND cron = ?", row.path, row.cron);
		const now = Date.now();
		for (const [key, cron] of wanted) {
			const path = key.split("\0")[0];
			if (have.some((r) => r.path === path && r.cron === cron)) continue;
			const at = nextRun(parseCron(cron), now);
			if (at !== null) this.sql.exec("INSERT OR REPLACE INTO ci_schedules (path, cron, next_at) VALUES (?, ?, ?)", path, cron, at);
		}
		const next = this.nextSchedule();
		if (next !== null) await this.host.wake(next);
	}

	/** When the next scheduled run is due, if any workflow runs on a schedule. */
	nextSchedule(): number | null {
		return this.sql.exec<{ at: number | null }>("SELECT MIN(next_at) AS at FROM ci_schedules").one().at;
	}

	/** Starts the scheduled runs that are due, on the default branch's head, as GitHub does. */
	private async runSchedules(): Promise<void> {
		const now = Date.now();
		const due = this.sql.exec<{ path: string; cron: string; next_at: number }>("SELECT * FROM ci_schedules WHERE next_at <= ?", now).toArray();
		if (due.length === 0 || this.host.archived()) return;
		const branch = this.host.repository().defaultBranch;
		const sha = await this.tipOf(this.host.repoId(), branch);
		const started = new Set<string>();
		const created: number[] = [];
		for (const row of due) {
			const at = nextRun(parseCron(row.cron), now);
			if (at === null) this.sql.exec("DELETE FROM ci_schedules WHERE path = ? AND cron = ?", row.path, row.cron);
			else this.sql.exec("UPDATE ci_schedules SET next_at = ? WHERE path = ? AND cron = ?", at, row.path, row.cron);
			// One run per workflow however many of its schedules are due, and none for one long overdue (it runs at its next time).
			if (!sha || started.has(row.path) || now - row.next_at > SCHEDULE_SLACK_MS) continue;
			// Nothing to run on: no Depot token and no Cloudflare containers. Scheduled runs would only fail, again and again.
			if (!this.cloudflareAvailable() && !this.settings().depotToken) continue;
			const w = (await this.workflowsAt(this.host.repoId(), sha)).find((x) => x.path === row.path);
			if (!w?.spec?.on.schedule.includes(row.cron)) continue;
			started.add(row.path);
			const trigger: Trigger = { event: "schedule", branch, sha, pull: null, headRepo: null, cloneUrl: this.host.repository().cloneUrl, fromFork: false, actor: null, baseBranch: null };
			created.push(this.createRun(w.path, w.spec, trigger, true, null));
		}
		await this.started(created);
	}

	/**
	 * The pull_request workflows that must pass for a pull request's head: the base branch's (so a head
	 * that deletes or renames them can't skip them), whose branches allow the base and whose `types`
	 * allow one of the events this head had. Broken files on the base aren't required, so a pull request
	 * can fix them.
	 */
	private async requiredFor(pull: number, base: string, sha: string): Promise<{ path: string; spec: WorkflowSpec }[]> {
		const tip = await this.tipOf(this.host.repoId(), base);
		if (!tip) return [];
		const actions = this.actionsFor(pull, sha);
		const out: { path: string; spec: WorkflowSpec }[] = [];
		for (const w of await this.workflowsAt(this.host.repoId(), tip)) {
			const on = w.spec?.on.pullRequest;
			if (w.spec && on && filterAllows(on, base) && actions.some((a) => typeAllows(on, a))) out.push({ path: w.path, spec: w.spec });
		}
		return out;
	}

	/**
	 * Starts a pull request's runs for its head: the head's own pull_request workflows (as GitHub does),
	 * plus any required by the base branch that the head doesn't have, from the base's file. Cancels the
	 * pull request's runs on older commits. Runs wait for approval unless whoever caused them can write
	 * to the repository; a fork's never see this repository's secrets.
	 */
	async onPull(input: PullTrigger): Promise<CiRunSummary[]> {
		const trigger: Trigger = {
			event: "pull_request",
			branch: input.branch,
			sha: input.sha,
			pull: input.number,
			headRepo: input.headRepo,
			cloneUrl: input.cloneUrl,
			fromFork: input.fromFork,
			actor: input.actor,
			baseBranch: input.baseBranch,
		};
		for (const r of this.sql.exec<{ number: number }>("SELECT number FROM ci_runs WHERE pull = ? AND status != 'completed' AND sha != ?", input.number, input.sha).toArray()) {
			await this.cancel(r.number, "A newer commit was pushed to the pull request");
		}
		const approved = input.approved === true;
		const author = input.author ?? null;
		// Runs a reopen makes again in place of ones closing cancelled; anyone else's still wait for approval.
		const again = input.action === "reopened";
		const only = input.only ? new Set(input.only) : null;
		// Past the waiting cap only when someone who can merge asked for exactly these.
		const mayWait = () => only !== null || this.roomToWait(author);
		const created: number[] = [];
		const head = await this.workflowsAt(input.headRepo ?? this.host.repoId(), input.sha);
		const required = await this.requiredFor(input.number, input.baseBranch, input.sha);
		// Closed (or archived) while the files were read.
		if (this.host.archived() || this.sql.exec<{ open: number }>("SELECT open FROM ci_pulls WHERE pull = ?", input.number).toArray()[0]?.open === 0) return [];
		// Paths whose head version runs (or broken file fails) for this event; required ones not among them run from the base.
		const covered = new Set<string>();
		for (const w of head) {
			if (only && !only.has(w.path)) continue;
			const on = w.spec?.on.pullRequest;
			const applies = w.spec && on && filterAllows(on, input.baseBranch) && typeAllows(on, input.action);
			if (!applies && !w.error) continue;
			if (this.exists(w.path, trigger, again)) {
				covered.add(w.path);
				continue;
			}
			if (w.spec) {
				if (approved || mayWait()) {
					created.push(this.createRun(w.path, w.spec, trigger, approved, author));
					covered.add(w.path);
				}
			} else {
				created.push(this.createBrokenRun(w.path, w.error!, trigger, approved, author));
				covered.add(w.path);
			}
		}
		for (const w of required) {
			if ((only && !only.has(w.path)) || covered.has(w.path) || this.exists(w.path, trigger, again)) continue;
			if (approved || mayWait()) created.push(this.createRun(w.path, w.spec, trigger, approved, author));
		}
		await this.started(created);
		return created.map((n) => this.summary(this.runRow(n)));
	}

	/** Whether another run may wait for approval: there's a cap per repository and per pull request author. */
	private roomToWait(author: string | null): boolean {
		if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ci_runs WHERE status = 'waiting'").one().n >= MAX_WAITING) return false;
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ci_runs WHERE status = 'waiting' AND author IS ?", author).one().n < MAX_WAITING_PER_AUTHOR;
	}

	/**
	 * Records a pull request event (opened, reopened, or a new head) to act on. It's kept until acted on,
	 * so `tick` retries one that failed; events are acted on oldest first, and only while their commit is
	 * still the pull request's head, so one that arrives late can't cancel the runs of a newer head.
	 */
	async queuePull(input: PullTrigger): Promise<void> {
		if (this.host.archived()) return;
		this.sql.exec("INSERT INTO ci_pull_queue (pull, input) VALUES (?, ?)", input.number, JSON.stringify(input));
		await this.drainPulls();
	}

	/** Acts on queued pull request events, one drain at a time (see `draining`). */
	drainPulls(): Promise<void> {
		const next = this.draining.then(() => this.drainOnce());
		this.draining = next.catch(() => {});
		return next;
	}

	private async drainOnce(): Promise<void> {
		if (this.host.archived()) {
			this.sql.exec("DELETE FROM ci_pull_queue");
			return;
		}
		for (const row of this.sql.exec<{ id: number; input: string; attempts: number }>("SELECT id, input, attempts FROM ci_pull_queue ORDER BY id").toArray()) {
			const input = JSON.parse(row.input) as PullTrigger;
			try {
				// Superseded (the branch moved on, or is gone): a later event covers the head, if there is one.
				const tip = await this.tipOf(input.headRepo ?? this.host.repoId(), input.branch);
				const state = this.sql.exec<{ open: number }>("SELECT open FROM ci_pulls WHERE pull = ?", input.number).toArray()[0];
				const closed = state?.open === 0 && input.action !== "reopened";
				if (tip === input.sha && !closed) {
					const prior = this.sql.exec<{ sha: string; approved: number }>("SELECT sha, approved FROM ci_pulls WHERE pull = ?", input.number).toArray()[0];
					if (input.only) {
						// Starting what's missing doesn't vouch for the code: the head's runs wait if they would have.
						input.approved = prior?.sha === input.sha && prior.approved === 1;
						input.action = this.actionsFor(input.number, input.sha).at(-1) ?? "synchronize";
					}
					const trusted = input.approved === true || (prior?.sha === input.sha && prior.approved === 1);
					this.sql.exec("INSERT OR REPLACE INTO ci_pulls (pull, sha, open, approved) VALUES (?, ?, 1, ?)", input.number, input.sha, trusted ? 1 : 0);
					if (!input.only) this.sql.exec("INSERT OR IGNORE INTO ci_pull_events (pull, sha, action) VALUES (?, ?, ?)", input.number, input.sha, input.action);
					this.sql.exec("DELETE FROM ci_pull_events WHERE pull = ? AND sha != ?", input.number, input.sha);
					await this.onPull(input);
				}
				this.sql.exec("DELETE FROM ci_pull_queue WHERE id = ?", row.id);
			} catch (err) {
				console.error("ci: starting a pull request's runs failed", err);
				// After the last try, the pull request's checks show the runs as missing, with a way to start them.
				if (row.attempts + 1 >= MAX_PULL_ATTEMPTS) this.sql.exec("DELETE FROM ci_pull_queue WHERE id = ?", row.id);
				else this.sql.exec("UPDATE ci_pull_queue SET attempts = attempts + 1 WHERE id = ?", row.id);
			}
		}
		await this.wakeIfBusy();
	}

	/**
	 * The events `sha` had as the pull request's head. If none were recorded (an event was lost), it's
	 * taken as "opened" for a pull request never seen, else as new commits ("synchronize").
	 */
	private actionsFor(pull: number, sha: string): PullRequestType[] {
		const events = this.sql.exec<{ action: PullRequestType }>("SELECT action FROM ci_pull_events WHERE pull = ? AND sha = ?", pull, sha).toArray();
		if (events.length) return events.map((e) => e.action);
		return this.sql.exec("SELECT 1 FROM ci_pulls WHERE pull = ?", pull).toArray().length ? ["synchronize"] : ["opened"];
	}

	/** A pull request was closed or merged: its runs waiting for approval are cancelled, and if closed, the running ones too. */
	async closePull(pull: number, merged: boolean): Promise<void> {
		// Recorded even for a pull request CI hasn't seen yet, so its opening event, if late, starts nothing.
		this.sql.exec("INSERT INTO ci_pulls (pull, sha, open) VALUES (?, '', 0) ON CONFLICT (pull) DO UPDATE SET open = 0", pull);
		this.sql.exec("DELETE FROM ci_pull_queue WHERE pull = ?", pull);
		const statuses = merged ? "('waiting')" : "('waiting', 'queued', 'in_progress')";
		for (const { number } of this.sql.exec<{ number: number }>(`SELECT number FROM ci_runs WHERE pull = ? AND status IN ${statuses}`, pull).toArray()) {
			await this.cancel(number, merged ? "The pull request was merged" : "The pull request was closed");
		}
	}

	/**
	 * A pull request's checks on its head commit, the same answer a merge gets. Counted: the newest run of
	 * each workflow and event on the commit (pushes' and manual runs too, so a failing push run blocks).
	 * Required as well: a passing pull_request run of each workflow the base branch requires (see
	 * `requiredFor`); one that hasn't run is `missing`.
	 */
	async pullChecks(input: { number: number; base: string; headRepo: string | null; sha: string }): Promise<Omit<PullChecks, "required" | "canStart">> {
		const short = input.sha.slice(0, 7);
		const rows = this.sql.exec<SummaryRow>(`SELECT ${SUMMARY} FROM ci_runs WHERE sha = ? AND (pull IS NULL OR pull = ?) ORDER BY number DESC`, input.sha, input.number).toArray();
		const latest = new Map<string, SummaryRow>();
		for (const r of rows) if (!latest.has(`${r.path}\0${r.event}`)) latest.set(`${r.path}\0${r.event}`, r);
		const runs = [...latest.values()].map((r) => this.summary(r));
		let required: { path: string }[];
		try {
			required = await this.requiredFor(input.number, input.base, input.sha);
		} catch (err) {
			return { head: input.sha, state: "failure", runs, missing: [], reason: `The workflows required on ${input.base} can't be read: ${message(err)}` };
		}
		const missing = required.filter((w) => !runs.some((r) => r.path === w.path && r.event === "pull_request")).map((w) => w.path);
		const names = (list: CiRunSummary[]) => [...new Set(list.map((r) => r.workflow))].join(", ");
		const failed = runs.filter((r) => r.status === "completed" && r.conclusion !== "success");
		if (failed.length) return { head: input.sha, state: "failure", runs, missing, reason: `Actions failed on ${short} (${names(failed)}). Push a fix or re-run them.` };
		const waiting = runs.filter((r) => r.status === "waiting");
		if (waiting.length) return { head: input.sha, state: "waiting", runs, missing, reason: `Actions on ${short} are waiting for approval (${names(waiting)}).` };
		const running = runs.filter((r) => r.status !== "completed");
		if (running.length) return { head: input.sha, state: "pending", runs, missing, reason: `Actions on ${short} are still running (${names(running)}).` };
		if (missing.length) return { head: input.sha, state: "missing", runs, missing, reason: `${missing.join(", ")} ${missing.length === 1 ? "hasn't" : "haven't"} run on ${short}; start the missing checks.` };
		return { head: input.sha, state: runs.length ? "success" : "none", runs, missing, reason: null };
	}

	/** Starts a pull request's missing runs on its head, for someone who can merge (so they don't wait for approval). */
	/**
	 * Start missing checks: creates runs for exactly `missing` (the paths the checks list), at the head
	 * the checks were for. They wait for approval if the head's runs would have (a fork's, or a pull
	 * request a reader opened), so starting them never runs unreviewed code; approving them is separate.
	 */
	async startPull(input: Omit<PullTrigger, "action" | "approved" | "only">, missing: string[]): Promise<void> {
		if (missing.length === 0) return;
		await this.queuePull({ ...input, action: "synchronize", approved: false, only: missing });
	}

	async dispatch(path: string, branch: string, sha: string, actor: string | null): Promise<CiRunSummary[]> {
		if (this.host.archived()) throw new HttpError(403, "ARCHIVED", "This repository is archived, so nothing runs in it");
		const w = (await this.workflowsAt(this.host.repoId(), sha)).find((x) => x.path === path);
		if (!w) throw new HttpError(404, "NOT_FOUND", `${path} isn't a workflow on ${branch}`);
		if (!w.spec) throw new HttpError(400, "INVALID_WORKFLOW", w.error ?? "The workflow can't run");
		if (!w.spec.on.dispatch) throw new HttpError(400, "INVALID_INPUT", `${path} can't be run by hand: add workflow_dispatch to its "on"`);
		const trigger: Trigger = { event: "workflow_dispatch", branch, sha, pull: null, headRepo: null, cloneUrl: this.host.repository().cloneUrl, fromFork: false, actor, baseBranch: null };
		const number = this.createRun(path, w.spec, trigger, true, null);
		await this.started([number]);
		return [this.summary(this.runRow(number))];
	}

	/**
	 * Runs a finished run again with the definition it ran with, which for a pull request can be the base
	 * branch's rather than the head's. Only a run whose file didn't parse reads the file again. Whoever asks
	 * can merge, so it doesn't wait for approval again.
	 */
	async rerun(number: number, actor: string | null): Promise<CiRun> {
		if (this.host.archived()) throw new HttpError(403, "ARCHIVED", "This repository is archived, so nothing runs in it");
		const old = this.runRow(number);
		if (old.status !== "completed") throw new HttpError(409, "IN_PROGRESS", "That run is still going; cancel it first");
		const trigger: Trigger = { ...(JSON.parse(old.trigger) as Trigger), actor };
		let spec = JSON.parse(old.spec) as WorkflowSpec | null;
		if (!spec) {
			let fresh;
			try {
				fresh = (await this.workflowsAt(trigger.headRepo ?? this.host.repoId(), trigger.sha)).find((x) => x.path === old.path);
			} catch (err) {
				throw new HttpError(409, "HEAD_GONE", `The commit can't be read any more: ${message(err)}`);
			}
			spec = fresh?.spec ?? null;
			if (!spec) throw new HttpError(400, "INVALID_WORKFLOW", fresh?.error ?? `${old.path} is no longer at that commit`);
		}
		const created = this.createRun(old.path, spec, trigger, true, old.author);
		await this.started([created]);
		return this.getRun(created);
	}

	private createRun(path: string, spec: WorkflowSpec, trigger: Trigger, approved: boolean, author: string | null): number {
		const status: CiStatus = approved ? "queued" : "waiting";
		const number = this.sql
			.exec<{ number: number }>(
				"INSERT INTO ci_runs (workflow, path, event, branch, sha, pull, from_fork, actor, status, created_at, spec, trigger, author, approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING number",
				spec.name,
				path,
				trigger.event,
				trigger.branch,
				trigger.sha,
				trigger.pull,
				trigger.fromFork ? 1 : 0,
				trigger.actor,
				status,
				now(),
				JSON.stringify(spec),
				JSON.stringify(trigger),
				author,
				approved ? 1 : 0,
			)
			.one().number;
		for (const job of spec.jobs) {
			const runner = job.runsOn.kind === "default" ? this.defaultRunner() : job.runsOn.kind;
			this.sql.exec(
				"INSERT INTO ci_jobs (id, run, key, grp, name, runner, vcpus, needs, status, steps, timeout_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				crypto.randomUUID(),
				number,
				job.key,
				job.group,
				job.name,
				runner,
				runner === "depot" ? (job.runsOn.vcpus ?? 2) : null,
				JSON.stringify(job.needs),
				status,
				JSON.stringify(jobSteps(job.steps.map((s) => s.name))),
				job.timeoutMinutes,
			);
		}
		this.prune();
		return number;
	}

	/** A workflow file that doesn't parse: a failed run, so the mistake is visible. */
	private createBrokenRun(path: string, error: string, trigger: Trigger, approved = true, author: string | null = null): number {
		const t = now();
		const number = this.sql
			.exec<{ number: number }>(
				"INSERT INTO ci_runs (workflow, path, event, branch, sha, pull, from_fork, actor, status, conclusion, error, created_at, finished_at, spec, trigger, approved, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'failure', ?, ?, ?, 'null', ?, ?, ?) RETURNING number",
				path.split("/").pop()!,
				path,
				trigger.event,
				trigger.branch,
				trigger.sha,
				trigger.pull,
				trigger.fromFork ? 1 : 0,
				trigger.actor,
				error,
				t,
				t,
				JSON.stringify(trigger),
				approved ? 1 : 0,
				author,
			)
			.one().number;
		this.prune();
		return number;
	}

	/**
	 * Keeps the newest MAX_RUNS finished runs that someone who can write started or approved; unfinished
	 * runs don't count (waiting ones have their own cap), and those on an open pull request's head are kept
	 * whatever their age: they're its checks. Finished runs nobody approved are capped on their own, per
	 * repository and per author, oldest first, so readers' and forks' events can't push writers' runs out.
	 */
	private prune() {
		this.pruneLogs();
		const old = this.sql
			.exec<{ number: number }>(
				`SELECT number FROM ci_runs r WHERE status = 'completed' AND approved = 1
					AND number NOT IN (SELECT number FROM ci_runs WHERE status = 'completed' AND approved = 1 ORDER BY number DESC LIMIT ?)
					AND NOT EXISTS (SELECT 1 FROM ci_pulls p WHERE p.open = 1 AND p.sha = r.sha)
				UNION
				SELECT number FROM ci_runs WHERE status = 'completed' AND approved = 0
					AND number NOT IN (SELECT number FROM ci_runs WHERE status = 'completed' AND approved = 0 ORDER BY number DESC LIMIT ?)
				UNION
				SELECT number FROM ci_runs r WHERE status = 'completed' AND approved = 0
					AND number NOT IN (SELECT number FROM ci_runs x WHERE x.status = 'completed' AND x.approved = 0 AND x.author IS r.author ORDER BY number DESC LIMIT ?)`,
				MAX_RUNS,
				MAX_UNAPPROVED_RUNS,
				MAX_UNAPPROVED_RUNS_PER_AUTHOR,
			)
			.toArray();
		for (const { number } of old) {
			this.storage.expireRun(number);
			this.sql.exec("DELETE FROM ci_logs WHERE job IN (SELECT id FROM ci_jobs WHERE run = ?)", number);
			this.sql.exec("DELETE FROM ci_jobs WHERE run = ?", number);
			this.sql.exec("DELETE FROM ci_runs WHERE number = ?", number);
		}
	}

	/** Drops the logs of the oldest finished runs while the repository keeps more than its share. */
	private pruneLogs() {
		let total = this.sql.exec<{ n: number | null }>("SELECT SUM(log_bytes) AS n FROM ci_jobs").one().n ?? 0;
		if (total <= MAX_TOTAL_LOG_BYTES) return;
		const runs = this.sql
			.exec<{ run: number; bytes: number }>("SELECT run, SUM(log_bytes) AS bytes FROM ci_jobs WHERE log_bytes > 0 AND run IN (SELECT number FROM ci_runs WHERE status = 'completed') GROUP BY run ORDER BY run")
			.toArray();
		for (const r of runs) {
			if (total <= MAX_TOTAL_LOG_BYTES) break;
			this.sql.exec("DELETE FROM ci_logs WHERE job IN (SELECT id FROM ci_jobs WHERE run = ?)", r.run);
			for (const { id } of this.sql.exec<{ id: string }>("SELECT id FROM ci_jobs WHERE run = ?", r.run).toArray()) {
				this.sql.exec("INSERT INTO ci_logs (job, step, text) VALUES (?, 0, ?)", id, "This log was removed to make room for newer runs' logs.\n");
			}
			this.sql.exec("UPDATE ci_jobs SET log_bytes = 0 WHERE run = ?", r.run);
			total -= r.bytes;
		}
	}

	/** After runs are made: start what can start, and announce runs that were over at once (broken files). */
	private async started(numbers: number[]) {
		if (numbers.length) this.host.changed();
		for (const n of numbers) {
			const run = this.runRow(n);
			if (run.status === "completed") this.announce(run);
		}
		await this.schedule();
	}

	// ── Scheduling ───────────────────────────────────────────────────────────

	private running(): number {
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ci_jobs WHERE status = 'in_progress'").one().n;
	}

	/**
	 * Starts queued jobs whose needs are done and whose `if:` allows them, up to the limit (and a
	 * matrix's max-parallel); skips the rest. A failed matrix job cancels its siblings (fail-fast).
	 */
	async schedule(): Promise<void> {
		// Archiving cancels everything; this is the backstop, so nothing is handed a runner afterwards.
		if (this.host.archived()) return;
		const specs = new Map<number, { workflow: WorkflowSpec; trigger: Trigger; run: RunRow }>();
		const runOf = (number: number) => {
			let hit = specs.get(number);
			if (!hit) {
				const run = this.runRow(number);
				hit = { workflow: JSON.parse(run.spec) as WorkflowSpec, trigger: JSON.parse(run.trigger) as Trigger, run };
				specs.set(number, hit);
			}
			return hit;
		};
		for (let pass = 0; pass < 50; pass++) {
			let changed = await this.failFast(runOf);
			const queued = this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE status = 'queued' ORDER BY run, rowid").toArray();
			for (const job of queued) {
				const needs = JSON.parse(job.needs) as string[];
				const deps = needs.length
					? this.sql.exec<{ key: string; status: CiStatus; conclusion: CiConclusion | null }>(`SELECT key, status, conclusion FROM ci_jobs WHERE run = ? AND key IN (${needs.map(() => "?").join(", ")})`, job.run, ...needs).toArray()
					: [];
				if (deps.some((d) => d.status !== "completed")) continue;
				const { workflow, trigger, run } = runOf(job.run);
				const spec = workflow.jobs.find((j) => j.key === job.key);
				const verdict = spec ? this.jobCondition(spec, workflow, run, trigger) : { run: true, reason: null };
				if (!verdict.run) {
					this.finishJob(job, "skipped", verdict.reason);
					changed = true;
					continue;
				}
				if (this.running() >= MAX_RUNNING_JOBS) continue;
				const maxParallel = spec?.strategy.maxParallel;
				if (maxParallel && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ci_jobs WHERE run = ? AND grp = ? AND status = 'in_progress'", job.run, spec.group).one().n >= maxParallel) continue;
				// Another schedule() may have taken it while this one was waiting on a launch.
				const t = now();
				if (this.sql.exec("UPDATE ci_jobs SET status = 'in_progress', started_at = ?, reported_at = ? WHERE id = ? AND status = 'queued'", t, Date.now(), job.id).rowsWritten === 0) continue;
				this.sql.exec("UPDATE ci_runs SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE number = ?", t, job.run);
				changed = true;
				await this.dispatchJob(job.id);
			}
			this.settleRuns();
			if (!changed) break;
			if (pass === 0) this.host.changed();
		}
		await this.wakeIfBusy();
	}

	/**
	 * Whether a job whose needs are done runs: its `if:` (success() unless it says otherwise), where
	 * success() means every job before it succeeded (the jobs it needs, the jobs those need, and so on,
	 * as on GitHub) and failure() that one of them failed.
	 */
	private jobCondition(spec: JobSpec, workflow: WorkflowSpec, run: RunRow, trigger: Trigger): { run: boolean; reason: string | null } {
		const before = new Set<string>();
		const visit = (keys: string[]) => {
			for (const key of keys) {
				if (before.has(key)) continue;
				before.add(key);
				visit(workflow.jobs.find((j) => j.key === key)?.needs ?? []);
			}
		};
		visit(spec.needs);
		const deps = before.size
			? this.sql.exec<{ key: string; conclusion: CiConclusion | null }>(`SELECT key, conclusion FROM ci_jobs WHERE run = ? AND key IN (${[...before].map(() => "?").join(", ")})`, run.number, ...before).toArray()
			: [];
		const failed = deps.filter((d) => d.conclusion !== "success");
		try {
			const ok = truthy(
				evaluate(parseCondition(spec.if), {
					contexts: { github: this.githubContext(run, trigger, spec.group), needs: this.needsContext(run.number, spec.needsGroups), inputs: {} },
					status: { success: failed.length === 0, failure: deps.some((d) => d.conclusion === "failure"), cancelled: deps.some((d) => d.conclusion === "cancelled") },
				}),
			);
			if (ok) return { run: true, reason: null };
		} catch (err) {
			if (!(err instanceof ExpressionError)) throw err;
			return { run: false, reason: `Skipped: its if: couldn't be worked out (${err.message})` };
		}
		if (spec.if === "success()" && failed.length) return { run: false, reason: `Skipped: ${[...new Set(failed.map((d) => d.key.split(".")[0]))].join(", ")} didn't succeed` };
		return { run: false, reason: "Skipped: its if: was false" };
	}

	/** fail-fast: a matrix job that failed cancels its run's other jobs of the same matrix. True if it cancelled any. */
	private async failFast(runOf: (n: number) => { workflow: WorkflowSpec }): Promise<boolean> {
		const failed = this.sql
			.exec<{ run: number; grp: string }>(
				`SELECT DISTINCT j.run, j.grp FROM ci_jobs j JOIN ci_runs r ON r.number = j.run
					WHERE r.status != 'completed' AND j.conclusion = 'failure' AND j.grp IS NOT NULL AND j.key != j.grp
					AND EXISTS (SELECT 1 FROM ci_jobs s WHERE s.run = j.run AND s.grp = j.grp AND s.status != 'completed')`,
			)
			.toArray();
		let cancelled = false;
		for (const { run, grp } of failed) {
			const spec = runOf(run).workflow.jobs.find((j) => j.group === grp);
			if (!spec?.strategy.failFast) continue;
			for (const job of this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE run = ? AND grp = ? AND status != 'completed'", run, grp).toArray()) {
				if (job.status === "in_progress") this.sql.exec("UPDATE ci_jobs SET cancel_pending = 1 WHERE id = ?", job.id);
				this.finishJob(job, "cancelled", "Cancelled: another job of its matrix failed (fail-fast)");
				cancelled = true;
			}
		}
		if (cancelled) await this.retryCancels();
		return cancelled;
	}

	/** The github context: what's fixed for a job of a run. */
	private githubContext(run: RunRow, trigger: Trigger, job: string): Record<string, string> {
		const repo = this.host.repository();
		// A pull request's head is what's checked out (maggot makes no merge commits to test), so its ref names that.
		const ref = trigger.event === "pull_request" ? `refs/pull/${trigger.pull}/head` : `refs/heads/${trigger.branch}`;
		return {
			sha: run.sha,
			ref,
			ref_name: trigger.branch,
			ref_type: "branch",
			head_ref: trigger.event === "pull_request" ? trigger.branch : "",
			base_ref: trigger.baseBranch ?? "",
			repository: repo.fullName,
			repository_owner: repo.fullName.split("/")[0] ?? "",
			server_url: repo.url ? new URL(repo.url).origin : "",
			api_url: repo.url ? `${new URL(repo.url).origin}/api` : "",
			event_name: run.event,
			run_id: String(run.number),
			run_number: String(run.number),
			run_attempt: "1",
			actor: trigger.actor ?? "",
			triggering_actor: trigger.actor ?? "",
			workflow: run.workflow,
			job,
			workspace: "/workspace",
		};
	}

	/** The needs context: each job a job needs, with its result and outputs (a matrix's jobs together). */
	private needsContext(run: number, groups: string[]): Value {
		const out: Record<string, Value> = {};
		for (const grp of groups) {
			const rows = this.sql.exec<{ conclusion: CiConclusion | null; outputs: string | null }>("SELECT conclusion, outputs FROM ci_jobs WHERE run = ? AND grp = ? ORDER BY rowid", run, grp).toArray();
			const result = rows.some((r) => r.conclusion === "failure")
				? "failure"
				: rows.some((r) => r.conclusion === "cancelled")
					? "cancelled"
					: rows.length && rows.every((r) => r.conclusion === "success")
						? "success"
						: "skipped";
			const outputs: Record<string, Value> = {};
			for (const r of rows) Object.assign(outputs, r.outputs ? (JSON.parse(r.outputs) as Record<string, string>) : {});
			out[grp] = { result, outputs };
		}
		return out;
	}

	/**
	 * Hands an in-progress job to its Durable Object. A problem with the job itself (no Depot token, a
	 * bad expression) fails it at once; the object being unreachable is retried by `tick` a few times.
	 */
	private async dispatchJob(jobId: string): Promise<void> {
		const job = this.jobRow(jobId);
		if (!job || job.status !== "in_progress" || job.dispatched) return;
		if (this.host.archived()) {
			this.finishJob(job, "cancelled", "The repository was archived");
			return;
		}
		let launch: JobLaunch;
		try {
			launch = await this.launchFor(job);
		} catch (err) {
			// GitHub briefly unreachable while its actions were read: tried again, like a start that didn't get through.
			if (err instanceof ActionFetchError) {
				const attempts = job.dispatch_attempts + 1;
				this.sql.exec("UPDATE ci_jobs SET dispatch_attempts = ? WHERE id = ?", attempts, job.id);
				console.error("ci: reading a job's actions failed", err);
				if (attempts >= MAX_DISPATCH_ATTEMPTS) this.finishJob(job, "failure", message(err));
				return;
			}
			this.finishJob(job, "failure", message(err));
			return;
		}
		try {
			await this.host.job(job.id).start(launch);
			this.sql.exec("UPDATE ci_jobs SET dispatched = 1, reported_at = ? WHERE id = ?", Date.now(), job.id);
			// Cancelled while it was being started: that cancel reached an object with nothing to stop yet.
			if (this.jobRow(job.id)?.status === "completed") await this.host.job(job.id).cancel();
		} catch (err) {
			const attempts = job.dispatch_attempts + 1;
			this.sql.exec("UPDATE ci_jobs SET dispatch_attempts = ? WHERE id = ?", attempts, job.id);
			console.error("ci: starting a job failed", err);
			if (attempts >= MAX_DISPATCH_ATTEMPTS) this.finishJob(this.jobRow(job.id) ?? job, "failure", `The job couldn't be started: ${message(err)}`);
		}
	}

	private async launchFor(job: JobRow): Promise<JobLaunch> {
		const run = this.runRow(job.run);
		const workflow = JSON.parse(run.spec) as WorkflowSpec;
		const spec: JobSpec | undefined = workflow.jobs.find((j) => j.key === job.key);
		if (!spec) throw new Error(`The workflow has no job ${job.key}`);
		const trigger = JSON.parse(run.trigger) as Trigger;
		const repo = this.host.repository();
		// This repository's address follows renames; a fork's is the one it had when the run started.
		const cloneUrl = trigger.headRepo ? trigger.cloneUrl : repo.cloneUrl;
		if (!cloneUrl) throw new Error("This repository has no clone URL yet, so jobs can't check it out");
		let runner: JobLaunch["runner"];
		if (job.runner === "depot") {
			const credentials = await this.depotCredentials();
			if (!credentials) throw new Error("This job runs on Depot, but the repository has no Depot token: add one in Settings → Actions");
			runner = { kind: "depot", vcpus: job.vcpus ?? 2, credentials };
		} else {
			if (!this.cloudflareAvailable()) throw new Error("Cloudflare containers aren't available on this server; use runs-on: depot (or ubuntu-latest, which runs on Depot here)");
			runner = { kind: "cloudflare" };
		}
		// A fork's pull request runs the fork's code, so it never gets this repository's secrets.
		const all = trigger.fromFork ? {} : await this.secrets();
		const used = usedSecrets(workflow, spec);
		const secret = (name: string) => (Object.hasOwn(all, name) ? all[name] : "");
		// A value too short to hide in the log could end up in it: the job doesn't run with it.
		const short = used.filter((name) => secret(name).length > 0 && secret(name).length < MIN_SECRET_LENGTH);
		if (short.length) {
			throw new Error(`The secret${short.length === 1 ? "" : "s"} ${short.join(", ")} ${short.length === 1 ? "is" : "are"} shorter than ${MIN_SECRET_LENGTH} characters, so ${short.length === 1 ? "it" : "they"} can't be hidden in logs. Replace ${short.length === 1 ? "it" : "them"} in Settings → Actions.`);
		}
		// Only what this job can see: other secrets never reach the sandbox, not even as mask patterns.
		const secrets = Object.fromEntries(used.filter((name) => secret(name).length > 0).map((name) => [name, secret(name)]));
		const github = this.githubContext(run, trigger, spec.group);
		const strategy: Value = { "fail-fast": spec.strategy.failFast, "max-parallel": spec.strategy.maxParallel ?? spec.strategy.total, "job-index": spec.strategy.index, "job-total": spec.strategy.total };
		const contexts = { github, matrix: spec.matrix ?? {}, needs: this.needsContext(run.number, spec.needsGroups), strategy, inputs: {} };
		const base: Record<string, string> = {
			CI: "true",
			MAGGOT_ACTIONS: "true",
			GITHUB_ACTIONS: "true",
			RUNNER_OS: "Linux",
			RUNNER_ARCH: "X64",
			RUNNER_NAME: "maggot",
			...Object.fromEntries(Object.entries(github).map(([k, v]) => [`GITHUB_${k.toUpperCase()}`, v])),
		};
		// Workflow env, then job env, each filled in as GitHub does (job env sees the workflow's).
		const fill = (values: Record<string, string>, env: Record<string, string>, where: string) => {
			const scope = { contexts: { ...contexts, secrets, env } };
			return Object.fromEntries(
				Object.entries(values).map(([k, v]) => {
					try {
						return [k, render(parseTemplate(v), scope)];
					} catch (err) {
						if (err instanceof ExpressionError) throw new Error(`${where}.${k}: ${err.message}`);
						throw err;
					}
				}),
			);
		};
		const workflowEnv = { ...base, ...fill(workflow.env, base, "env") };
		const env = { ...workflowEnv, ...fill(spec.env, workflowEnv, `jobs.${spec.group}.env`) };
		// The actions its steps use, pinned to commits, with their action.yml read.
		const headRepo = trigger.headRepo ?? this.host.repoId();
		const source: ActionSource = {
			resolve: (owner, name, ref) => this.github().resolve(owner, name, ref),
			readGitHub: (owner, name, sha, path) => this.github().readFile(owner, name, sha, path),
			readLocal: async (path) => {
				using handle = await this.host.store.get(headRepo);
				const blob = await handle.readFile({ ref: run.sha, path });
				return blob ? blob.text() : null;
			},
		};
		let plan;
		try {
			plan = buildPlan(spec.steps, await resolveActions(spec.steps, source, repo.fullName));
		} catch (err) {
			if (err instanceof WorkflowError) throw new Error(err.message);
			throw err;
		}
		const expires = Date.now() + spec.timeoutMinutes * 60_000 + JOB_TOKEN_GRACE_MS;
		// Read-only, for the one repository holding the commit, and gone soon after the job's time limit.
		const checkoutToken = await mintCheckoutToken(this.apiKey, { repos: [headRepo], expires: Date.now() + CHECKOUT_TOKEN_MS });
		const grant: JobGrant = { repo: this.host.repoId(), run: run.number, job: job.id, ...cacheScopes(trigger, repo.defaultBranch), expires };
		const origin = repo.url ? new URL(repo.url).origin : "";
		return {
			jobId: job.id,
			repo: this.host.repoId(),
			runner,
			timeoutMinutes: spec.timeoutMinutes,
			plan,
			env,
			contexts,
			secrets,
			outputs: spec.outputs,
			mask: Object.values(secrets).filter((v) => v.length >= MIN_SECRET_LENGTH),
			checkout: { url: cloneUrl, auth: btoa(`x:${checkoutToken}`), ref: `refs/heads/${trigger.branch}`, sha: run.sha, depth: fetchDepthFor(spec.steps) },
			api: { url: origin, token: await mintJobToken(this.apiKey, grant) },
		};
	}

	private github(): Pick<GitHubActions, "resolve" | "readFile"> {
		return this.host.github ?? new GitHubActions(this.host.env.CI_BUCKET);
	}

	private finishJob(job: Pick<JobRow, "id" | "steps">, conclusion: CiConclusion, error: string | null) {
		const t = now();
		// A job that fails before its machine reports failed in setup; the steps it never reached are skipped.
		const steps = (JSON.parse(job.steps) as CiStep[]).map((s, i): CiStep => {
			if (s.status === "completed") return s;
			const failedSetup = i === 0 && s.status === "pending" && conclusion === "failure";
			return { ...s, status: "completed", conclusion: conclusion === "cancelled" ? "cancelled" : failedSetup ? "failure" : "skipped" };
		});
		this.sql.exec(
			"UPDATE ci_jobs SET status = 'completed', conclusion = ?, error = COALESCE(error, ?), steps = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ? AND status != 'completed'",
			conclusion,
			error,
			JSON.stringify(steps),
			t,
			t,
			job.id,
		);
	}

	/** Completes runs whose jobs have all finished, and says so. */
	private settleRuns() {
		// Only runs with jobs, all of them finished: one query, rather than one per unfinished run.
		const done = this.sql
			.exec<{ number: number }>(
				`SELECT number FROM ci_runs r WHERE status IN ('queued', 'in_progress', 'waiting')
					AND EXISTS (SELECT 1 FROM ci_jobs WHERE run = r.number)
					AND NOT EXISTS (SELECT 1 FROM ci_jobs WHERE run = r.number AND status != 'completed')`,
			)
			.toArray();
		for (const run of done) {
			const jobs = this.sql.exec<{ conclusion: CiConclusion | null }>("SELECT conclusion FROM ci_jobs WHERE run = ?", run.number).toArray();
			const conclusion: CiConclusion = jobs.some((j) => j.conclusion === "failure") ? "failure" : jobs.some((j) => j.conclusion === "cancelled") ? "cancelled" : "success";
			const t = now();
			this.sql.exec("UPDATE ci_runs SET status = 'completed', conclusion = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE number = ? AND status != 'completed'", conclusion, t, t, run.number);
			this.announce(this.runRow(run.number));
		}
	}

	/** The feed and workflow_run webhooks hear that a run finished (and whose code it ran, for the host to keep private forks private). */
	private announce(run: RunRow) {
		this.host.emit(
			{ run: { number: run.number, workflow: run.workflow, path: run.path, event: run.event, branch: run.branch, sha: run.sha, pull: run.pull, conclusion: run.conclusion, fromFork: Boolean(run.from_fork) } },
			this.runHeads([run.number])[run.number] ?? null,
		);
	}

	private async wakeIfBusy() {
		if (this.busy()) await this.host.wake(Date.now() + TICK_MS);
	}

	/** Whether the alarm should look in again. */
	/** When the oldest run waiting for approval expires, if any is waiting. */
	waitingExpiry(): number | null {
		const oldest = this.sql.exec<{ at: string | null }>("SELECT MIN(created_at) AS at FROM ci_runs WHERE status = 'waiting'").one().at;
		return oldest ? Date.parse(oldest) + WAITING_TTL_MS : null;
	}

	busy(): boolean {
		return (
			this.sql.exec("SELECT 1 FROM ci_jobs WHERE status IN ('queued', 'in_progress') OR cancel_pending = 1 LIMIT 1").toArray().length > 0 ||
			this.sql.exec("SELECT 1 FROM ci_pull_queue LIMIT 1").toArray().length > 0
		);
	}

	/**
	 * From the coordinator's alarm: retries handing jobs to their objects and cancelling them, fails jobs
	 * that went silent (their object is gone or can't reach this one), and starts what can start.
	 */
	async tick(): Promise<void> {
		await this.drainPulls();
		// Schedules are read from the default branch when it moves; also when it's a different branch than
		// they were read from (renamed, or never read: a repository from before schedules).
		const branch = this.host.repository().defaultBranch;
		if (this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'ciSchedulesFrom'").toArray()[0]?.value !== branch) {
			const tip = await this.tipOf(this.host.repoId(), branch).catch(() => null);
			if (tip) await this.refreshSchedules(tip);
		}
		await this.runSchedules();
		const pruned = Number(this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'ciStoragePruned'").toArray()[0]?.value ?? 0);
		if (Date.now() - pruned > STORAGE_PRUNE_MS) {
			this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('ciStoragePruned', ?)", String(Date.now()));
			await this.storage.prune().catch((err) => console.error("ci: pruning caches and artifacts failed", err));
		}
		const stale = new Date(Date.now() - WAITING_TTL_MS).toISOString();
		for (const { number } of this.sql.exec<{ number: number }>("SELECT number FROM ci_runs WHERE status = 'waiting' AND created_at < ?", stale).toArray()) {
			await this.cancel(number, `Nobody approved it within ${WAITING_TTL_MS / 86_400_000} days`);
		}
		for (const job of this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE status = 'in_progress' AND dispatched = 0").toArray()) {
			await this.dispatchJob(job.id);
		}
		await this.retryCancels();
		const silent = this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE status = 'in_progress' AND dispatched = 1 AND reported_at < ?", Date.now() - SILENCE_MS).toArray();
		for (const job of silent) {
			this.finishJob(job, "failure", `The job stopped reporting for ${SILENCE_MS / 60_000} minutes, so it was given up on`);
			// Its sandbox may still be running somewhere: ask it to stop.
			this.sql.exec("UPDATE ci_jobs SET cancel_pending = 1 WHERE id = ?", job.id);
		}
		if (silent.length > 0) await this.retryCancels();
		await this.schedule();
	}

	private async retryCancels() {
		for (const { id } of this.sql.exec<{ id: string }>("SELECT id FROM ci_jobs WHERE cancel_pending = 1").toArray()) {
			try {
				await this.host.job(id).cancel();
				this.sql.exec("UPDATE ci_jobs SET cancel_pending = 0 WHERE id = ?", id);
			} catch (err) {
				console.error("ci: cancelling a job failed", err);
			}
		}
	}

	/**
	 * Progress from a job's Durable Object. Reports are numbered (`seq`), so a report delivered again
	 * after its answer was lost doesn't add its log twice. The answer tells a job whose run was
	 * cancelled (or deleted) to stop.
	 */
	async report(jobId: string, report: SequencedReport): Promise<ReportAck> {
		const job = this.jobRow(jobId);
		if (!job) return { cancel: true };
		if (job.status !== "in_progress" && job.status !== "completed") return { cancel: true };
		const fresh = report.seq === undefined || report.seq > job.report_seq;
		if (fresh) {
			let bytes = job.log_bytes;
			for (const entry of report.logs) {
				if (bytes >= MAX_LOG_BYTES) break;
				let text = entry.text;
				if (!text) continue;
				if (bytes + text.length > MAX_LOG_BYTES) text = `${text.slice(0, MAX_LOG_BYTES - bytes)}\n… the log is longer than ${MAX_LOG_BYTES / 1024 / 1024} MB, so the rest isn't kept\n`;
				this.sql.exec("INSERT INTO ci_logs (job, step, text) VALUES (?, ?, ?)", jobId, entry.step, text);
				bytes += text.length;
			}
			this.sql.exec("UPDATE ci_jobs SET log_bytes = ?, report_seq = ? WHERE id = ?", bytes, report.seq ?? job.report_seq, jobId);
		}
		if (job.status === "completed") {
			// Settled here already (cancelled, or given up on); the object's last steps still say how far it got.
			if (job.conclusion === "cancelled" && fresh) this.sql.exec("UPDATE ci_jobs SET steps = ? WHERE id = ?", JSON.stringify(report.steps), jobId);
			return { cancel: report.status !== "completed" };
		}
		this.sql.exec("UPDATE ci_jobs SET steps = ?, reported_at = ?, dispatched = 1 WHERE id = ?", JSON.stringify(report.steps), Date.now(), jobId);
		if (report.status === "completed") {
			this.sql.exec(
				"UPDATE ci_jobs SET status = 'completed', conclusion = ?, error = ?, finished_at = ?, outputs = ? WHERE id = ? AND status = 'in_progress'",
				report.conclusion ?? "failure",
				report.error,
				report.finishedAt ?? now(),
				report.outputs ? JSON.stringify(report.outputs) : null,
				jobId,
			);
			await this.schedule();
		}
		return { cancel: false };
	}

	// ── Cancelling and approving ─────────────────────────────────────────────

	async cancel(number: number, reason = "Cancelled"): Promise<CiRun> {
		const run = this.runRow(number);
		if (run.status === "completed") throw new HttpError(409, "COMPLETED", "That run has already finished");
		const jobs = this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE run = ? AND status != 'completed'", number).toArray();
		for (const job of jobs) {
			if (job.status === "in_progress") this.sql.exec("UPDATE ci_jobs SET cancel_pending = 1 WHERE id = ?", job.id);
			this.finishJob(job, "cancelled", reason);
		}
		this.sql.exec("UPDATE ci_runs SET error = COALESCE(error, ?) WHERE number = ?", reason, number);
		this.settleRuns();
		await this.retryCancels();
		await this.schedule();
		return this.getRun(number);
	}

	/** Cancels everything still going and forgets queued pull request events, for a repository being archived or deleted. */
	async cancelAll(reason: string): Promise<void> {
		this.sql.exec("DELETE FROM ci_pull_queue");
		for (const { number } of this.sql.exec<{ number: number }>("SELECT number FROM ci_runs WHERE status != 'completed'").toArray()) {
			await this.cancel(number, reason).catch((err) => console.error("ci: cancelling a run failed", err));
		}
	}

	async approve(number: number): Promise<CiRun> {
		const run = this.runRow(number);
		if (run.status !== "waiting") throw new HttpError(409, "NOT_WAITING", "That run isn't waiting for approval");
		this.sql.exec("UPDATE ci_runs SET status = 'queued', approved = 1 WHERE number = ? AND status = 'waiting'", number);
		this.sql.exec("UPDATE ci_jobs SET status = 'queued' WHERE run = ? AND status = 'waiting'", number);
		this.host.changed();
		await this.schedule();
		return this.getRun(number);
	}

	// ── Reading ──────────────────────────────────────────────────────────────

	private runRow(number: number): RunRow {
		const row = this.sql.exec<RunRow>("SELECT * FROM ci_runs WHERE number = ?", number).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", `Run #${number} not found`);
		return row;
	}

	private jobRow(id: string): JobRow | undefined {
		return this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE id = ?", id).toArray()[0];
	}

	private summary(r: SummaryRow): CiRunSummary {
		return {
			number: r.number,
			workflow: r.workflow,
			path: r.path,
			event: r.event,
			branch: r.branch,
			sha: r.sha,
			pull: r.pull,
			fromFork: Boolean(r.from_fork),
			actor: r.actor,
			status: r.status,
			conclusion: r.conclusion,
			error: r.error,
			createdAt: r.created_at,
			startedAt: r.started_at,
			finishedAt: r.finished_at,
		};
	}

	listRuns(filter: { workflow?: string; branch?: string; pull?: number; sha?: string; before?: number; limit?: number }): CiRunList {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (filter.workflow) (where.push("path = ?"), args.push(filter.workflow));
		if (filter.branch) (where.push("branch = ?"), args.push(filter.branch));
		if (filter.pull !== undefined) (where.push("pull = ?"), args.push(filter.pull));
		if (filter.sha) (where.push("sha = ?"), args.push(filter.sha));
		if (filter.before !== undefined) (where.push("number < ?"), args.push(filter.before));
		const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
		const rows = this.sql.exec<SummaryRow>(`SELECT ${SUMMARY} FROM ci_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY number DESC LIMIT ?`, ...args, limit + 1).toArray();
		return { runs: rows.slice(0, limit).map((r) => this.summary(r)), next: rows.length > limit ? rows[limit - 1].number : null };
	}

	/**
	 * The repository each of these runs took its code (and workflow files) from, by storage name, for the
	 * ones that ran another repository's: a fork's pull requests. Its readers alone see their insides.
	 */
	runHeads(numbers: number[]): Record<number, string> {
		const heads: Record<number, string> = {};
		for (const number of numbers) {
			const row = this.sql.exec<{ trigger: string }>("SELECT trigger FROM ci_runs WHERE number = ?", number).toArray()[0];
			const head = row ? (JSON.parse(row.trigger) as Trigger | null)?.headRepo : null;
			if (head && head !== this.host.repoId()) heads[number] = head;
		}
		return heads;
	}

	getRun(number: number): CiRun {
		const run = this.runRow(number);
		const jobs = this.sql.exec<JobRow>("SELECT * FROM ci_jobs WHERE run = ? ORDER BY rowid", number).toArray();
		return {
			...this.summary(run),
			jobs: jobs.map(
				(j): CiJobInfo => ({
					id: j.id,
					key: j.key,
					name: j.name,
					runner: j.runner,
					vcpus: j.vcpus,
					needs: JSON.parse(j.needs),
					status: j.status,
					conclusion: j.conclusion,
					error: j.error,
					steps: JSON.parse(j.steps),
					startedAt: j.started_at,
					finishedAt: j.finished_at,
				}),
			),
		};
	}

	/**
	 * A job's log (the job named by id or key) after `after` (a seq), up to about 1 MB. `next` is the
	 * `after` to ask with next time; null once the job has finished and all of it has been read.
	 */
	logs(number: number, job: string, after = 0): { logs: CiLogChunk[]; next: number | null } {
		this.runRow(number);
		const row = this.sql.exec<{ id: string; status: CiStatus }>("SELECT id, status FROM ci_jobs WHERE run = ? AND (id = ? OR key = ?) LIMIT 1", number, job, job).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", `Run #${number} has no job ${job}`);
		const rows = this.sql.exec<{ seq: number; step: number; text: string }>("SELECT seq, step, text FROM ci_logs WHERE job = ? AND seq > ? ORDER BY seq LIMIT 2000", row.id, after).toArray();
		const logs: CiLogChunk[] = [];
		let size = 0;
		for (const r of rows) {
			if (size > 1024 * 1024) break;
			logs.push({ seq: r.seq, step: r.step, text: r.text });
			size += r.text.length;
		}
		const last = logs.at(-1)?.seq ?? after;
		const more = logs.length < rows.length || rows.length === 2000;
		return { logs, next: more || row.status !== "completed" ? last : null };
	}
}

/** A job's steps as its runner reports them: setup, the workflow's steps, then cleanup. Log step i is step i. */
function jobSteps(names: string[]): CiStep[] {
	return ["Set up job", ...names, "Complete job"].map((name) => ({ name, status: "pending", conclusion: null, startedAt: null, finishedAt: null }));
}

/** Secret names a job's expressions name (workflow env, job env and outputs, and its steps). */
function usedSecrets(workflow: WorkflowSpec, job: JobSpec): string[] {
	const names = new Set<string>();
	for (const text of jobTexts(workflow, job)) {
		try {
			const parts = text.includes("${{") ? parseTemplate(text) : [];
			for (const part of parts) if (typeof part !== "string") for (const name of propertiesOf(part, "secrets")) names.add(name);
			// Conditions are expressions without ${{ }}.
			if (!text.includes("${{") && /secrets/i.test(text)) for (const name of propertiesOf(parseCondition(text), "secrets")) names.add(name);
		} catch {
			// Checked when the workflow was read; a bad expression fails its step, not this.
		}
	}
	return [...names];
}

/**
 * The cache scopes a job restores from (its own first) and saves to, as on GitHub: its branch's, or
 * for a pull request its own; then its base branch's and the default branch's.
 */
export function cacheScopes(trigger: Trigger, defaultBranch: string): { read: string[]; write: string } {
	const write = trigger.event === "pull_request" ? `refs/pull/${trigger.pull}` : `refs/heads/${trigger.branch}`;
	const read = [write];
	if (trigger.baseBranch) read.push(`refs/heads/${trigger.baseBranch}`);
	read.push(`refs/heads/${defaultBranch}`);
	return { read: [...new Set(read)], write };
}
