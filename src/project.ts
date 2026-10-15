import { DurableObject } from "cloudflare:workers";
import {
	ACTIVE_STATUSES,
	TASK_STATUSES,
	type BranchRule,
	type Branches,
	type CodeSearch,
	type Commit,
	type CommitDetail,
	type Comparison,
	type ConflictInfo,
	type Diff,
	type EventType,
	type Blame,
	type FileHistory,
	type GitCredentials,
	type Graph,
	type GraphCommit,
	type Release,
	type Tag,
	type Project,
	type ProjectEvent,
	type QueueEntry,
	type Task,
	type TaskAccess,
	type TaskStatus,
	type Tree,
	type Webhook,
	type WebhookDelivery,
	type WebhookEvent,
} from "./api.ts";
import { approvedAt, closeIssuesByCommits, db as databaseOf, getPull, notify, notifyUser, unreadableRepos, type PullViewer } from "./db.ts";
import { errorCode, HttpError, toHttpError } from "./errors.ts";
import { diffTrees, mapLimit, topoOrder, walkToMainline, type ObjectReader } from "./git/diff.ts";
import { commitChanges, NoChanges, PathError, TooLarge, type FileChange } from "./git/commit.ts";
import { deleteBranch, listBranches, listRefs, RefUpdateRejected, remoteHead, setRef, type TagRef } from "./git/protocol.ts";
import { protectionFor, validPattern } from "./branch-rules.ts";
import { Workspace, type Identity, type RemoteAccess } from "./git/workspace.ts";
import { claimsOverlap, forkRepoName, newTaskId, normalizeClaim, wikiRepoName } from "./names.ts";
import { Wiki, type SavePageInput } from "./wiki.ts";
import { Webhooks, type RepositoryRef } from "./hooks.ts";
import { CodeIndex } from "./search.ts";
import { blame, fileHistory, type HistoryReader } from "./git/history.ts";
import { repoStore, type RepoHandle, type RepoStore } from "./store.ts";
import { CiRuns, privateRun, type ChecksState, type PullTrigger, type ReportAck, type SequencedReport } from "./ci/runs.ts";
import type { JobGrant } from "./ci/token.ts";
import type { CiJob } from "./ci/job.ts";
import type { CiArtifact, CiCache, CiRun, CiRunList, CiRunSummary, CiSettings, CiWorkflow, CiLogChunk, PullChecks, WikiIndex, WikiPage } from "./api.ts";

const MERGE_IDENTITY: Identity = { name: "maggot", email: "merge-queue@maggot.dev" };
const AGENT_TOKEN_TTL = 6 * 3600;
const INTERNAL_TOKEN_TTL = 900;
/** Drop the cached workspace after this many merges to bound memory. */
const WORKSPACE_MAX_MERGES = 50;
const MAX_PUSH_ATTEMPTS = 3;
/** How much default-branch history ahead/behind counts and merge bases are searched in. */
const MAINLINE_DEPTH = 1000;
/** Direct push tokens for people are long-lived; they end up in a git remote URL. */
const REPO_TOKEN_TTL = 30 * 24 * 3600;
/**
 * Artifacts fails a large share of concurrent forks of the same repo (40% at 8 at once, 0% at 2 in
 * our measurements), while forks of different repos don't interfere. So forks are throttled per
 * project, which is exactly the scope of one coordinator.
 */
const FORK_CONCURRENCY = 2;
const FORK_MAX_ATTEMPTS = 5;
const FORK_RETRY_DELAYS = [500, 1500, 3000, 6000];
/** How long POST /tasks waits for its fork before answering with a still-provisioning task. */
const FORK_WAIT_MS = 25_000;
/** When the alarm re-checks for provisioning tasks whose request died. */
const RECOVERY_DELAY_MS = 30_000;

export interface CreateProjectInput {
	name: string;
	description?: string;
	defaultBranch?: string;
	importUrl?: string;
	importDepth?: number;
	importBranch?: string;
	/** The README's heading, when the project name is an internal id. */
	title?: string;
	/** The repository was already forked into `name` (by the source's coordinator); take it over. */
	forked?: boolean;
	/** Seed a README so the repo starts with a commit (default true). Leave it out to push an existing repo. */
	readme?: boolean;
}

export interface CommitFilesInput {
	/** The pack may be at most this big (the push limit, or the room left). */
	maxPackBytes: number;
	branch: string;
	/** The branch head the edit started from; null for an empty repository. */
	baseCommit?: string | null;
	newBranch?: string;
	/** `modeFrom`: the path whose mode the file takes (a rename). */
	changes: (FileChange & { modeFrom?: string })[];
	message: string;
	author: Identity;
}

/** Git's ref name rules, as far as branch names typed into a form go. */
export function validBranchName(name: string): boolean {
	return (
		/^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
		name !== "HEAD" &&
		!name.startsWith("-") &&
		!name.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock")) &&
		!name.includes("..") &&
		!name.endsWith(".")
	);
}

export interface CreateTaskInput {
	title: string;
	agent?: string;
	paths?: string[];
}

type TaskRow = {
	id: string;
	title: string;
	agent: string | null;
	status: TaskStatus;
	paths: string;
	repo: string;
	remote: string;
	fork_attempts: number;
	base_oid: string | null;
	head_oid: string | null;
	merged_oid: string | null;
	changed_files: string;
	conflict: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	submitted_at: string | null;
	merged_at: string | null;
};

type Meta = {
	name: string;
	description: string | null;
	defaultBranch: string;
	remote: string;
	createdAt: string;
	/** The storage's own HEAD, when the default branch was set to another (storage can't move HEAD). */
	storeBranch?: string;
};

/**
 * One instance per project. It is the only writer to the project's default branch: agents push
 * to their own task forks, and merges are serialized through a queue drained by the alarm.
 */
export class ProjectCoordinator extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private readonly store: RepoStore;
	private readonly code: CodeIndex;
	private readonly hooks: Webhooks;
	private readonly ci: CiRuns;
	private readonly wiki: Wiki;
	private workspace: Workspace | undefined;
	private workspaceMerges = 0;
	private baseToken: { token: string; expires: number } | undefined;
	private readToken: { token: string; expires: number } | undefined;
	/** Tags as last listed, for resolving tag names; the announced set is in meta. */
	private tagCache: { tags: Record<string, string>; at: number } | undefined;
	/** Once the default branch has a commit it always will; skips re-checking on every task. */
	private hasCommits = false;
	private readonly forkSlots = new Semaphore(FORK_CONCURRENCY);
	/** Merges and branch-rule changes run one at a time, keeping protection stable through each push. */
	private readonly mergeSlot = new Semaphore(1);
	/** In-flight provisioning per task, so a request and the recovery alarm never fork twice. */
	private readonly provisioning = new Map<string, Promise<ArtifactsCreateRepoResult | null>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.store = repoStore(env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				agent TEXT,
				status TEXT NOT NULL,
				paths TEXT NOT NULL DEFAULT '[]',
				repo TEXT NOT NULL,
				remote TEXT NOT NULL,
				base_oid TEXT,
				head_oid TEXT,
				merged_oid TEXT,
				changed_files TEXT NOT NULL DEFAULT '[]',
				conflict TEXT,
				error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				submitted_at TEXT,
				merged_at TEXT
			);
			CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
			CREATE INDEX IF NOT EXISTS tasks_created ON tasks (created_at);
			CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE, enqueued_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS cleanup (repo TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS events (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				ts TEXT NOT NULL,
				type TEXT NOT NULL,
				task_id TEXT,
				data TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS releases (
				id TEXT PRIMARY KEY,
				tag TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				notes TEXT NOT NULL,
				prerelease INTEGER NOT NULL DEFAULT 0,
				author TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS ci_pushes (id INTEGER PRIMARY KEY AUTOINCREMENT, branch TEXT NOT NULL, sha TEXT NOT NULL, actor TEXT, attempts INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS commit_summaries (hash TEXT PRIMARY KEY, summary TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS graph_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS history_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS branch_rules (
				pattern TEXT PRIMARY KEY,
				block_deletions INTEGER NOT NULL,
				block_force_pushes INTEGER NOT NULL,
				require_merge_queue INTEGER NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
		// Columns added after the first schema; ALTER fails harmlessly when they already exist.
		for (const column of ["ALTER TABLE tasks ADD COLUMN fork_attempts INTEGER NOT NULL DEFAULT 0", "ALTER TABLE branch_rules ADD COLUMN require_review INTEGER NOT NULL DEFAULT 0", "ALTER TABLE branch_rules ADD COLUMN require_checks INTEGER NOT NULL DEFAULT 0"]) {
			try {
				this.sql.exec(column);
			} catch {
				// Already migrated.
			}
		}
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		this.code = new CodeIndex(this.sql);
		this.hooks = new Webhooks(this.sql);
		this.ci = new CiRuns({
			sql: this.sql,
			env,
			store: this.store,
			repoId: () => this.meta().name,
			repository: () => this.repository(),
			// Its own Worker's class, so a loopback namespace rather than a binding (a container can't be attached to a Durable Object bound by Worker name).
			job: (id) => (ctx.exports.CiJob as unknown as DurableObjectNamespace<CiJob>).getByName(id),
			emit: (data, headRepo) => this.ctx.waitUntil(this.emitForkEvent("ci.completed", data, headRepo)),
			changed: () => {
				for (const ws of this.ctx.getWebSockets()) {
					try {
						ws.send("ci");
					} catch {
						// Socket already closed; the runtime cleans it up.
					}
				}
			},
			wake: (at) => this.scheduleAlarm(at),
			archived: () => this.sql.exec("SELECT 1 FROM meta WHERE key = 'archived'").toArray().length > 0,
		});
		this.wiki = new Wiki({
			sql: this.sql,
			store: this.store,
			name: () => wikiRepoName(this.meta().name),
			ready: (name) => this.waitReady(name),
			assertWritable: () => this.assertWritable(),
			history: (repo, start, path) => this.cached(`wiki-history:${start}:${path}`, () => fileHistory(repo as unknown as HistoryReader, start, path)),
			emit: (data) => this.emit("wiki.updated", null, data as unknown as Record<string, unknown>),
		});
	}

	// ── Project ──────────────────────────────────────────────────────────────

	async create(input: CreateProjectInput): Promise<Project> {
		if (input.importDepth !== undefined && (!Number.isInteger(input.importDepth) || input.importDepth < 1 || input.importDepth > 10_000)) throw new HttpError(400, "INVALID_INPUT", "importDepth must be an integer from 1 to 10000");
		if (this.metaOrNull()) throw new HttpError(409, "ALREADY_EXISTS", `Project ${input.name} already exists`);
		// Artifacts imports `main` and reports it as the default unless told the branch, so an import takes
		// the source's own default (master, trunk, …) from its HEAD.
		const importBranch = input.importUrl ? (input.importBranch ?? (await remoteHead(input.importUrl))) : undefined;
		let created: Pick<ArtifactsCreateRepoResult, "name" | "description" | "defaultBranch" | "remote" | "token">;
		// Made just now by this call (not imported, forked or adopted), so it's known to be empty.
		let fresh = false;
		try {
			created = await retrying(async () => {
				if (input.forked) {
					await this.waitReady(input.name);
					using repo = await this.store.get(input.name);
					const [info, token] = await Promise.all([repo.info(), repo.createToken("write", INTERNAL_TOKEN_TTL)]);
					return { ...info, token: token.plaintext };
				}
				if (input.importUrl) {
					return this.store.import({
						source: { url: input.importUrl, branch: importBranch, depth: input.importDepth },
						target: { name: input.name, opts: { description: input.description } },
					});
				}
				const made = await this.store.create(input.name, { description: input.description, setDefaultBranch: input.defaultBranch ?? "master" });
				fresh = true;
				return made;
			});
		} catch (err) {
			// The repo exists but this coordinator never recorded it: a previous create died partway
			// (for example, the object was reset mid-request). Adopt it and finish the setup.
			if (errorCode(err) !== "ALREADY_EXISTS") throw err;
			await this.waitReady(input.name);
			using repo = await this.store.get(input.name);
			const [info, token] = await Promise.all([repo.info(), repo.createToken("write", INTERNAL_TOKEN_TTL)]);
			created = { ...info, token: token.plaintext };
		}

		await this.waitReady(created.name);
		// The storage's HEAD can't be moved, so a fork keeps its source's chosen default on top of it.
		const storeBranch = created.defaultBranch;
		if (importBranch) created = { ...created, defaultBranch: importBranch };
		else if (input.forked && input.defaultBranch) created = { ...created, defaultBranch: input.defaultBranch };
		const remote = { url: created.remote, token: created.token };
		const seed = !input.importUrl && !input.forked && input.readme !== false;
		// What's there now (a README, a fork's or an import's branches), so the first push reports only its own changes.
		// A fresh repository's are known without asking: none, or the README's commit.
		let refs: Record<string, string> | null = null;
		if (fresh) {
			refs = seed ? { [created.defaultBranch]: await seedReadme(remote, created.defaultBranch, input) } : {};
		} else {
			const empty = await (async () => {
				using repo = await this.store.get(created.name);
				return (await repo.log({ ref: created.defaultBranch, limit: 1 })).length === 0;
			})();
			if (empty && seed) await seedReadme(remote, created.defaultBranch, input);
		}

		const meta: Meta = {
			name: created.name,
			description: created.description,
			defaultBranch: created.defaultBranch,
			remote: created.remote,
			createdAt: new Date().toISOString(),
			...(storeBranch !== created.defaultBranch ? { storeBranch } : {}),
		};
		this.sql.exec("INSERT INTO meta (key, value) VALUES ('project', ?)", JSON.stringify(meta));
		try {
			refs ??= Object.fromEntries(await listBranches(remote));
			this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('refs', ?)", JSON.stringify(refs));
		} catch (err) {
			console.error("recording initial branches failed", err);
		}
		this.emit("project.created", null, { name: meta.name, imported: Boolean(input.importUrl), forked: Boolean(input.forked) });
		// A fresh repository's head is known too, so describing it needs no lookup.
		if (fresh && refs) return this.describe(meta, refs[meta.defaultBranch] ?? null);
		return this.getProject();
	}

	/**
	 * Git credentials for the project repo itself, for people pushing to it directly (for example the
	 * first push of an existing repository). Agents should use tasks instead, so the merge queue applies.
	 */
	async repoAccess(scope: "read" | "write" = "write", ttl = REPO_TOKEN_TTL): Promise<GitCredentials> {
		const meta = this.meta();
		if (scope === "write") this.assertWritable();
		return this.credentials(meta.name, meta.defaultBranch, scope, ttl);
	}

	/** Where the Git proxy sends a user's clone or push, with a cached short-lived Artifacts token. */
	async gitRemote(scope: "read" | "write"): Promise<RemoteAccess> {
		const meta = this.meta();
		if (scope === "write") {
			this.assertWritable();
			return this.baseAccess(meta);
		}
		if (!this.readToken || this.readToken.expires < Date.now() + 120_000) {
			const creds = await this.credentials(meta.name, meta.defaultBranch, "read", INTERNAL_TOKEN_TTL);
			this.readToken = { token: creds.token, expires: Date.parse(creds.expiresAt) };
		}
		return { url: meta.remote, token: this.readToken.token };
	}

	/** What a fetch needs: read access, and the branch to advertise as HEAD when it isn't storage's own. */
	async fetchContext(): Promise<{ remote: RemoteAccess; rules: BranchRule[]; head?: { branch: string; oid?: string } }> {
		const meta = this.meta();
		const moved = meta.storeBranch && meta.storeBranch !== meta.defaultBranch;
		return { remote: await this.gitRemote("read"), rules: [], head: moved ? { branch: meta.defaultBranch, oid: this.knownRefs(meta)[meta.defaultBranch] } : undefined };
	}

	/** What a push needs: write access to the repository and its branch rules, in one round trip. */
	async pushContext(): Promise<{ remote: RemoteAccess; rules: BranchRule[] }> {
		return { remote: await this.gitRemote("write"), rules: this.branchRules() };
	}

	/** Called after a push through the Git proxy: records the new head so live views refresh. `actor` is who pushed, if known. */
	async pushed(actor: string | null = null): Promise<void> {
		const meta = this.meta();
		// The proxy can't see which refs a push touched, so compare every branch and tag with what was seen last.
		const listed = await listRefs(await this.baseAccess(meta));
		const now = Object.fromEntries(listed.branches);
		const before = this.knownRefs(meta);
		const refs = [...new Set([...Object.keys(before), ...Object.keys(now)])]
			.filter((branch) => before[branch] !== now[branch])
			.map((branch) => ({ branch, from: before[branch] ?? null, to: now[branch] ?? null }));
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('refs', ?)", JSON.stringify(now));
		this.recordTags(tagCommits(listed.tags));
		const head = now[meta.defaultBranch] ?? null;
		if (head) this.hasCommits = true;
		const main = refs.find((r) => r.branch === meta.defaultBranch);
		this.emit("repo.pushed", null, { branch: meta.defaultBranch, from: main ? main.from : head, to: head, moved: Boolean(main), refs });
		if (main) await this.requestIndex();
		if (main?.to) this.closeReferencedIssues(main.from, main.to);
		await this.startCi(refs, actor);
	}

	/**
	 * Queues Actions for moved branches: this repository's push workflows, and the pull_request
	 * workflows of open pull requests (here or in the repository this one was forked from) whose head is
	 * one of them. The alarm starts them, so a push isn't held up reading workflow files, and nothing is
	 * lost if this object restarts first.
	 */
	private async startCi(refs: { branch: string; from: string | null; to: string | null }[], actor: string | null) {
		const moved = refs.filter((r) => r.to !== null && !r.branch.startsWith("maggot-incoming/"));
		if (moved.length === 0) return;
		for (const r of moved) this.sql.exec("INSERT INTO ci_pushes (branch, sha, actor) VALUES (?, ?, ?)", r.branch, r.to, actor);
		await this.scheduleAlarm(Date.now());
	}

	/** Starts the Actions queued by startCi. Each step is idempotent, so a push retried after a failure starts nothing twice. */
	private async drainCiPushes(): Promise<void> {
		const meta = this.meta();
		for (const push of this.sql.exec<{ id: number; branch: string; sha: string; actor: string | null; attempts: number }>("SELECT * FROM ci_pushes ORDER BY id LIMIT 20").toArray()) {
			try {
				await this.ci.onPush(push.branch, push.sha, push.actor);
				const pulls = await databaseOf(this.env)
					.prepare(
						`select p."repoId", i."number", p."baseBranch", a."username" as "author" from "pull" p join "issue" i on i."id" = p."issueId" left join "user" a on a."id" = i."authorId" where p."headRepoId" = ? and p."headBranch" = ? and i."state" = 'open'`,
					)
					.bind(meta.name, push.branch)
					.all<{ repoId: string; number: number; baseBranch: string; author: string | null }>();
				for (const p of pulls.results) {
					const fork = p.repoId !== meta.name;
					const input: PullTrigger = {
						number: p.number,
						headRepo: fork ? meta.name : null,
						cloneUrl: this.repository().cloneUrl,
						branch: push.branch,
						sha: push.sha,
						baseBranch: p.baseBranch,
						fromFork: fork,
						actor: push.actor,
						action: "synchronize",
						// Pushing here took write access to this repository; to the base, only if it's this one.
						approved: !fork,
						author: p.author,
					};
					if (fork) await (this.env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(p.repoId).ciPull(input);
					else await this.ci.queuePull(input);
				}
				this.sql.exec("DELETE FROM ci_pushes WHERE id = ?", push.id);
			} catch (err) {
				console.error("ci: starting workflows for a push failed", err);
				if (push.attempts + 1 >= 5) this.sql.exec("DELETE FROM ci_pushes WHERE id = ?", push.id);
				else this.sql.exec("UPDATE ci_pushes SET attempts = attempts + 1 WHERE id = ?", push.id);
			}
		}
	}

	/** Branch heads as last seen (by a push or a merge). Older coordinators only kept the default branch's. */
	private knownRefs(meta: Meta): Record<string, string> {
		const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('refs', 'pushedHead')").toArray();
		const refs = rows.find((r) => r.key === "refs");
		if (refs) return JSON.parse(refs.value);
		const head = rows.find((r) => r.key === "pushedHead")?.value;
		return head ? { [meta.defaultBranch]: head } : {};
	}

	/** Tag name to commit, as last seen; how tag names typed into a URL resolve. */
	private knownTags(): Record<string, string> {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'tags'").toArray()[0];
		return row ? JSON.parse(row.value) : {};
	}

	/**
	 * Records the tags after a change: those that appeared or went away become events (and push
	 * webhooks). The first time, there's nothing to compare with, so they're only recorded; a
	 * repository's existing tags aren't news.
	 */
	private recordTags(now: Record<string, string>) {
		const seen = this.sql.exec("SELECT 1 FROM meta WHERE key = 'tags'").toArray().length > 0;
		const before = this.knownTags();
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('tags', ?)", JSON.stringify(now));
		this.tagCache = { tags: now, at: Date.now() };
		if (!seen) return;
		for (const name of Object.keys(now)) if (before[name] !== now[name]) this.emit("tag.created", null, { tag: name, commit: now[name], from: before[name] ?? null });
		for (const name of Object.keys(before)) if (!(name in now)) this.emit("tag.deleted", null, { tag: name, commit: before[name] });
	}

	/**
	 * Tags read for a listing: kept for resolving tag names in URLs, but not recorded as seen (unless
	 * nothing ever was), so a tag pushed a moment ago still gets its event when the push is recorded.
	 */
	private observeTags(now: Record<string, string>) {
		this.tagCache = { tags: now, at: Date.now() };
		if (this.sql.exec("SELECT 1 FROM meta WHERE key = 'tags'").toArray().length === 0) {
			this.sql.exec("INSERT INTO meta (key, value) VALUES ('tags', ?)", JSON.stringify(now));
		}
	}

	/**
	 * resolveRef, after looking the refs up again if `ref` isn't a branch or tag seen yet (a tag that
	 * predates maggot tracking them, typed into a URL). At most every few seconds.
	 */
	private async freshRef(ref: string): Promise<{ repoName: string; ref: string }> {
		const meta = this.meta();
		const known = ref.startsWith("task:") || /^[0-9a-f]{40}$/.test(ref) || ref in this.knownRefs(meta) || ref in this.knownTags() || (this.tagCache && ref in this.tagCache.tags);
		if (!known && (!this.tagCache || this.tagCache.at < Date.now() - 5_000)) {
			const { tags } = await listRefs(await this.baseAccess(meta));
			this.observeTags(tagCommits(tags));
		}
		return this.resolveRef(ref);
	}

	private recordRef(meta: Meta, branch: string, oid: string) {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('refs', ?)", JSON.stringify({ ...this.knownRefs(meta), [branch]: oid }));
	}

	// ── Code search ──────────────────────────────────────────────────────────

	/** Asks the alarm to bring the code index up to the default branch. */
	private async requestIndex(): Promise<void> {
		if (!this.code.available) return;
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexWanted', '1')");
		await this.scheduleAlarm(Date.now());
	}

	private async indexIfWanted(): Promise<void> {
		const wanted = this.sql.exec("SELECT 1 FROM meta WHERE key = 'indexWanted'").toArray().length > 0;
		if (!wanted) return;
		this.sql.exec("DELETE FROM meta WHERE key = 'indexWanted'");
		const meta = this.meta();
		try {
			using repo = await this.store.get(meta.name);
			const [head] = await repo.log({ ref: meta.defaultBranch, limit: 1 });
			if (head) await this.code.update(repo, head.hash, head.treeHash);
		} catch (err) {
			console.error("indexing failed", err);
		}
	}

	/** Searches the default branch. Starts indexing if the index is behind; results may then be older. */
	async searchCode(query: string): Promise<CodeSearch> {
		const meta = this.meta();
		if (!this.code.available) return { commit: null, partial: false, files: 0, indexing: false, results: [] };
		// Pushes and merges record the branch head; only a repository that predates that needs a lookup.
		let head = this.knownRefs(meta)[meta.defaultBranch] ?? null;
		if (!head) {
			using repo = await this.store.get(meta.name);
			head = (await repo.log({ ref: meta.defaultBranch, limit: 1 }))[0]?.hash ?? null;
		}
		const behind = head !== null && this.code.state()?.commit !== head;
		if (behind) await this.requestIndex();
		return { ...this.code.search(query), indexing: behind };
	}

	// ── Webhooks ─────────────────────────────────────────────────────────────

	/** How payloads name this repository; set by the API when a user repository is created. */
	/**
	 * After a transfer: the old owner's webhook endpoints shouldn't keep hearing about a repository
	 * they may no longer see, so every hook is paused until the new owner turns it back on.
	 */
	async pauseHooks(): Promise<number> {
		this.meta();
		return this.hooks.pauseAll();
	}

	async setRepository(ref: RepositoryRef): Promise<void> {
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('repository', ?)", JSON.stringify(ref));
	}

	private repository(): RepositoryRef {
		const meta = this.meta();
		const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'repository'").toArray()[0];
		return row ? JSON.parse(row.value) : { fullName: meta.name, url: "", cloneUrl: "", defaultBranch: meta.defaultBranch };
	}

	async listHooks(): Promise<Webhook[]> {
		this.meta();
		return this.hooks.list();
	}

	async createHook(input: { url: string; secret: string; events: WebhookEvent[] }): Promise<Webhook> {
		this.meta();
		const hook = this.hooks.create(input);
		this.hooks.ping(hook.id, this.repository());
		await this.scheduleAlarm(Date.now());
		return this.hooks.get(hook.id);
	}

	async updateHook(id: string, patch: { url?: string; secret?: string; events?: WebhookEvent[]; active?: boolean }): Promise<Webhook> {
		this.meta();
		return this.hooks.update(id, patch);
	}

	async deleteHook(id: string): Promise<void> {
		this.meta();
		this.hooks.remove(id);
	}

	async hookDeliveries(id: string): Promise<WebhookDelivery[]> {
		this.meta();
		return this.hooks.deliveries(id);
	}

	async pingHook(id: string): Promise<WebhookDelivery> {
		this.meta();
		const delivery = this.hooks.ping(id, this.repository());
		await this.scheduleAlarm(Date.now());
		return delivery;
	}

	async redeliverHook(id: string, deliveryId: string): Promise<WebhookDelivery> {
		this.meta();
		const delivery = this.hooks.redeliver(id, deliveryId);
		await this.scheduleAlarm(Date.now());
		return delivery;
	}

	private async deliverHooks(): Promise<void> {
		const failed = await this.hooks.deliverDue();
		for (const f of failed) {
			this.notifyOwner("webhook.failing", `A webhook to ${new URL(f.url).host} keeps failing: ${f.error.slice(0, 120)}`, "settings");
		}
	}

	/** Tells the repository's owner (people's repositories only) about something that happened. */
	private notifyOwner(kind: "task.merged" | "task.failed" | "task.conflict" | "webhook.failing", title: string, path: string) {
		const id = this.meta().name;
		this.ctx.waitUntil(
			notify(this.env, id, { kind, title, path }).catch((err) => console.error("notification failed", err)),
		);
	}

	async getProject(): Promise<Project> {
		const meta = this.meta();
		let head: string | null = null;
		try {
			using repo = await this.store.get(meta.name);
			head = (await repo.log({ ref: meta.defaultBranch, limit: 1 }))[0]?.hash ?? null;
		} catch {
			// Repo still importing or temporarily unavailable; head is informational.
		}
		return this.describe(meta, head);
	}

	/** The project as the API shows it, with its default branch at `head`. */
	private describe(meta: Meta, head: string | null): Project {
		const stats = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
		for (const row of this.sql.exec<{ status: TaskStatus; n: number }>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")) {
			stats[row.status] = row.n;
		}
		const queueLength = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue").one().n;
		return { ...meta, head, stats, queueLength };
	}

	/** Deletes every task fork, the project repo, and all coordinator state. */
	async destroy(): Promise<void> {
		const meta = this.meta();
		// Jobs run (and may cost money) in their own objects; stop them before their runs are forgotten.
		await this.ci.cancelAll("The repository was deleted");
		await this.ci.storage.dropAll().catch((err) => console.error("deleting Actions caches and artifacts failed", err));
		const forks = [
			...this.sql.exec<{ repo: string }>("SELECT repo FROM tasks WHERE status != 'abandoned'").toArray(),
			...this.sql.exec<{ repo: string }>("SELECT repo FROM cleanup").toArray(),
		];
		// Each delete takes seconds; run them in parallel batches so large projects finish in one request.
		for (let i = 0; i < forks.length; i += 10) {
			await Promise.all(forks.slice(i, i + 10).map((row) => this.store.delete(row.repo).catch(() => false)));
		}
		await this.store.delete(meta.name).catch(() => false);
		await this.wiki.destroy();
		for (const ws of this.ctx.getWebSockets()) ws.close(1001, "Project deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async log(ref?: string, limit = 50): Promise<Commit[]> {
		const meta = this.meta();
		const { repoName, ref: resolved } = await this.freshRef(ref ?? meta.defaultBranch);
		using repo = await this.store.get(repoName);
		const commits = await repo.log({ ref: resolved, limit: Math.max(1, Math.min(limit, 200)) });
		return commits.map((c) => ({
			hash: c.hash,
			message: c.message,
			author: c.author,
			parents: c.parents,
			committedAt: c.committedAt,
		}));
	}

	/** `ref` is a branch/commit of the project repo, or `task:<id>` for a task fork's head. */
	async readFile(ref: string | undefined, path: string): Promise<{ content: string; contentType: string } | null> {
		const meta = this.meta();
		const { repoName, ref: resolved } = await this.freshRef(ref ?? meta.defaultBranch);
		using repo = await this.store.get(repoName);
		const blob = await repo.readFile({ ref: resolved, path });
		return blob ? { content: await blob.text(), contentType: blob.type || "text/plain;charset=utf-8" } : null;
	}

	/** Lists a directory at `ref` (same refs as readFile). `commit` is null for an empty repo. */
	async tree(ref: string | undefined, path = ""): Promise<Tree> {
		const meta = this.meta();
		const { repoName, ref: resolved } = await this.freshRef(ref ?? meta.defaultBranch);
		using repo = await this.store.get(repoName);
		const [commit] = await repo.log({ ref: resolved, limit: 1 });
		const parts = path.split("/").filter(Boolean);
		const dir = parts.join("/");
		if (!commit) return { commit: null, path: dir, entries: [] };
		let hash = commit.treeHash;
		for (const [i, part] of parts.entries()) {
			const next = (await repo.readTree(hash))?.find((e) => e.name === part && e.type === "tree");
			if (!next) throw new HttpError(404, "NOT_FOUND", `${parts.slice(0, i + 1).join("/")} is not a directory`);
			hash = next.hash;
		}
		const entries = (await repo.readTree(hash)) ?? [];
		return {
			commit: commit.hash,
			path: dir,
			entries: entries
				.map((e) => ({ name: e.name, path: dir ? `${dir}/${e.name}` : e.name, type: e.type, hash: e.hash }))
				.sort((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name)),
		};
	}

	/** The commits that changed `path`, from `ref` (or from commit `from`, to page further back). */
	async fileHistory(ref: string | undefined, path: string, from?: string): Promise<FileHistory> {
		const meta = this.meta();
		const { repoName, ref: resolved } = await this.freshRef(ref ?? meta.defaultBranch);
		using repo = await this.store.get(repoName);
		const start = from && /^[0-9a-f]{40}$/.test(from) ? from : (await resolveCommit(repo, resolved)).hash;
		return this.cached(`history:${repoName}:${start}:${path}`, () => fileHistory(repo as unknown as HistoryReader, start, path));
	}

	/** Who last changed each line of `path` at `ref`. */
	async blame(ref: string | undefined, path: string): Promise<Blame> {
		const meta = this.meta();
		const { repoName, ref: resolved } = await this.freshRef(ref ?? meta.defaultBranch);
		using repo = await this.store.get(repoName);
		const start = (await resolveCommit(repo, resolved)).hash;
		return this.cached(`blame:${repoName}:${start}:${path}`, async () => {
			try {
				return await blame(repo as unknown as HistoryReader, start, path);
			} catch (err) {
				if (err instanceof Error && /isn't a file/.test(err.message)) throw new HttpError(404, "NOT_FOUND", `${path} not found`);
				throw err;
			}
		});
	}

	/** History and blame for a commit never change, so the last 100 are kept. */
	private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
		const hit = this.sql.exec<{ value: string }>("SELECT value FROM history_cache WHERE key = ?", key).toArray()[0];
		if (hit) {
			this.sql.exec("UPDATE history_cache SET at = ? WHERE key = ?", Date.now(), key);
			return JSON.parse(hit.value) as T;
		}
		const value = await compute();
		const json = JSON.stringify(value);
		// Big results (a long file's blame) aren't worth the storage.
		if (json.length < 1_000_000) {
			this.sql.exec("INSERT OR REPLACE INTO history_cache (key, value, at) VALUES (?, ?, ?)", key, json, Date.now());
			this.sql.exec("DELETE FROM history_cache WHERE key NOT IN (SELECT key FROM history_cache ORDER BY at DESC LIMIT 100)");
		}
		return value;
	}

	// ── Pull requests ────────────────────────────────────────────────────────

	/**
	 * What a pull request would bring into `base`: the commits on `headBranch` (of this repository, or
	 * of the fork `headRepo`) since their merge base, and the diff. Not reachable from URLs, which only
	 * name this repository's refs; the API checks who may read the fork.
	 */
	async pullCompare(base: string, headRepo: string | null, headBranch: string): Promise<Comparison> {
		const meta = this.meta();
		using project = await this.store.get(meta.name);
		using fork = headRepo && headRepo !== meta.name ? await this.store.get(headRepo) : null;
		const repo = fork ?? project;
		const mainline = await project.log({ ref: base, limit: MAINLINE_DEPTH });
		if (mainline.length === 0) throw new HttpError(404, "NOT_FOUND", `${base} does not exist or has no commits`);
		const tip = await resolveCommit(repo, headBranch);
		const walk = await walkToMainline(repo, tip.hash, mainline.map((c) => c.hash));
		const from = mainline.find((c) => c.hash === walk.mergeBase) ?? mainline[0];
		return {
			base: mainline[0].hash,
			head: tip.hash,
			mergeBase: walk.mergeBase,
			commits: walk.commits,
			capped: walk.capped,
			diff: await diffTrees(repo, from.treeHash, tip.treeHash),
		};
	}

	/**
	 * Merges a pull request's head into `base`, with a merge commit or squashed into one commit, and
	 * pushes it. Conflicts come back as 409 with the files; nothing is pushed then. The merge goes
	 * through the same single slot as the merge queue's, so they never race.
	 */
	async mergePull(input: {
		base: string;
		headRepo: string | null;
		headBranch: string;
		method: "merge" | "squash";
		message: string;
		author: Identity;
		/** The head commit the merger saw (and reviewers approved); the merge stops if the branch has moved on. */
		expectedHead?: string;
		/** The pull request's number, for checking the branch's rules (reviews, Actions) right before pushing. */
		pull?: number;
	}): Promise<{ commit: string; changedFiles: string[]; onDefaultBranch: boolean }> {
		this.meta();
		this.assertWritable();
		return this.mergeSlot.run(async () => {
			// Read inside the slot: the default branch may have changed while this merge waited.
			const meta = this.meta();
			const base = await this.baseAccess(meta);
			const head = input.headRepo && input.headRepo !== meta.name ? await this.credentials(input.headRepo, input.headBranch, "read", INTERNAL_TOKEN_TTL) : null;
			const headAccess = head ? { url: head.remote, token: head.token } : base;
			// The default branch's workspace is kept between merges (and reset now and then, as the queue's is); other bases get a fresh one.
			if (input.base === meta.defaultBranch && (!this.workspace || this.workspace.branch !== meta.defaultBranch || this.workspaceMerges >= WORKSPACE_MAX_MERGES)) {
				this.workspace = new Workspace(meta.defaultBranch, MERGE_IDENTITY);
				this.workspaceMerges = 0;
			}
			const ws = input.base === meta.defaultBranch ? (this.workspace as Workspace) : new Workspace(input.base, MERGE_IDENTITY);
			if (ws === this.workspace) this.workspaceMerges++;
			try {
				for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
					await ws.syncBase(base);
					const theirs = await ws.fetchTask(headAccess, input.headBranch).catch(async (err) => {
						if (errorCode(err) !== "NotFoundError") throw err;
						// Only a branch that's really gone is the pull request's problem; anything else is the
						// workspace's, which is discarded below.
						const branches = await listBranches(headAccess).catch(() => null);
						if (branches && !branches.has(input.headBranch)) throw new HttpError(409, "HEAD_GONE", `${input.headBranch} no longer exists, so there's nothing to merge`);
						throw err;
					});
					if (input.expectedHead && theirs !== input.expectedHead) {
						throw new HttpError(409, "HEAD_MOVED", `${input.headBranch} has new commits since you looked; review them and merge again`);
					}
					const outcome = await ws.merge(theirs, input.message, input.author, input.method === "squash" ? "squash" : "merge-commit");
					if (outcome.kind === "conflict") {
						throw new HttpError(409, "MERGE_CONFLICT", `These files conflict with ${input.base}: ${outcome.files.join(", ") || "unknown"}. Merge ${input.base} into the branch and push again.`);
					}
					if (outcome.kind === "up-to-date") throw new HttpError(409, "NOTHING_TO_MERGE", `${input.base} already has everything in this pull request`);
					// The rules as they are now, for the commit being merged: an admin may have turned on
					// required reviews or Actions since the API checked them.
					if (input.pull !== undefined) await this.assertMergeable(input.pull, input.base, input.headRepo && input.headRepo !== meta.name ? input.headRepo : null, theirs);
					if (await ws.push(base)) {
						// Capture this before post-push work awaits anything else.
						const onDefaultBranch = input.base === this.meta().defaultBranch;
						// Like a push: events, webhooks, the code index, Actions and "fixes #n" all follow.
						await this.pushed(input.author.name);
						return { commit: outcome.oid, changedFiles: outcome.changedFiles, onDefaultBranch };
					}
				}
				throw new HttpError(409, "PUSH_REJECTED", `${input.base} kept moving; try again`);
			} catch (err) {
				if (ws === this.workspace && !(err instanceof HttpError)) this.workspace = undefined;
				throw err;
			}
		});
	}

	/**
	 * Refuses a pull request merge of `head` that `base`'s branch rules don't allow right now. Runs in
	 * the merge slot, which rule changes also take, so the rules read here still hold at the push.
	 */
	private async assertMergeable(number: number, base: string, headRepo: string | null, head: string): Promise<void> {
		const rule = protectionFor(this.branchRules(), base);
		if (rule.requireReview) {
			const database = databaseOf(this.env);
			const pull = await getPull(database, this.meta().name, number);
			if (!pull || pull.decision !== "approved" || !(await approvedAt(database, pull, head))) {
				throw new HttpError(403, "REVIEW_REQUIRED", `${base} needs an approving review of the latest commit before pull requests merge into it`);
			}
		}
		if (rule.requireChecks) {
			const checks = await this.ci.pullChecks({ number, base, headRepo, sha: head });
			if (checks.reason) throw new HttpError(403, "CHECKS_REQUIRED", `${base} requires Actions to pass. ${checks.reason}`);
		}
	}

	/** Records a pull request event for the feed and webhooks. */
	async recordPullEvent(type: "pull.opened" | "pull.reviewed" | "pull.merged", data: Record<string, unknown>, headRepo: string | null | undefined): Promise<void> {
		this.meta();
		await this.emitForkEvent(type, data, headRepo);
	}

	/** A commit and its diff against its first parent. `ref` picks the repo, as in readFile. */
	async commit(hash: string, ref?: string): Promise<{ commit: CommitDetail; diff: Diff }> {
		const { repoName } = this.resolveRef(ref ?? this.meta().defaultBranch);
		using repo = await this.store.get(repoName);
		const commit = await resolveCommit(repo, hash);
		const parent = commit.parents[0] ? await resolveCommit(repo, commit.parents[0]) : null;
		const diff = await diffTrees(repo, parent?.treeHash ?? null, commit.treeHash);
		return {
			commit: {
				hash: commit.hash,
				treeHash: commit.treeHash,
				message: commit.message,
				author: commit.author,
				committer: commit.committer,
				parents: commit.parents,
				authoredAt: commit.authoredAt,
				committedAt: commit.committedAt,
			},
			diff,
		};
	}

	/**
	 * What `head` adds to `base` (`base...head`): `base` is a branch or commit of the project repo,
	 * `head` anything readFile accepts, including `task:<id>`.
	 */
	async compare(base: string, head: string): Promise<Comparison> {
		const meta = this.meta();
		const target = this.resolveRef(head);
		using project = await this.store.get(meta.name);
		using fork = target.repoName === meta.name ? null : await this.store.get(target.repoName);
		const repo = fork ?? project;
		const mainline = await project.log({ ref: base, limit: MAINLINE_DEPTH });
		if (mainline.length === 0) throw new HttpError(404, "NOT_FOUND", `${base} does not exist or has no commits`);
		const tip = await resolveCommit(repo, target.ref);
		const walk = await walkToMainline(repo, tip.hash, mainline.map((c) => c.hash));
		// Without a merge base in reach, fall back to comparing the two tips directly.
		const from = mainline.find((c) => c.hash === walk.mergeBase) ?? mainline[0];
		return {
			base: mainline[0].hash,
			head: tip.hash,
			mergeBase: walk.mergeBase,
			commits: walk.commits,
			capped: walk.capped,
			diff: await diffTrees(repo, from.treeHash, tip.treeHash),
		};
	}

	/** What a task changed: its fork against the default branch, or what it merged. */
	async taskChanges(id: string): Promise<Comparison> {
		const row = this.row(id);
		if (!row.merged_oid) return this.compare(this.meta().defaultBranch, `task:${id}`);
		using repo = await this.store.get(this.meta().name);
		const merge = await resolveCommit(repo, row.merged_oid);
		// A merge commit's first parent is the default branch it landed on; a fast-forward has none.
		if (merge.parents.length > 1) return this.compare(merge.parents[0], merge.parents[1]);
		return this.compare(row.base_oid ?? merge.parents[0] ?? merge.hash, merge.hash);
	}

	/** Branches of the project repo, and each active task's fork, with ahead/behind counts unless `counts` is false. */
	async branches(counts = true): Promise<Branches> {
		const meta = this.meta();
		const refs = await listBranches(await this.baseAccess(meta));
		using project = await this.store.get(meta.name);
		const mainline = await project.log({ ref: meta.defaultBranch, limit: MAINLINE_DEPTH });
		const hashes = mainline.map((c) => c.hash);
		const known = new Map(mainline.map((c) => [c.hash, c]));

		const summarize = async (repo: ObjectReader, head: string) => {
			if (!counts) return { head, commit: null, ahead: null, behind: null, capped: false };
			const walk = await walkToMainline(repo, head, hashes, 300);
			const top = walk.commits.find((c) => c.hash === head) ?? known.get(head) ?? (await repo.readCommit(head));
			return {
				head,
				commit: top ? { message: top.message, author: top.author, committedAt: top.committedAt } : null,
				ahead: walk.commits.length,
				behind: walk.behind,
				capped: walk.capped,
			};
		};

		const branches = await mapLimit([...refs], 4, async ([name, head]) => ({
			name,
			default: name === meta.defaultBranch,
			...(await summarize(project, head)),
		}));
		branches.sort((a, b) => Number(b.default) - Number(a.default) || (b.commit?.committedAt ?? 0) - (a.commit?.committedAt ?? 0));

		const active = this.sql
			.exec<TaskRow>("SELECT * FROM tasks WHERE status IN ('open', 'queued', 'merging', 'conflict', 'failed') ORDER BY created_at DESC")
			.toArray()
			.filter((r) => r.remote);
		const agents = (
			await mapLimit(active, 4, async (row) => {
				try {
					using fork = await this.store.get(row.repo);
					const [tip] = await fork.log({ ref: meta.defaultBranch, limit: 1 });
					if (!tip) return null;
					return {
						name: `task:${row.id}`,
						taskId: row.id,
						title: row.title,
						agent: row.agent,
						status: row.status,
						...(await summarize(fork, tip.hash)),
					};
				} catch {
					return null; // the fork is being deleted or is briefly unavailable
				}
			})
		).filter((a) => a !== null);

		return { defaultBranch: meta.defaultBranch, branches, agents };
	}

	/** Makes `name`, an existing branch, the default: what the code page shows, pull requests target and agents merge into. */
	async setDefaultBranch(name: string): Promise<string> {
		if (name === this.meta().defaultBranch) return name;
		this.assertWritable();
		if (name.startsWith("maggot-incoming/")) throw new HttpError(400, "INVALID_INPUT", `${name} is an internal branch`);
		// Waits for merges in progress, so none lands on the old default after the switch.
		return this.mergeSlot.run(async () => {
			// Another switch may have got here first.
			if (name === this.meta().defaultBranch) return name;
			const exists = (await listBranches(await this.baseAccess(this.meta()))).has(name);
			if (!exists) throw new HttpError(404, "NOT_FOUND", `Branch ${name} not found`);
			// From here to the write, nothing awaits: a task can't start in between (createTask records its
			// row in the same uninterrupted step that reads the default), and branches are deleted in this slot.
			const meta = this.meta();
			this.assertWritable();
			if (name === meta.defaultBranch) return name;
			const active = this.sql
				.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`, ...ACTIVE_STATUSES)
				.one().n;
			// Their forks and merges are based on the old default.
			if (active > 0) throw new HttpError(409, "TASKS_ACTIVE", `Finish or abandon the ${active} active agent task${active === 1 ? "" : "s"} before changing the default branch`);
			const storeBranch = meta.storeBranch ?? meta.defaultBranch;
			const next: Meta = { ...meta, defaultBranch: name, storeBranch: storeBranch === name ? undefined : storeBranch };
			this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)", JSON.stringify(next));
			this.workspace = undefined;
			const repository = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'repository'").toArray()[0];
			if (repository) this.sql.exec("UPDATE meta SET value = ? WHERE key = 'repository'", JSON.stringify({ ...JSON.parse(repository.value), defaultBranch: name }));
			// Everything that shows the default branch (code, history, search, branches) refreshes for every viewer.
			this.emit("repo.default_branch", null, { from: meta.defaultBranch, to: name });
			// Code search covers the default branch, so it's reindexed from the new one.
			await this.requestIndex();
			return name;
		});
	}

	/** The default branch, as the coordinator knows it: D1's copy follows this one. */
	async defaultBranch(): Promise<string> {
		return this.meta().defaultBranch;
	}

	async deleteBranch(name: string): Promise<void> {
		// In the slot setDefaultBranch switches in, so the branch can't become the default while it's deleted.
		await this.mergeSlot.run(async () => {
			const meta = this.meta();
			this.assertWritable();
			if (name === meta.defaultBranch) throw new HttpError(400, "DEFAULT_BRANCH", "The default branch can't be deleted");
			const rule = protectionFor(this.branchRules(), name);
			if (rule.blockDeletions || rule.requireMergeQueue || rule.requireReview || rule.requireChecks) throw new HttpError(403, "PROTECTED_BRANCH", `${name} is a protected branch, so it can't be deleted`);
			const access = await this.baseAccess(meta);
			const head = (await listBranches(access)).get(name);
			if (!head) throw new HttpError(404, "NOT_FOUND", `Branch ${name} not found`);
			await deleteBranch(access, name, head);
		});
		// Like a push: the event feed and webhooks hear that the branch is gone.
		await this.pushed();
	}

	/**
	 * Commits file changes made in the browser to `branch` (or to a new branch `newBranch` started from
	 * it). `baseCommit` is the commit the editor loaded; if the branch has moved since, nothing is
	 * written and the caller is told to reload.
	 */
	async commitFiles(input: CommitFilesInput): Promise<{ commit: string; branch: string; packBytes: number }> {
		const meta = this.meta();
		this.assertWritable();
		const access = await this.baseAccess(meta);
		const refs = await listBranches(access);
		const head = refs.get(input.branch) ?? null;
		if (!head && (refs.size > 0 || input.branch !== meta.defaultBranch)) throw new HttpError(404, "NOT_FOUND", `Branch ${input.branch} not found`);
		if (input.baseCommit !== undefined && input.baseCommit !== head) {
			throw new HttpError(409, "BRANCH_MOVED", `${input.branch} has new commits since you started editing; reload to see them`);
		}
		const target = input.newBranch ?? input.branch;
		const rule = protectionFor(this.branchRules(), target);
		if (rule.requireReview) {
			throw new HttpError(403, "PROTECTED_BRANCH", `${target} is a protected branch: changes to it go through reviewed pull requests. Commit to a new branch instead.`);
		}
		if (rule.requireMergeQueue) {
			throw new HttpError(403, "PROTECTED_BRANCH", `${target} is a protected branch: changes to it go through the merge queue. Commit to a new branch instead.`);
		}
		if (rule.requireChecks) {
			throw new HttpError(403, "PROTECTED_BRANCH", `${target} is a protected branch: changes to it go through pull requests whose Actions pass. Commit to a new branch instead.`);
		}
		if (input.newBranch !== undefined) {
			if (!validBranchName(input.newBranch)) throw new HttpError(400, "INVALID_INPUT", `${input.newBranch} isn't a valid branch name`);
			if (refs.has(input.newBranch)) throw new HttpError(409, "ALREADY_EXISTS", `Branch ${input.newBranch} already exists`);
		}
		using repo = await this.store.get(meta.name);
		const parent = head ? await resolveCommit(repo, head) : null;
		const changes = await Promise.all(
			input.changes.map(async ({ modeFrom, ...change }) => {
				if (!modeFrom || !parent) return change;
				const source = await entryAt(repo, parent.treeHash, modeFrom);
				return { ...change, executable: source?.type === "exec", create: true };
			}),
		);
		try {
			const result = await commitChanges(repo, access, {
				branch: target,
				parent: parent ? { hash: parent.hash, treeHash: parent.treeHash } : null,
				create: input.newBranch !== undefined || !head,
				maxPackBytes: input.maxPackBytes,
				changes,
				message: input.message,
				author: input.author,
				time: Math.floor(Date.now() / 1000),
			});
			await this.pushed(input.author.name);
			return { commit: result.commit, branch: target, packBytes: result.packBytes };
		} catch (err) {
			if (err instanceof PathError) throw new HttpError(400, "INVALID_PATH", err.message);
			if (err instanceof NoChanges) throw new HttpError(400, "NO_CHANGES", "Nothing changed, so there's nothing to commit");
			if (err instanceof TooLarge) throw new HttpError(413, "TOO_LARGE", `${err.message}; push it with git, or make room under the size limits`);
			if (err instanceof RefUpdateRejected) throw new HttpError(409, "BRANCH_MOVED", `${target} changed while committing; reload and try again`);
			throw err;
		}
	}

	/**
	 * Forks this repository, with every branch and tag, into a new Artifacts repo `name` for someone's
	 * fork. It goes through the same fork queue as agent tasks, since Artifacts fails concurrent forks
	 * of one repo. A failed attempt's name may be half-created, so it's queued for deletion and the
	 * caller starts over with a new name.
	 */
	async forkInto(name: string, description?: string): Promise<void> {
		const meta = this.meta();
		try {
			await this.forkSlots.run(() =>
				retrying(async () => {
					using source = await this.store.get(meta.name);
					await source.fork(name, { description, defaultBranchOnly: false });
				}),
			);
			await this.waitReady(name);
		} catch (err) {
			await this.queueCleanup(name);
			const e = toHttpError(err);
			throw new HttpError(e.status >= 500 || FORK_RETRYABLE.has(e.code) ? 503 : e.status, "FORK_FAILED", `Couldn't fork ${meta.name}; try again (${e.detail})`);
		}
	}

	/** Which repo and commit a ref names, for reads done outside the coordinator (raw files, archives). */
	async locate(ref?: string): Promise<{ repo: string; commit: string; treeHash: string; committedAt: number }> {
		const { repoName, ref: resolved } = await this.freshRef(ref ?? this.meta().defaultBranch);
		using repo = await this.store.get(repoName);
		const commit = await resolveCommit(repo, resolved);
		return { repo: repoName, commit: commit.hash, treeHash: commit.treeHash, committedAt: commit.committedAt };
	}

	// ── Tasks ────────────────────────────────────────────────────────────────

	/**
	 * Records the task, then forks through the project's fork queue. Waits up to FORK_WAIT_MS for the
	 * fork: if it is ready by then the response carries credentials, otherwise the task comes back
	 * still `provisioning` and a `task.ready` event follows.
	 */
	async createTask(input: CreateTaskInput, waitMs = FORK_WAIT_MS): Promise<TaskAccess> {
		let meta = this.meta();
		this.assertWritable();
		const title = input.title?.trim();
		if (!title) throw new HttpError(400, "INVALID_INPUT", "title is required");
		const paths = [...new Set((input.paths ?? []).map(normalizeClaim))];
		for (;;) {
			const branch = meta.defaultBranch;
			// Forks of an empty repo have nothing to merge against; the first commit has to land directly.
			this.hasCommits ||= await (async () => {
				using repo = await this.store.get(meta.name);
				return (await repo.log({ ref: branch, limit: 1 })).length > 0;
			})();
			if (!this.hasCommits) {
				throw new HttpError(409, "EMPTY_REPO", `Push a first commit to ${branch} before creating tasks`);
			}
			// The default branch may have changed while that was read. From this read to the insert below
			// nothing awaits, so setDefaultBranch either sees the new task as active (and refuses) or has
			// already switched: the task is based on the branch that's the default when its row appears.
			meta = this.meta();
			this.assertWritable();
			if (meta.defaultBranch === branch) break;
		}
		const id = newTaskId();
		const now = new Date().toISOString();
		this.sql.exec(
			`INSERT INTO tasks (id, title, agent, status, paths, repo, remote, created_at, updated_at)
			 VALUES (?, ?, ?, 'provisioning', ?, ?, '', ?, ?)`,
			id,
			title,
			input.agent ?? null,
			JSON.stringify(paths),
			forkRepoName(meta.name, id),
			now,
			now,
		);
		this.emit("task.created", id, { title, agent: input.agent ?? null, paths });
		// If this request dies before the fork is done, the alarm picks the task up again.
		await this.scheduleAlarm(Date.now() + RECOVERY_DELAY_MS);

		const forked = await Promise.race([this.provision(id), sleep(Math.min(Math.max(waitMs, 0), FORK_WAIT_MS)).then(() => null)]);
		const task = this.taskById(id);
		const overlaps = this.overlapping(task);
		if (task.status !== "open" || !task.remote) return { task, fork: null, base: null, overlaps };

		const base = await this.credentials(meta.name, meta.defaultBranch, "read", AGENT_TOKEN_TTL);
		// A fresh fork comes with a write token; reuse it instead of minting another.
		const fork: GitCredentials = forked
			? { remote: task.remote, branch: meta.defaultBranch, token: forked.token, expiresAt: tokenExpiry(forked.token) }
			: await this.credentials(task.repo, meta.defaultBranch, "write", AGENT_TOKEN_TTL);
		return { task, fork, base, overlaps };
	}

	async listTasks(status?: TaskStatus): Promise<Task[]> {
		const meta = this.meta();
		const rows = status
			? this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC", status)
			: this.sql.exec<TaskRow>("SELECT * FROM tasks ORDER BY created_at DESC");
		return rows.toArray().map((r) => toTask(meta.name, r));
	}

	async getTask(id: string): Promise<Task> {
		return this.taskById(id);
	}

	private taskById(id: string): Task {
		return toTask(this.meta().name, this.row(id));
	}

	/** Fresh credentials for an agent: write access to its fork, read access to the project. */
	async access(id: string): Promise<TaskAccess> {
		const meta = this.meta();
		this.assertWritable();
		const row = this.row(id);
		if (row.status === "merged" || row.status === "abandoned") {
			throw new HttpError(409, "TASK_CLOSED", `Task ${id} is ${row.status}`);
		}
		if (row.status === "provisioning") {
			const task = toTask(meta.name, row);
			return { task, fork: null, base: null, overlaps: this.overlapping(task) };
		}
		this.requireFork(row);
		const [fork, base] = await Promise.all([
			this.credentials(row.repo, meta.defaultBranch, "write", AGENT_TOKEN_TTL),
			this.credentials(meta.name, meta.defaultBranch, "read", AGENT_TOKEN_TTL),
		]);
		const task = toTask(meta.name, row);
		return { task, fork, base, overlaps: this.overlapping(task) };
	}

	async submit(id: string): Promise<Task> {
		const row = this.row(id);
		this.assertWritable();
		if (!["open", "conflict", "failed"].includes(row.status)) {
			throw new HttpError(409, "INVALID_STATE", `Task ${id} is ${row.status} and cannot be submitted`);
		}
		this.requireFork(row);
		const now = new Date().toISOString();
		this.sql.exec(
			"UPDATE tasks SET status = 'queued', submitted_at = ?, updated_at = ?, error = NULL, conflict = NULL WHERE id = ?",
			now,
			now,
			id,
		);
		this.sql.exec("INSERT OR IGNORE INTO queue (task_id, enqueued_at) VALUES (?, ?)", id, now);
		this.emit("task.submitted", id, { position: this.queuePosition(id) });
		await this.scheduleAlarm(Date.now());
		return this.getTask(id);
	}

	async abandon(id: string): Promise<Task> {
		const row = this.row(id);
		if (row.status === "merging") throw new HttpError(409, "INVALID_STATE", `Task ${id} is merging right now`);
		if (row.status === "merged" || row.status === "abandoned") return this.getTask(id);
		this.sql.exec("DELETE FROM queue WHERE task_id = ?", id);
		this.setStatus(id, "abandoned");
		if (row.status === "provisioning") {
			// A fork may be mid-creation; provisioning sees the new status and queues it for cleanup.
			await this.scheduleAlarm(Date.now() + RECOVERY_DELAY_MS);
		} else if (row.remote) {
			await this.store.delete(row.repo).catch(() => false);
		}
		this.emit("task.abandoned", id, {});
		return this.getTask(id);
	}

	async mergeQueue(): Promise<QueueEntry[]> {
		this.meta();
		return this.sql
			.exec<{ task_id: string; enqueued_at: string; title: string; agent: string | null; status: TaskStatus }>(
				`SELECT q.task_id, q.enqueued_at, t.title, t.agent, t.status
				 FROM queue q JOIN tasks t ON t.id = q.task_id ORDER BY q.seq`,
			)
			.toArray()
			.map((r, i) => ({ position: i + 1, taskId: r.task_id, title: r.title, agent: r.agent, status: r.status, enqueuedAt: r.enqueued_at }));
	}

	/** The newest `limit` events, oldest first. */
	async recentEvents(limit = 100, viewer: PullViewer = { viewerId: null }): Promise<ProjectEvent[]> {
		this.meta();
		const events = this.sql
			.exec<{ seq: number; ts: string; type: EventType; task_id: string | null; data: string }>(
				"SELECT * FROM events ORDER BY seq DESC LIMIT ?",
				Math.max(1, Math.min(limit, 1000)),
			)
			.toArray()
			.reverse()
			.map(toEvent);
		return this.readableEvents(events, viewer);
	}

	async events(after = 0, limit = 100, viewer: PullViewer = { viewerId: null }): Promise<ProjectEvent[]> {
		this.meta();
		const events = this.sql
			.exec<{ seq: number; ts: string; type: EventType; task_id: string | null; data: string }>(
				"SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
				after,
				Math.max(1, Math.min(limit, 1000)),
			)
			.toArray()
			.map(toEvent);
		return this.readableEvents(events, viewer);
	}

	// ── Live events ──────────────────────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
		this.meta();
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		// Replay anything the client missed, then stream live.
		const after = Number(new URL(request.url).searchParams.get("after") ?? "");
		if (Number.isFinite(after) && after > 0) {
			for (const event of await this.events(after, 1000)) server.send(JSON.stringify(event));
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Closes every live socket; clients reconnect, and their access is checked again. */
	async disconnectAll(reason: string): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(4001, reason);
			} catch {
				// Already closed.
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number) {
		// 1005/1006 are reserved and can't be sent back; reply with a normal closure instead.
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
		} catch {
			// Already closed.
		}
	}

	// ── Queues ───────────────────────────────────────────────────────────────

	/**
	 * Drains the merge queue (strictly one at a time) while also resuming any provisioning tasks
	 * whose request went away. Fork cleanup runs only when no merge is waiting.
	 */
	async alarm(): Promise<void> {
		// Each job fails on its own: one broken webhook or index update mustn't stall merges, or each other.
		const run = (name: string, job: () => Promise<void>) => job().catch((err) => console.error(`alarm: ${name} failed`, err));
		await Promise.all([
			run("merges", () => this.drainMerges()),
			run("provisioning", () => this.resumeProvisioning()),
			run("webhooks", () => this.deliverHooks()),
			run("actions", async () => {
				await this.drainCiPushes();
				await this.ci.tick();
			}),
		]);
		await run("indexing", () => this.indexIfWanted());
		const pending = this.sql.exec<{ n: number }>(
			"SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'provisioning') + (SELECT COUNT(*) FROM cleanup) AS n",
		).one().n;
		if (pending > 0) await this.scheduleAlarm(Date.now() + 5_000);
		const due = this.hooks.nextDue();
		if (due !== null) await this.scheduleAlarm(Math.max(due, Date.now() + 1_000));
		if (this.sql.exec("SELECT 1 FROM meta WHERE key = 'indexWanted'").toArray().length > 0) await this.scheduleAlarm(Date.now() + 1_000);
		if (this.sql.exec("SELECT 1 FROM ci_pushes LIMIT 1").toArray().length > 0) await this.scheduleAlarm(Date.now() + 5_000);
		if (this.metaOrNull() && this.ci.busy()) await this.scheduleAlarm(Date.now() + 30_000);
		const expiry = this.metaOrNull() ? this.ci.waitingExpiry() : null;
		if (expiry !== null) await this.scheduleAlarm(Math.max(expiry, Date.now() + 60_000));
		// Scheduled workflows: the next one due (the alarm also clears out old caches and artifacts then).
		const scheduled = this.metaOrNull() ? this.ci.nextSchedule() : null;
		if (scheduled !== null) await this.scheduleAlarm(Math.max(scheduled, Date.now() + 1_000));
	}

	private async drainMerges(): Promise<void> {
		while (true) {
			const next = this.sql.exec<{ task_id: string }>("SELECT task_id FROM queue ORDER BY seq LIMIT 1").toArray()[0];
			if (next) {
				await this.mergeTask(next.task_id);
				this.sql.exec("DELETE FROM queue WHERE task_id = ?", next.task_id);
				continue;
			}
			// Fork deletion takes seconds, so it only runs once no merge is waiting.
			const stale = this.sql.exec<{ repo: string }>("SELECT repo FROM cleanup LIMIT 1").toArray()[0];
			if (!stale) return;
			await this.store.delete(stale.repo).catch(() => false);
			this.sql.exec("DELETE FROM cleanup WHERE repo = ?", stale.repo);
		}
	}

	private async resumeProvisioning(): Promise<void> {
		const ids = this.sql
			.exec<{ id: string }>("SELECT id FROM tasks WHERE status = 'provisioning' ORDER BY created_at")
			.toArray()
			.map((r) => r.id);
		await Promise.all(ids.map((id) => this.provision(id)));
	}

	/** Queues a task's fork behind the project's fork throttle; joins an attempt already in flight. */
	private provision(id: string): Promise<ArtifactsCreateRepoResult | null> {
		let pending = this.provisioning.get(id);
		if (!pending) {
			pending = this.forkSlots.run(() => this.forkTask(id)).finally(() => this.provisioning.delete(id));
			this.provisioning.set(id, pending);
		}
		return pending;
	}

	/**
	 * Forks the project for a task. Each attempt gets a new repo name, persisted before the fork
	 * starts: a failed Artifacts fork can leave its name half-created (create says ALREADY_EXISTS,
	 * get says NOT_FOUND), and a coordinator restart must not reuse a name an attempt may own.
	 * Superseded names go to the cleanup queue.
	 */
	private async forkTask(id: string): Promise<ArtifactsCreateRepoResult | null> {
		const meta = this.meta();
		let lastError = "";
		while (true) {
			const row = this.row(id);
			if (row.status !== "provisioning") {
				// Abandoned between attempts: the last attempt's name may be half-created.
				if (row.fork_attempts > 0 && !row.remote) await this.queueCleanup(row.repo);
				return null;
			}
			const attempt = row.fork_attempts + 1;
			if (row.fork_attempts > 0) await this.queueCleanup(row.repo);
			if (attempt > FORK_MAX_ATTEMPTS) {
				this.fail(id, "FORK_FAILED", `Could not create the task fork after ${FORK_MAX_ATTEMPTS} attempts: ${lastError}`);
				return null;
			}
			const repoName = forkRepoName(meta.name, id, attempt);
			this.sql.exec("UPDATE tasks SET fork_attempts = ?, repo = ?, updated_at = ? WHERE id = ?", attempt, repoName, new Date().toISOString(), id);

			try {
				const forked = await step("fork", async () => {
					using base = await this.store.get(meta.name);
					// Only the storage's HEAD branch comes along with defaultBranchOnly, so after a default change take them all.
					return base.fork(repoName, { description: `${meta.name}: ${row.title}`, defaultBranchOnly: !meta.storeBranch || meta.storeBranch === meta.defaultBranch });
				});
				await step("wait for fork", () => this.waitReady(repoName));
				const baseOid = await step("read fork head", async () => {
					using fork = await this.store.get(repoName);
					return (await fork.log({ ref: meta.defaultBranch, limit: 1 }))[0]?.hash ?? null;
				});
				if (this.row(id).status !== "provisioning") {
					// Abandoned while forking.
					await this.queueCleanup(repoName);
					return null;
				}
				this.sql.exec(
					"UPDATE tasks SET status = 'open', remote = ?, base_oid = ?, updated_at = ? WHERE id = ?",
					forked.remote,
					baseOid,
					new Date().toISOString(),
					id,
				);
				this.emit("task.ready", id, { repo: repoName, remote: forked.remote, baseOid, forkAttempts: attempt });
				return forked;
			} catch (err) {
				const e = toHttpError(err);
				lastError = `${e.code}: ${e.detail}`;
				if (!FORK_RETRYABLE.has(e.code)) {
					this.fail(id, "FORK_FAILED", `Could not create the task fork: ${lastError}`);
					return null;
				}
				await sleep(FORK_RETRY_DELAYS[Math.min(attempt - 1, FORK_RETRY_DELAYS.length - 1)]);
			}
		}
	}

	/** Deletes a repo in the background, after any waiting merges. */
	private async queueCleanup(repo: string): Promise<void> {
		this.sql.exec("INSERT OR IGNORE INTO cleanup (repo) VALUES (?)", repo);
		await this.scheduleAlarm(Date.now() + 1_000);
	}

	/** Moves the alarm earlier if needed; never postpones one that is already due sooner. */
	private async scheduleAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	/** Why the queue may not merge into `branch` under its rules now, or null. */
	private queueBlocked(branch: string): { code: string; message: string } | null {
		const rule = protectionFor(this.branchRules(), branch);
		// A branch that wants a review takes changes only through pull requests, which the queue isn't.
		if (rule.requireReview) {
			return { code: "REVIEW_REQUIRED", message: `${branch} requires an approving review, so changes reach it only through pull requests. Push the task's work to a branch and open one.` };
		}
		// The queue merges a fork's work without Actions having run on it, so a branch that wants them passed takes pull requests only.
		if (rule.requireChecks) {
			return { code: "CHECKS_REQUIRED", message: `${branch} requires Actions to pass, so changes reach it only through pull requests. Push the task's work to a branch and open one.` };
		}
		return null;
	}

	private mergeTask(id: string): Promise<void> {
		return this.mergeSlot.run(() => this.mergeTaskNow(id));
	}

	private async mergeTaskNow(id: string): Promise<void> {
		const meta = this.meta();
		const row = this.row(id);
		// "merging" here means a previous alarm died mid-merge; the merge is idempotent, so redo it.
		if (row.status !== "queued" && row.status !== "merging") return;
		const blocked = this.queueBlocked(meta.defaultBranch);
		if (blocked) return this.fail(id, blocked.code, blocked.message);
		this.setStatus(id, "merging");
		this.emit("task.merging", id, {});

		try {
			const base = await this.baseAccess(meta);
			const fork = await this.credentials(row.repo, meta.defaultBranch, "read", INTERNAL_TOKEN_TTL);
			if (!this.workspace || this.workspace.branch !== meta.defaultBranch || this.workspaceMerges >= WORKSPACE_MAX_MERGES) {
				this.workspace = new Workspace(meta.defaultBranch, MERGE_IDENTITY);
				this.workspaceMerges = 0;
			}
			const ws = this.workspace;
			this.workspaceMerges++;

			for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
				const baseHead = await ws.syncBase(base);
				const head = await ws.fetchTask({ url: fork.remote, token: fork.token }, meta.defaultBranch);
				this.sql.exec("UPDATE tasks SET head_oid = ? WHERE id = ?", head, id);

				if (head === row.base_oid) {
					return this.fail(id, "NO_CHANGES", "The task fork has no new commits. Push your work before submitting.");
				}

				const author = { name: row.agent ?? "agent", email: `${row.agent ?? "agent"}@agents.maggot.dev` };
				const outcome = await ws.merge(head, `Merge task ${id}: ${row.title}`, author);

				if (outcome.kind === "conflict") {
					const conflict: ConflictInfo = {
						files: outcome.files,
						withTasks: this.tasksTouching(outcome.files, row.created_at, id),
					};
					this.sql.exec(
						"UPDATE tasks SET status = 'conflict', conflict = ?, changed_files = ?, updated_at = ? WHERE id = ?",
						JSON.stringify(conflict),
						JSON.stringify(outcome.changedFiles),
						new Date().toISOString(),
						id,
					);
					this.emit("task.conflict", id, { ...conflict, baseHead });
					return;
				}

				if (outcome.kind === "up-to-date") {
					this.markMerged(id, outcome.oid, []);
					return;
				}

				// The rules as they are now, after the fetches and the merge (changes to them wait for this slot).
				const blocked = this.queueBlocked(meta.defaultBranch);
				if (blocked) return this.fail(id, blocked.code, blocked.message);
				if (await ws.push(base)) {
					this.markMerged(id, outcome.oid, outcome.changedFiles);
					// The next push's "from" is this merge, not whatever was pushed before it.
					this.recordRef(meta, meta.defaultBranch, outcome.oid);
					await this.requestIndex();
					this.emit("main.advanced", id, {
						from: baseHead,
						to: outcome.oid,
						fastForward: outcome.fastForward,
						changedFiles: outcome.changedFiles,
					});
					this.closeReferencedIssues(baseHead, outcome.oid);
					await this.startCi([{ branch: meta.defaultBranch, from: baseHead, to: outcome.oid }], row.agent);
					this.sql.exec("INSERT OR IGNORE INTO cleanup (repo) VALUES (?)", row.repo);
					return;
				}
				// Someone else pushed to the default branch directly; resync and retry.
			}
			this.fail(id, "PUSH_REJECTED", `Default branch kept moving; gave up after ${MAX_PUSH_ATTEMPTS} attempts`);
		} catch (err) {
			this.workspace = undefined;
			this.fail(id, errorCode(err) ?? "MERGE_FAILED", err instanceof Error ? err.message : String(err));
		}
	}

	private markMerged(id: string, oid: string, changedFiles: string[]) {
		const now = new Date().toISOString();
		this.sql.exec(
			"UPDATE tasks SET status = 'merged', merged_oid = ?, changed_files = ?, merged_at = ?, updated_at = ? WHERE id = ?",
			oid,
			JSON.stringify(changedFiles),
			now,
			now,
			id,
		);
		this.emit("task.merged", id, { oid, changedFiles });
	}

	private fail(id: string, code: string, message: string) {
		this.sql.exec("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", message, new Date().toISOString(), id);
		this.emit("task.failed", id, { code, message });
	}

	// ── Tags and releases ────────────────────────────────────────────────────

	/** Every tag with its commit's first line, newest commit first (up to 300). */
	/**
	 * Tags, newest commit first (up to 300, highest version names first if there are more). Commit
	 * summaries are cached by hash, since a commit never changes; `summaries: false` skips them.
	 */
	async tags(summaries = true): Promise<Tag[]> {
		const meta = this.meta();
		const { tags } = await listRefs(await this.baseAccess(meta));
		this.observeTags(tagCommits(tags));
		const names = [...tags.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 300);
		const cached = new Map(
			this.sql
				.exec<{ hash: string; summary: string }>(`SELECT hash, summary FROM commit_summaries WHERE hash IN (${names.map(() => "?").join(",") || "''"})`, ...names.map((n) => tags.get(n)?.commit))
				.toArray()
				.map((r) => [r.hash, JSON.parse(r.summary) as Tag["summary"]]),
		);
		const missing = summaries ? [...new Set(names.map((n) => (tags.get(n) as TagRef).commit).filter((h) => !cached.has(h)))] : [];
		if (missing.length > 0) {
			using repo = await this.store.get(meta.name);
			await mapLimit(missing, 8, async (hash) => {
				const commit = await repo.readCommit(hash).catch(() => null);
				if (!commit) return;
				const summary = { message: commit.message.split("\n")[0], author: commit.author, committedAt: commit.committedAt };
				cached.set(hash, summary);
				this.sql.exec("INSERT OR REPLACE INTO commit_summaries (hash, summary) VALUES (?, ?)", hash, JSON.stringify(summary));
			});
		}
		const listed = names.map((name) => {
			const t = tags.get(name) as TagRef;
			return { name, commit: t.commit, annotated: t.annotated, summary: cached.get(t.commit) ?? null };
		});
		return listed.sort(
			(a, b) => (b.summary?.committedAt ?? 0) - (a.summary?.committedAt ?? 0) || b.name.localeCompare(a.name, undefined, { numeric: true }),
		);
	}

	/** Creates a lightweight tag at `target` (a branch, tag or commit; the default branch if absent). */
	async createTag(name: string, target?: string): Promise<Tag> {
		const meta = this.meta();
		this.assertWritable();
		if (!validBranchName(name)) throw new HttpError(400, "INVALID_INPUT", `${name} isn't a valid tag name`);
		const access = await this.baseAccess(meta);
		const { tags } = await listRefs(access);
		if (tags.has(name)) throw new HttpError(409, "ALREADY_EXISTS", `Tag ${name} already exists`);
		using repo = await this.store.get(meta.name);
		const { ref } = this.resolveRef(target?.trim() || meta.defaultBranch);
		const commit = await resolveCommit(repo, ref);
		try {
			await setRef(access, `refs/tags/${name}`, null, commit.hash);
		} catch (err) {
			if (err instanceof RefUpdateRejected) throw new HttpError(409, "ALREADY_EXISTS", `Tag ${name} already exists`);
			throw err;
		}
		this.recordTags({ ...tagCommits(tags), [name]: commit.hash });
		return { name, commit: commit.hash, annotated: false, summary: { message: commit.message.split("\n")[0], author: commit.author, committedAt: commit.committedAt } };
	}

	async deleteTag(name: string): Promise<void> {
		const meta = this.meta();
		this.assertWritable();
		const access = await this.baseAccess(meta);
		const tag = (await listRefs(access)).tags.get(name);
		if (!tag) throw new HttpError(404, "NOT_FOUND", `Tag ${name} not found`);
		await setRef(access, `refs/tags/${name}`, tag.oid, null);
		const { tags: all } = await listRefs(access);
		this.recordTags(tagCommits(all));
	}

	async releases(limit = 20): Promise<{ releases: Release[]; more: boolean }> {
		const meta = this.meta();
		// Fresh, so a release shows its tag's current commit (and tags pushed before maggot tracked them).
		const tags = tagCommits((await listRefs(await this.baseAccess(meta))).tags);
		this.observeTags(tags);
		const rows = this.sql.exec<ReleaseRow>("SELECT * FROM releases ORDER BY created_at DESC LIMIT ?", limit + 1).toArray();
		return { releases: rows.slice(0, limit).map((r) => toRelease(r, tags[r.tag] ?? null)), more: rows.length > limit };
	}

	/** Publishes a release of `tag`, creating the tag at `target` first if it doesn't exist. */
	async createRelease(input: { tag: string; target?: string; name?: string; notes?: string; prerelease?: boolean; author: string | null }): Promise<Release> {
		const meta = this.meta();
		this.assertWritable();
		const tag = input.tag.trim();
		if (this.sql.exec("SELECT 1 FROM releases WHERE tag = ?", tag).toArray().length > 0) {
			throw new HttpError(409, "ALREADY_EXISTS", `There's already a release for ${tag}`);
		}
		if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM releases").one().n >= MAX_RELEASES) {
			throw new HttpError(403, "QUOTA_EXCEEDED", `A repository can have at most ${MAX_RELEASES} releases; delete old ones first`);
		}
		const existing = (await listRefs(await this.baseAccess(meta))).tags.get(tag);
		const commit = existing ? existing.commit : (await this.createTag(tag, input.target)).commit;
		const now = new Date().toISOString();
		const row: ReleaseRow = {
			id: crypto.randomUUID(),
			tag,
			name: input.name?.trim().slice(0, 200) || tag,
			notes: (input.notes ?? "").slice(0, 100_000),
			prerelease: input.prerelease ? 1 : 0,
			author: input.author,
			created_at: now,
			updated_at: now,
		};
		this.sql.exec(
			"INSERT INTO releases (id, tag, name, notes, prerelease, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			row.id, row.tag, row.name, row.notes, row.prerelease, row.author, row.created_at, row.updated_at,
		);
		const release = toRelease(row, commit);
		this.emit("release.published", null, { id: release.id, tag, name: release.name, prerelease: release.prerelease, commit, author: input.author });
		return release;
	}

	async updateRelease(id: string, patch: { name?: string; notes?: string; prerelease?: boolean }): Promise<Release> {
		this.meta();
		this.assertWritable();
		const row = this.sql.exec<ReleaseRow>("SELECT * FROM releases WHERE id = ?", id).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such release");
		const next = {
			name: patch.name === undefined ? row.name : patch.name.trim().slice(0, 200) || row.tag,
			notes: patch.notes === undefined ? row.notes : patch.notes.slice(0, 100_000),
			prerelease: patch.prerelease === undefined ? row.prerelease : patch.prerelease ? 1 : 0,
		};
		const now = new Date().toISOString();
		this.sql.exec("UPDATE releases SET name = ?, notes = ?, prerelease = ?, updated_at = ? WHERE id = ?", next.name, next.notes, next.prerelease, now, id);
		this.emit("release.edited", null, { id, tag: row.tag, name: next.name, prerelease: next.prerelease });
		return toRelease({ ...row, ...next, updated_at: now }, this.knownTags()[row.tag] ?? null);
	}

	/** Deletes a release; the tag stays unless `deleteTag`. */
	async deleteRelease(id: string, deleteTag = false): Promise<void> {
		this.meta();
		this.assertWritable();
		const row = this.sql.exec<ReleaseRow>("SELECT * FROM releases WHERE id = ?", id).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such release");
		if (deleteTag) {
			await this.deleteTag(row.tag).catch((err) => {
				// Already gone is fine.
				if (toHttpError(err).status !== 404) throw err;
			});
		}
		this.sql.exec("DELETE FROM releases WHERE id = ?", id);
		this.emit("release.deleted", null, { id, tag: row.tag, name: row.name });
	}

	// ── Commit graph ─────────────────────────────────────────────────────────

	/**
	 * Recent commits across every branch, newest first, for drawing the graph. Each branch's
	 * first-parent history comes from one log request; merged-in history whose branch is gone is
	 * filled in from the merges' other parents, a few rounds deep.
	 */
	async graph(limit = 150): Promise<Graph> {
		const meta = this.meta();
		const max = Math.max(10, Math.min(limit, 400));
		const access = await this.baseAccess(meta);
		const { branches, tags } = await listRefs(access);
		// The graph depends only on where the refs point, so it's computed once per set of heads.
		const key = JSON.stringify([max, [...branches].sort(), [...tags].map(([n, t]) => [n, t.commit]).sort()]);
		const cached = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM graph_cache WHERE key = 'graph'").toArray()[0];
		if (cached && JSON.parse(cached.value).key === key) return JSON.parse(cached.value).graph as Graph;
		using repo = await this.store.get(meta.name);
		const commits = new Map<string, Commit>();
		const add = (list: ArtifactsCommitMetadata[]) => {
			for (const c of list) {
				if (!commits.has(c.hash)) commits.set(c.hash, { hash: c.hash, message: c.message, author: c.author, parents: c.parents, committedAt: c.committedAt });
			}
		};
		// The default branch in full, then up to 29 others by name, each only as deep as it's likely to
		// differ from what's already listed.
		const heads = [...branches].sort(([a], [b]) => Number(b === meta.defaultBranch) - Number(a === meta.defaultBranch) || a.localeCompare(b)).slice(0, 30);
		for (const list of await mapLimit(heads, 4, ([name, head]) => repo.log({ ref: head, limit: name === meta.defaultBranch ? max : Math.min(max, 100) }).catch(() => []))) add(list);
		// Second parents of merges whose history isn't listed yet: follow them for a few rounds.
		for (let round = 0; round < 3; round++) {
			const newest = [...commits.values()].sort((a, b) => b.committedAt - a.committedAt).slice(0, max);
			const cutoff = newest.at(-1)?.committedAt ?? 0;
			const missing = [...new Set(newest.flatMap((c) => c.parents.slice(1)).filter((p) => !commits.has(p)))].slice(0, 10);
			if (missing.length === 0) break;
			for (const list of await mapLimit(missing, 4, (hash) => repo.log({ ref: hash, limit: 50 }).catch(() => []))) {
				add(list.filter((c) => c.committedAt >= cutoff));
			}
		}
		const sorted = topoOrder([...commits.values()]);
		const labels = new Map<string, { branches: string[]; tags: string[] }>();
		const label = (hash: string) => labels.get(hash) ?? labels.set(hash, { branches: [], tags: [] }).get(hash)!;
		for (const [name, head] of branches) label(head).branches.push(name);
		for (const [name, t] of tags) label(t.commit).tags.push(name);
		const shown: GraphCommit[] = sorted.slice(0, max).map((c) => ({ ...c, branches: labels.get(c.hash)?.branches ?? [], tags: labels.get(c.hash)?.tags ?? [] }));
		// Older history exists unless every listed commit was found and a root commit is among them.
		const graph: Graph = { commits: shown, truncated: sorted.length > max || !shown.some((c) => c.parents.length === 0) };
		this.sql.exec("INSERT OR REPLACE INTO graph_cache (key, value) VALUES ('graph', ?)", JSON.stringify({ key, graph }));
		return graph;
	}

	// ── Branch protection ────────────────────────────────────────────────────

	branchRules(): BranchRule[] {
		return this.sql
			.exec<{ pattern: string; block_deletions: number; block_force_pushes: number; require_merge_queue: number; require_review: number; require_checks: number; created_at: string }>(
				"SELECT * FROM branch_rules ORDER BY created_at",
			)
			.toArray()
			.map((r) => ({
				pattern: r.pattern,
				blockDeletions: Boolean(r.block_deletions),
				blockForcePushes: Boolean(r.block_force_pushes),
				requireMergeQueue: Boolean(r.require_merge_queue),
				requireReview: Boolean(r.require_review),
				requireChecks: Boolean(r.require_checks),
				createdAt: r.created_at,
			}));
	}

	/** The rules, for showing on the branches page and in settings. */
	async getBranchRules(): Promise<BranchRule[]> {
		this.meta();
		return this.branchRules();
	}

	/**
	 * Adds or replaces a rule. Rule changes take the merge slot, so a merge between checking the rules
	 * and pushing never sees them change: one that started under the old rules finishes first.
	 */
	async setBranchRule(rule: Omit<BranchRule, "createdAt">): Promise<BranchRule[]> {
		this.meta();
		if (!validPattern(rule.pattern)) throw new HttpError(400, "INVALID_INPUT", "A pattern is a branch name, optionally with * (within a segment) or ** (across them)");
		if (!rule.blockDeletions && !rule.blockForcePushes && !rule.requireMergeQueue && !rule.requireReview && !rule.requireChecks) {
			throw new HttpError(400, "INVALID_INPUT", "Choose at least one protection");
		}
		return this.mergeSlot.run(async () => this.writeBranchRule(rule));
	}

	private writeBranchRule(rule: Omit<BranchRule, "createdAt">): BranchRule[] {
		const existing = this.sql.exec<{ created_at: string }>("SELECT created_at FROM branch_rules WHERE pattern = ?", rule.pattern).toArray()[0];
		if (!existing && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM branch_rules").one().n >= 50) {
			throw new HttpError(403, "QUOTA_EXCEEDED", "A repository can have at most 50 branch rules");
		}
		this.sql.exec(
			"INSERT OR REPLACE INTO branch_rules (pattern, block_deletions, block_force_pushes, require_merge_queue, require_review, require_checks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			rule.pattern,
			rule.blockDeletions ? 1 : 0,
			rule.blockForcePushes ? 1 : 0,
			rule.requireMergeQueue ? 1 : 0,
			rule.requireReview ? 1 : 0,
			rule.requireChecks ? 1 : 0,
			existing?.created_at ?? new Date().toISOString(),
		);
		return this.branchRules();
	}

	/** Removes a rule; through the merge slot, as setBranchRule. */
	async deleteBranchRule(pattern: string): Promise<BranchRule[]> {
		this.meta();
		return this.mergeSlot.run(async () => {
			this.sql.exec("DELETE FROM branch_rules WHERE pattern = ?", pattern);
			return this.branchRules();
		});
	}

	/**
	 * Closes the issues that commits newly on the default branch say they fix ("fixes #12", "closes #3",
	 * "resolves #7"), in the background. Looks at up to 100 new commits.
	 */
	private closeReferencedIssues(from: string | null, to: string) {
		const meta = this.meta();
		this.ctx.waitUntil(
			(async () => {
				using repo = await this.store.get(meta.name);
				const commits = await repo.log({ ref: to, limit: 100 });
				const fixes = new Map<number, string>();
				let reachedFrom = from === null;
				for (const commit of commits) {
					if (commit.hash === from) {
						reachedFrom = true;
						break;
					}
					for (const m of commit.message.matchAll(FIXES)) if (!fixes.has(Number(m[1]))) fixes.set(Number(m[1]), commit.hash);
				}
				// History was rewritten (or is very long): the old commits listed may have closed these
				// issues before, and someone may have reopened them since. Leave them alone.
				if (!reachedFrom) return;
				if (fixes.size === 0) return;
				const closed = await closeIssuesByCommits(this.env, meta.name, [...fixes].slice(0, 50));
				for (const issue of closed) {
					this.emit("issue.closed", null, {
						issue: { number: issue.number, title: issue.title, state: "closed", url: `${this.repository().url}/issues/${issue.number}` },
						sender: null,
						commit: issue.commit,
					});
					if (issue.authorId) {
						await notifyUser(databaseOf(this.env), {
							userId: issue.authorId,
							kind: "issue",
							repoId: meta.name,
							title: `#${issue.number} ${issue.title} was closed by commit ${issue.commit.slice(0, 7)}`,
							url: `/${issue.owner}/${issue.name}/issues/${issue.number}`,
							actor: null,
						});
					}
				}
			})().catch((err) => console.error("closing referenced issues failed", err)),
		);
	}

	// ── Events from the Worker ───────────────────────────────────────────────

	/** Records something that happened outside the coordinator (issues), for the feed and webhooks. */
	async recordEvent(type: Extract<EventType, `issue.${string}`>, data: Record<string, unknown>): Promise<void> {
		this.meta();
		this.emit(type, null, data);
	}

	// ── Actions (CI) ─────────────────────────────────────────────────────────

	/** Progress from a CiJob Durable Object; the answer tells it to stop if its run was cancelled. */
	async ciReport(jobId: string, report: SequencedReport): Promise<ReportAck> {
		if (!this.metaOrNull()) return { cancel: true };
		return this.ci.report(jobId, report);
	}

	/** A pull request was opened or reopened, or its head moved: record it and start its pull_request workflows (retried until they start). */
	async ciPull(input: PullTrigger): Promise<void> {
		this.meta();
		await this.ci.queuePull(input);
	}

	/**
	 * A pull request's checks on its head (the head of `branch` in `headRepo`, or `sha` when the caller
	 * pinned one), judged as a merge into `base` would be.
	 */
	async ciPullChecks(input: { number: number; base: string; headRepo: string | null; branch: string; sha?: string }): Promise<Omit<PullChecks, "canStart">> {
		const meta = this.meta();
		let sha = input.sha;
		if (!sha) {
			using repo = await this.store.get(input.headRepo ?? meta.name);
			sha = (await repo.log({ ref: input.branch, limit: 1 }))[0]?.hash;
			if (!sha) throw new HttpError(409, "HEAD_GONE", `${input.branch} no longer exists, so its checks can't be read`);
		}
		const required = protectionFor(this.branchRules(), input.base).requireChecks;
		return { ...(await this.ci.pullChecks({ number: input.number, base: input.base, headRepo: input.headRepo, sha })), required };
	}

	/** A pull request was closed or merged: stop what it no longer needs. */
	async ciClosePull(number: number, merged: boolean): Promise<void> {
		this.meta();
		await this.ci.closePull(number, merged);
	}

	/** Creates the runs a pull request's checks list as missing (someone who can merge asked); they still wait for approval where its other runs would. */
	async ciStartPull(input: Omit<PullTrigger, "action" | "approved" | "only">, missing: string[]): Promise<void> {
		this.meta();
		this.assertWritable();
		await this.ci.startPull(input, missing);
	}

	async ciRuns(filter: { workflow?: string; branch?: string; pull?: number; sha?: string; before?: number; limit?: number }): Promise<CiRunList> {
		this.meta();
		return this.ci.listRuns(filter);
	}

	async ciRun(number: number): Promise<CiRun> {
		this.meta();
		return this.ci.getRun(number);
	}

	/** The other repository (by id) each of these runs took its code from: a fork's, for its pull requests. */
	async ciRunHeads(numbers: number[]): Promise<Record<number, string>> {
		this.meta();
		return this.ci.runHeads(numbers);
	}

	async ciLogs(number: number, job: string, after?: number): Promise<{ logs: CiLogChunk[]; next: number | null }> {
		this.meta();
		return this.ci.logs(number, job, after);
	}

	async ciCancel(number: number): Promise<CiRun> {
		this.meta();
		return this.ci.cancel(number);
	}

	async ciRerun(number: number, actor: string | null): Promise<CiRun> {
		this.meta();
		this.assertWritable();
		return this.ci.rerun(number, actor);
	}

	async ciApprove(number: number): Promise<CiRun> {
		this.meta();
		this.assertWritable();
		return this.ci.approve(number);
	}

	/** Runs a workflow_dispatch workflow (as of the branch's head) on a branch. */
	async ciDispatch(path: string, branch: string, actor: string | null): Promise<CiRunSummary[]> {
		const meta = this.meta();
		this.assertWritable();
		const head = (await listBranches(await this.baseAccess(meta))).get(branch);
		if (!head) throw new HttpError(404, "NOT_FOUND", `Branch ${branch} not found`);
		return this.ci.dispatch(path, branch, head, actor);
	}

	/** The workflow files at a branch, tag or commit (the default branch if none). */
	async ciWorkflows(ref?: string): Promise<CiWorkflow[]> {
		const meta = this.meta();
		const { repoName, ref: resolved } = await this.freshRef(ref ?? meta.defaultBranch);
		if (repoName !== meta.name) throw new HttpError(400, "INVALID_INPUT", "Workflows are read from this repository's branches, tags and commits");
		using repo = await this.store.get(repoName);
		const [commit] = await repo.log({ ref: resolved, limit: 1 });
		if (!commit) {
			if (ref === undefined) return [];
			throw new HttpError(404, "NOT_FOUND", `${ref} not found`);
		}
		return this.ci.listWorkflows(commit.hash);
	}

	async ciSettings(): Promise<CiSettings> {
		this.meta();
		return this.ci.getSettings();
	}

	// An archived repository is read-only: settings can't be changed, but credentials can still be
	// removed (a leaked token shouldn't wait), and runs cancelled.

	async ciSetDefaultRunner(runner: unknown): Promise<CiSettings> {
		this.meta();
		this.assertWritable();
		return this.ci.setDefaultRunner(runner);
	}

	async ciSetDepot(input: { token: unknown; orgId?: unknown }): Promise<CiSettings> {
		this.meta();
		this.assertWritable();
		return this.ci.setDepot(input);
	}

	async ciRemoveDepot(): Promise<CiSettings> {
		this.meta();
		return this.ci.removeDepot();
	}

	async ciSetSecret(name: string, value: unknown): Promise<CiSettings> {
		this.meta();
		this.assertWritable();
		return this.ci.setSecret(name, value);
	}

	async ciDeleteSecret(name: string): Promise<CiSettings> {
		this.meta();
		return this.ci.deleteSecret(name);
	}
	// ── Actions caches and artifacts (records here, bytes in R2) ─────────────

	async ciCacheLookup(grant: JobGrant, keys: string[], version: string): Promise<{ id: string; key: string; size: number } | null> {
		this.meta();
		return this.ci.storage.lookupCache(grant, keys, version);
	}

	async ciCacheObject(grant: JobGrant, id: string): Promise<string> {
		this.meta();
		return this.ci.storage.cacheObject(grant, id);
	}

	async ciCacheReserve(grant: JobGrant, key: string, version: string, size: number): Promise<string | null> {
		this.meta();
		return this.ci.storage.reserveCache(grant, key, version, size);
	}

	async ciArtifacts(run: number): Promise<CiArtifact[]> {
		this.meta();
		return this.ci.storage.listArtifacts(run);
	}

	async ciArtifactObject(run: number, id: string): Promise<{ key: string; name: string }> {
		this.meta();
		return this.ci.storage.artifactObject(run, id);
	}

	async ciArtifactReserve(grant: JobGrant, name: string, size: number, retentionDays: number | null, overwrite: boolean): Promise<string> {
		this.meta();
		return this.ci.storage.reserveArtifact(grant, name, size, retentionDays, overwrite);
	}

	async ciUploadTarget(kind: "caches" | "artifacts", id: string, grant: JobGrant): Promise<{ key: string; uploadId: string }> {
		this.meta();
		return this.ci.storage.uploadTarget(kind, id, grant);
	}

	async ciUploadPart(kind: "caches" | "artifacts", id: string, grant: JobGrant, part: R2UploadedPart): Promise<void> {
		this.meta();
		this.ci.storage.recordPart(kind, id, grant, part);
	}

	async ciUploadCommit(kind: "caches" | "artifacts", id: string, grant: JobGrant): Promise<void> {
		this.meta();
		await this.ci.storage.commit(kind, id, grant);
	}

	async ciDeleteArtifact(run: number, id: string): Promise<void> {
		this.meta();
		await this.ci.storage.deleteArtifact(run, id);
	}

	async ciCaches(): Promise<CiCache[]> {
		this.meta();
		return this.ci.storage.listCaches();
	}

	async ciDeleteCache(id: string): Promise<void> {
		this.meta();
		await this.ci.storage.deleteCache(id);
	}


	// ── Wiki ─────────────────────────────────────────────────────────────────

	async wikiIndex(): Promise<WikiIndex> {
		this.meta();
		return this.wiki.index();
	}

	async wikiPage(slug: string): Promise<WikiPage> {
		this.meta();
		return this.wiki.page(slug);
	}

	async wikiHistory(slug: string, from?: string): Promise<FileHistory> {
		this.meta();
		return this.wiki.history(slug, from);
	}

	async wikiSave(input: SavePageInput): Promise<{ page: string; commit: string; packBytes: number }> {
		this.meta();
		return this.wiki.save(input);
	}

	async wikiDelete(input: Parameters<Wiki["remove"]>[0]): Promise<{ commit: string; packBytes: number }> {
		this.meta();
		return this.wiki.remove(input);
	}

	/** Where the Git proxy sends a clone of (or push to) the wiki; null for a clone of a wiki with no pages yet. */
	async wikiRemote(scope: "read" | "write"): Promise<RemoteAccess | null> {
		this.meta();
		return this.wiki.remote(scope);
	}

	/** Called after a push to the wiki through the Git proxy. */
	async wikiPushed(actor: string | null = null): Promise<void> {
		this.meta();
		await this.wiki.pushed(actor);
	}

	// ── Archiving ────────────────────────────────────────────────────────────

	/**
	 * An archived repository is read-only: no pushes, web commits, branch deletions or agent tasks.
	 * It can't be archived while agent tasks are still active, so nothing is left half merged.
	 */
	async setArchived(archived: boolean): Promise<void> {
		this.meta();
		if (!archived) {
			this.sql.exec("DELETE FROM meta WHERE key = 'archived'");
			return;
		}
		const active = this.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`, ...ACTIVE_STATUSES)
			.one().n;
		if (active > 0) {
			throw new HttpError(409, "TASKS_ACTIVE", `Finish or abandon the ${active} active agent task${active === 1 ? "" : "s"} before archiving`);
		}
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('archived', '1')");
		// Read-only from here: nothing new starts, and what's running stops rather than spending runner time.
		await this.ci.cancelAll("The repository was archived");
	}

	private assertWritable() {
		if (this.sql.exec("SELECT 1 FROM meta WHERE key = 'archived'").toArray().length > 0) {
			throw new HttpError(403, "ARCHIVED", "This repository is archived, so it's read-only. Its owner can unarchive it in Settings.");
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private metaOrNull(): Meta | null {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'project'").toArray()[0];
		return row ? JSON.parse(row.value) : null;
	}

	private meta(): Meta {
		const meta = this.metaOrNull();
		if (!meta) throw new HttpError(404, "NOT_FOUND", "Project not found");
		return meta;
	}

	private row(id: string): TaskRow {
		this.meta();
		const row = this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", `Task ${id} not found`);
		return row;
	}

	private requireFork(row: TaskRow) {
		if (!row.remote) {
			throw new HttpError(409, "NO_FORK", `Task ${row.id} has no fork (${row.error ?? "fork failed"}); create a new task`);
		}
	}

	private setStatus(id: string, status: TaskStatus) {
		this.sql.exec("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", status, new Date().toISOString(), id);
	}

	private resolveRef(ref: string): { repoName: string; ref: string } {
		const meta = this.meta();
		if (!ref.startsWith("task:")) {
			// A tag name resolves to its commit, unless a branch has the same name: browsing means the branch.
			const name = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
			const tag = this.knownTags()[name] ?? this.tagCache?.tags[name];
			if (tag && !(ref in this.knownRefs(meta))) return { repoName: meta.name, ref: tag };
			return { repoName: meta.name, ref };
		}
		const row = this.row(ref.slice("task:".length));
		if (row.status === "merged" || row.status === "abandoned") {
			// The fork is gone; merged work lives on the default branch.
			if (row.merged_oid) return { repoName: meta.name, ref: row.merged_oid };
			throw new HttpError(410, "TASK_CLOSED", `Task ${row.id} is ${row.status}`);
		}
		this.requireFork(row);
		return { repoName: row.repo, ref: meta.defaultBranch };
	}

	private async credentials(repoName: string, branch: string, scope: "read" | "write", ttl: number): Promise<GitCredentials> {
		return retrying(async () => {
			using repo: RepoHandle = await this.store.get(repoName);
			const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttl)]);
			return { remote: info.remote, branch, token: token.plaintext, expiresAt: token.expiresAt };
		});
	}

	private async baseAccess(meta: Meta): Promise<RemoteAccess> {
		if (!this.baseToken || this.baseToken.expires < Date.now() + 120_000) {
			const creds = await this.credentials(meta.name, meta.defaultBranch, "write", INTERNAL_TOKEN_TTL);
			this.baseToken = { token: creds.token, expires: Date.parse(creds.expiresAt) };
		}
		return { url: meta.remote, token: this.baseToken.token };
	}

	/**
	 * Fork and import are asynchronous in Artifacts; wait until the repo accepts Git traffic. Polls at
	 * most every half second: a check is one cheap lookup, and a longer gap only adds to the wait
	 * after the repository is ready (up to 2s each time, with the old cap).
	 */
	private async waitReady(repoName: string, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
			try {
				using _repo = await this.store.get(repoName);
				return;
			} catch (err) {
				const code = errorCode(err);
				const pending = code === "FORK_IN_PROGRESS" || code === "CREATE_IN_PROGRESS" || code === "IMPORT_IN_PROGRESS";
				if (!pending || Date.now() > deadline) throw err;
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	private overlapping(task: Task): TaskAccess["overlaps"] {
		if (task.paths.length === 0) return [];
		const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
		return this.sql
			.exec<TaskRow>(`SELECT * FROM tasks WHERE id != ? AND status IN (${placeholders})`, task.id, ...ACTIVE_STATUSES)
			.toArray()
			.map((r) => toTask(task.project, r))
			.filter((t) => t.paths.length > 0 && claimsOverlap(task.paths, t.paths))
			.map(({ id, title, agent, status, paths }) => ({ id, title, agent, status, paths }));
	}

	/** Tasks merged since `since` that changed any of `files`. */
	private tasksTouching(files: string[], since: string, exclude: string): string[] {
		const wanted = new Set(files);
		return this.sql
			.exec<{ id: string; changed_files: string }>(
				"SELECT id, changed_files FROM tasks WHERE status = 'merged' AND merged_at >= ? AND id != ?",
				since,
				exclude,
			)
			.toArray()
			.filter((r) => (JSON.parse(r.changed_files) as string[]).some((f) => wanted.has(f)))
			.map((r) => r.id);
	}

	private queuePosition(id: string): number {
		return this.sql.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM queue WHERE seq <= (SELECT seq FROM queue WHERE task_id = ?)",
			id,
		).one().n;
	}

	/** Current head access also applies to history recorded while a fork was public. */
	private async readableEvents(events: ProjectEvent[], viewer: PullViewer): Promise<ProjectEvent[]> {
		const pulls = [...new Set(events.filter((e) => e.type.startsWith("pull.")).map((e) => (e.data.pull as { number: number }).number))];
		const pullHeads = new Map<number, string | null>();
		for (let offset = 0; offset < pulls.length; offset += 90) {
			const batch = pulls.slice(offset, offset + 90);
			const { results } = await databaseOf(this.env).prepare(
				`select i."number", p."headRepoId" from "pull" p join "issue" i on i."id" = p."issueId" where p."repoId" = ? and i."number" in (${batch.map(() => "?").join(",")})`,
			).bind(this.meta().name, ...batch).all<{ number: number; headRepoId: string | null }>();
			for (const p of results) pullHeads.set(p.number, p.headRepoId);
		}
		const runHeads = this.ci.runHeads(events.filter((e) => e.type === "ci.completed").map((e) => (e.data.run as CiRunSummary).number));
		const heads = events.map((e): string | null | undefined => {
			if (e.type.startsWith("pull.")) {
				const number = (e.data.pull as { number: number }).number;
				// null in D1 means a deleted fork, not a same-repository head.
				if (pullHeads.has(number)) return pullHeads.get(number) ?? undefined;
				return e.data._headRepo as string | null | undefined;
			}
			if (e.type === "ci.completed") {
				return "_headRepo" in e.data ? e.data._headRepo as string | null : runHeads[(e.data.run as CiRunSummary).number];
			}
			return null;
		});
		const hidden = await unreadableRepos(databaseOf(this.env), heads.filter((h): h is string => typeof h === "string" && h !== this.meta().name), viewer);
		return events.map((e, i) => {
			const { _headRepo, ...data } = e.data;
			// Missing historical provenance is hidden conservatively; a deleted fork has no readers.
			const head = heads[i];
			const unknownFork = head === undefined && (e.type.startsWith("pull.") || e.type === "ci.completed" && (data.run as CiRunSummary).fromFork);
			const secret = unknownFork || typeof head === "string" && hidden.has(head);
			return { ...e, data: secret ? this.privateEventData(e.type, data) : data };
		});
	}

	private privateEventData(type: EventType, data: Record<string, unknown>): Record<string, unknown> {
		if (type === "ci.completed") return { ...data, run: privateRun(data.run as CiRunSummary) };
		return { ...data, pull: { ...data.pull as Record<string, unknown>, head: "", headRepo: "(private fork)" } };
	}

	/** Store provenance internally; shared live messages and webhooks have no head-repository viewer. */
	private async emitForkEvent(type: EventType, data: Record<string, unknown>, headRepo: string | null | undefined): Promise<void> {
		const hidden = headRepo === undefined || (headRepo !== null && await unreadableRepos(databaseOf(this.env), [headRepo], { viewerId: null }).then((s) => s.size > 0, () => true));
		this.emit(type, null, { ...data, _headRepo: headRepo }, hidden ? this.privateEventData(type, data) : data);
	}

	private emit(type: EventType, taskId: string | null, data: Record<string, unknown>, sharedData = data) {
		const ts = new Date().toISOString();
		const { seq } = this.sql
			.exec<{ seq: number }>(
				"INSERT INTO events (ts, type, task_id, data) VALUES (?, ?, ?, ?) RETURNING seq",
				ts,
				type,
				taskId,
				JSON.stringify(data),
			)
			.one();
		const message = JSON.stringify({ seq, ts, type, taskId, data: sharedData } satisfies ProjectEvent);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				// Socket already closed; the runtime cleans it up.
			}
		}
		if (this.hooks.enqueue(type, taskId, sharedData, this.repository()) > 0) {
			this.scheduleAlarm(Date.now()).catch((err) => console.error("scheduling webhook deliveries failed", err));
		}
		if (taskId && (type === "task.merged" || type === "task.failed" || type === "task.conflict")) {
			const task = this.sql.exec<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId).toArray()[0];
			const outcome = { "task.merged": "was merged", "task.failed": "failed", "task.conflict": "has conflicts" }[type];
			this.notifyOwner(type, `Task “${task?.title ?? taskId}” ${outcome}`, `t/${taskId}`);
		}
	}
}

/** Keeps the list of projects so they can be enumerated. A single named instance. */
export class Registry extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
	}

	async add(name: string): Promise<void> {
		this.ctx.storage.sql.exec("INSERT OR IGNORE INTO projects (name, created_at) VALUES (?, ?)", name, new Date().toISOString());
	}

	async remove(name: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM projects WHERE name = ?", name);
	}

	async list(): Promise<string[]> {
		return this.ctx.storage.sql
			.exec<{ name: string }>("SELECT name FROM projects ORDER BY created_at")
			.toArray()
			.map((r) => r.name);
	}
}

const TRANSIENT = new Set(["INTERNAL_ERROR", "UPSTREAM_UNAVAILABLE", "FORK_IN_PROGRESS"]);
/** A fork attempt that failed this way is retried under a new name. NOT_FOUND/ALREADY_EXISTS mean a half-created fork. */
const FORK_RETRYABLE = new Set([...TRANSIENT, "NOT_FOUND", "ALREADY_EXISTS", "CREATE_IN_PROGRESS"]);

const MAX_RELEASES = 1000;

/** "fixes #12", "Closes #3", "resolved: #7", as GitHub reads them. */
const FIXES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** FIFO counting semaphore. A released slot is handed straight to the next waiter, so the cap is never exceeded. */
class Semaphore {
	private active = 0;
	private readonly waiters: (() => void)[] = [];
	private readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active < this.max) this.active++;
		else await new Promise<void>((resolve) => this.waiters.push(resolve));
		try {
			return await fn();
		} finally {
			const next = this.waiters.shift();
			if (next) next();
			else this.active--;
		}
	}
}

/** Retries transient Artifacts failures with backoff (about 3.5s in total). */
async function retrying<T>(fn: () => Promise<T>, delays = [250, 750, 2500]): Promise<T> {
	const history: string[] = [];
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const code = errorCode(err) ?? "UNKNOWN";
			if (attempt >= delays.length || !TRANSIENT.has(code)) {
				if (history.length === 0) throw err;
				const e = toHttpError(err);
				throw new HttpError(e.status, e.code, `${e.detail} (earlier attempts: ${history.join(", ")})`);
			}
			history.push(code);
			await new Promise((r) => setTimeout(r, delays[attempt]));
		}
	}
}

/**
 * Gives a new, empty repository its first commit, a README, pushed as one pack in one request (no
 * clone, no ref discovery). Returns the commit.
 */
async function seedReadme(remote: RemoteAccess, branch: string, input: CreateProjectInput): Promise<string> {
	const empty: ObjectReader = { readTree: async () => null, readBlob: async () => null, readCommit: async () => null };
	const { commit } = await commitChanges(empty, remote, {
		branch,
		parent: null,
		create: true,
		changes: [{ path: "README.md", content: new TextEncoder().encode(`# ${input.title ?? input.name}\n\n${input.description ?? ""}\n`) }],
		message: "Initial commit",
		author: MERGE_IDENTITY,
		time: Math.floor(Date.now() / 1000),
		maxPackBytes: Number.POSITIVE_INFINITY,
	});
	return commit;
}

/** Runs one Artifacts call, naming the step in the error so failures are attributable. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const e = toHttpError(err);
		throw new HttpError(e.status, e.code, `${name}: ${e.detail}`);
	}
}

/** The tree entry at `path` under the root tree `tree`, or null. */
async function entryAt(repo: ObjectReader, tree: string, path: string) {
	const parts = path.split("/");
	let hash = tree;
	for (const [i, part] of parts.entries()) {
		const entry = (await repo.readTree(hash))?.find((e) => e.name === part);
		if (!entry) return null;
		if (i === parts.length - 1) return entry;
		if (entry.type !== "tree") return null;
		hash = entry.hash;
	}
	return null;
}

/** Reads a commit by full hash, or the tip of a branch or tag. */
async function resolveCommit(repo: RepoHandle, ref: string): Promise<ArtifactsCommitMetadata> {
	const commit = /^[0-9a-f]{40}$/.test(ref) ? await repo.readCommit(ref) : (await repo.log({ ref, limit: 1 }))[0];
	if (!commit) throw new HttpError(404, "NOT_FOUND", `${ref} is not a commit in this repository`);
	return commit;
}

/** Artifacts tokens look like `art_v1_<secret>?expires=<unix seconds>`. */
function tokenExpiry(token: string): string {
	const expires = Number(new URL(token, "https://token.invalid").searchParams.get("expires"));
	return Number.isFinite(expires) && expires > 0 ? new Date(expires * 1000).toISOString() : "";
}

/** Tag name to the commit it names. */
function tagCommits(tags: Map<string, TagRef>): Record<string, string> {
	return Object.fromEntries([...tags].map(([name, t]) => [name, t.commit]));
}

type ReleaseRow = {
	id: string;
	tag: string;
	name: string;
	notes: string;
	prerelease: number;
	author: string | null;
	created_at: string;
	updated_at: string;
};

function toRelease(r: ReleaseRow, commit: string | null): Release {
	return {
		id: r.id,
		tag: r.tag,
		name: r.name,
		notes: r.notes,
		prerelease: Boolean(r.prerelease),
		author: r.author,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		commit,
	};
}

function toTask(project: string, r: TaskRow): Task {
	return {
		id: r.id,
		project,
		title: r.title,
		agent: r.agent,
		status: r.status,
		paths: JSON.parse(r.paths),
		repo: r.repo,
		remote: r.remote || null,
		forkAttempts: r.fork_attempts ?? 0,
		baseOid: r.base_oid,
		headOid: r.head_oid,
		mergedOid: r.merged_oid,
		changedFiles: JSON.parse(r.changed_files),
		conflict: r.conflict ? JSON.parse(r.conflict) : null,
		error: r.error,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		submittedAt: r.submitted_at,
		mergedAt: r.merged_at,
	};
}

function toEvent(r: { seq: number; ts: string; type: EventType; task_id: string | null; data: string }): ProjectEvent {
	return { seq: r.seq, ts: r.ts, type: r.type, taskId: r.task_id, data: JSON.parse(r.data) };
}
