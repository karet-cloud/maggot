import { DurableObject } from "cloudflare:workers";
import {
	ACTIVE_STATUSES,
	TASK_STATUSES,
	type Branches,
	type Commit,
	type CommitDetail,
	type Comparison,
	type ConflictInfo,
	type Diff,
	type EventType,
	type GitCredentials,
	type Project,
	type ProjectEvent,
	type QueueEntry,
	type Task,
	type TaskAccess,
	type TaskStatus,
	type Tree,
} from "./api.ts";
import { errorCode, HttpError, toHttpError } from "./errors.ts";
import { diffTrees, mapLimit, walkToMainline, type ObjectReader } from "./git/diff.ts";
import { deleteBranch, listBranches } from "./git/protocol.ts";
import { Workspace, type Identity, type RemoteAccess } from "./git/workspace.ts";
import { claimsOverlap, forkRepoName, newTaskId, normalizeClaim } from "./names.ts";
import { repoStore, type RepoHandle, type RepoStore } from "./store.ts";

const MERGE_IDENTITY: Identity = { name: "megit", email: "merge-queue@megit.dev" };
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
	importBranch?: string;
	/** Seed a README so the repo starts with a commit (default true). Leave it out to push an existing repo. */
	readme?: boolean;
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

type Meta = { name: string; description: string | null; defaultBranch: string; remote: string; createdAt: string };

/**
 * One instance per project. It is the only writer to the project's default branch: agents push
 * to their own task forks, and merges are serialized through a queue drained by the alarm.
 */
export class ProjectCoordinator extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private readonly store: RepoStore;
	private workspace: Workspace | undefined;
	private workspaceMerges = 0;
	private baseToken: { token: string; expires: number } | undefined;
	private readToken: { token: string; expires: number } | undefined;
	/** Once the default branch has a commit it always will; skips re-checking on every task. */
	private hasCommits = false;
	private readonly forkSlots = new Semaphore(FORK_CONCURRENCY);
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
		`);
		// Columns added after the first schema; ALTER fails harmlessly when they already exist.
		try {
			this.sql.exec("ALTER TABLE tasks ADD COLUMN fork_attempts INTEGER NOT NULL DEFAULT 0");
		} catch {
			// Already migrated.
		}
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// ── Project ──────────────────────────────────────────────────────────────

	async create(input: CreateProjectInput): Promise<Project> {
		if (this.metaOrNull()) throw new HttpError(409, "ALREADY_EXISTS", `Project ${input.name} already exists`);
		let created: Pick<ArtifactsCreateRepoResult, "name" | "description" | "defaultBranch" | "remote" | "token">;
		try {
			created = await retrying(() =>
				input.importUrl
					? this.store.import({
							source: { url: input.importUrl, branch: input.importBranch },
							target: { name: input.name, opts: { description: input.description } },
						})
					: this.store.create(input.name, { description: input.description, setDefaultBranch: input.defaultBranch ?? "master" }),
			);
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
		const empty = await (async () => {
			using repo = await this.store.get(created.name);
			return (await repo.log({ ref: created.defaultBranch, limit: 1 })).length === 0;
		})();
		if (empty && !input.importUrl && input.readme !== false) {
			const seed = new Workspace(created.defaultBranch, MERGE_IDENTITY);
			await seed.seed(
				{ url: created.remote, token: created.token },
				{ "README.md": `# ${input.name}\n\n${input.description ?? ""}\n` },
				"Initial commit",
			);
		}

		const meta: Meta = {
			name: created.name,
			description: created.description,
			defaultBranch: created.defaultBranch,
			remote: created.remote,
			createdAt: new Date().toISOString(),
		};
		this.sql.exec("INSERT INTO meta (key, value) VALUES ('project', ?)", JSON.stringify(meta));
		this.emit("project.created", null, { name: meta.name, imported: Boolean(input.importUrl) });
		return this.getProject();
	}

	/**
	 * Git credentials for the project repo itself, for people pushing to it directly (for example the
	 * first push of an existing repository). Agents should use tasks instead, so the merge queue applies.
	 */
	async repoAccess(scope: "read" | "write" = "write"): Promise<GitCredentials> {
		const meta = this.meta();
		return this.credentials(meta.name, meta.defaultBranch, scope, REPO_TOKEN_TTL);
	}

	/** Where the Git proxy sends a user's clone or push, with a cached short-lived Artifacts token. */
	async gitRemote(scope: "read" | "write"): Promise<RemoteAccess> {
		const meta = this.meta();
		if (scope === "write") return this.baseAccess(meta);
		if (!this.readToken || this.readToken.expires < Date.now() + 120_000) {
			const creds = await this.credentials(meta.name, meta.defaultBranch, "read", INTERNAL_TOKEN_TTL);
			this.readToken = { token: creds.token, expires: Date.parse(creds.expiresAt) };
		}
		return { url: meta.remote, token: this.readToken.token };
	}

	/** Called after a push through the Git proxy: records the new head so live views refresh. */
	async pushed(): Promise<void> {
		const meta = this.meta();
		using repo = await this.store.get(meta.name);
		const head = (await repo.log({ ref: meta.defaultBranch, limit: 1 }))[0]?.hash ?? null;
		const previous = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'pushedHead'").toArray()[0]?.value ?? null;
		if (head) this.hasCommits = true;
		this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('pushedHead', ?)", head ?? "");
		// The proxy can't see which refs a push touched; report whether the default branch moved.
		this.emit("repo.pushed", null, { branch: meta.defaultBranch, from: previous || null, to: head, moved: head !== (previous || null) });
	}

	async getProject(): Promise<Project> {
		const meta = this.meta();
		const stats = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
		for (const row of this.sql.exec<{ status: TaskStatus; n: number }>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")) {
			stats[row.status] = row.n;
		}
		let head: string | null = null;
		try {
			using repo = await this.store.get(meta.name);
			head = (await repo.log({ ref: meta.defaultBranch, limit: 1 }))[0]?.hash ?? null;
		} catch {
			// Repo still importing or temporarily unavailable; head is informational.
		}
		const queueLength = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM queue").one().n;
		return { ...meta, head, stats, queueLength };
	}

	/** Deletes every task fork, the project repo, and all coordinator state. */
	async destroy(): Promise<void> {
		const meta = this.meta();
		const forks = [
			...this.sql.exec<{ repo: string }>("SELECT repo FROM tasks WHERE status != 'abandoned'").toArray(),
			...this.sql.exec<{ repo: string }>("SELECT repo FROM cleanup").toArray(),
		];
		// Each delete takes seconds; run them in parallel batches so large projects finish in one request.
		for (let i = 0; i < forks.length; i += 10) {
			await Promise.all(forks.slice(i, i + 10).map((row) => this.store.delete(row.repo).catch(() => false)));
		}
		await this.store.delete(meta.name).catch(() => false);
		for (const ws of this.ctx.getWebSockets()) ws.close(1001, "Project deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async log(ref?: string, limit = 50): Promise<Commit[]> {
		const meta = this.meta();
		const { repoName, ref: resolved } = this.resolveRef(ref ?? meta.defaultBranch);
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
		const { repoName, ref: resolved } = this.resolveRef(ref ?? meta.defaultBranch);
		using repo = await this.store.get(repoName);
		const blob = await repo.readFile({ ref: resolved, path });
		return blob ? { content: await blob.text(), contentType: blob.type || "text/plain;charset=utf-8" } : null;
	}

	/** Lists a directory at `ref` (same refs as readFile). `commit` is null for an empty repo. */
	async tree(ref: string | undefined, path = ""): Promise<Tree> {
		const meta = this.meta();
		const { repoName, ref: resolved } = this.resolveRef(ref ?? meta.defaultBranch);
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

	async deleteBranch(name: string): Promise<void> {
		const meta = this.meta();
		if (name === meta.defaultBranch) throw new HttpError(400, "DEFAULT_BRANCH", "The default branch can't be deleted");
		const access = await this.baseAccess(meta);
		const head = (await listBranches(access)).get(name);
		if (!head) throw new HttpError(404, "NOT_FOUND", `Branch ${name} not found`);
		await deleteBranch(access, name, head);
	}

	/** Which repo and commit a ref names, for reads done outside the coordinator (raw files, archives). */
	async locate(ref?: string): Promise<{ repo: string; commit: string; treeHash: string; committedAt: number }> {
		const { repoName, ref: resolved } = this.resolveRef(ref ?? this.meta().defaultBranch);
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
		const meta = this.meta();
		const title = input.title?.trim();
		if (!title) throw new HttpError(400, "INVALID_INPUT", "title is required");
		const paths = [...new Set((input.paths ?? []).map(normalizeClaim))];
		// Forks of an empty repo have nothing to merge against; the first commit has to land directly.
		this.hasCommits ||= await (async () => {
			using repo = await this.store.get(meta.name);
			return (await repo.log({ ref: meta.defaultBranch, limit: 1 })).length > 0;
		})();
		if (!this.hasCommits) {
			throw new HttpError(409, "EMPTY_REPO", `Push a first commit to ${meta.defaultBranch} before creating tasks`);
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
	async recentEvents(limit = 100): Promise<ProjectEvent[]> {
		this.meta();
		return this.sql
			.exec<{ seq: number; ts: string; type: EventType; task_id: string | null; data: string }>(
				"SELECT * FROM events ORDER BY seq DESC LIMIT ?",
				Math.max(1, Math.min(limit, 1000)),
			)
			.toArray()
			.reverse()
			.map(toEvent);
	}

	async events(after = 0, limit = 100): Promise<ProjectEvent[]> {
		this.meta();
		return this.sql
			.exec<{ seq: number; ts: string; type: EventType; task_id: string | null; data: string }>(
				"SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
				after,
				Math.max(1, Math.min(limit, 1000)),
			)
			.toArray()
			.map(toEvent);
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
		await Promise.all([this.drainMerges(), this.resumeProvisioning()]);
		const pending = this.sql.exec<{ n: number }>(
			"SELECT (SELECT COUNT(*) FROM tasks WHERE status = 'provisioning') + (SELECT COUNT(*) FROM cleanup) AS n",
		).one().n;
		if (pending > 0) await this.scheduleAlarm(Date.now() + 5_000);
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
					return base.fork(repoName, { description: `${meta.name}: ${row.title}`, defaultBranchOnly: true });
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

	private async mergeTask(id: string): Promise<void> {
		const meta = this.meta();
		const row = this.row(id);
		// "merging" here means a previous alarm died mid-merge; the merge is idempotent, so redo it.
		if (row.status !== "queued" && row.status !== "merging") return;
		this.setStatus(id, "merging");
		this.emit("task.merging", id, {});

		try {
			const base = await this.baseAccess(meta);
			const fork = await this.credentials(row.repo, meta.defaultBranch, "read", INTERNAL_TOKEN_TTL);
			if (!this.workspace || this.workspaceMerges >= WORKSPACE_MAX_MERGES) {
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

				const author = { name: row.agent ?? "agent", email: `${row.agent ?? "agent"}@agents.megit.dev` };
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

				if (await ws.push(base)) {
					this.markMerged(id, outcome.oid, outcome.changedFiles);
					// The next push's "from" is this merge, not whatever was pushed before it.
					this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('pushedHead', ?)", outcome.oid);
					this.emit("main.advanced", id, {
						from: baseHead,
						to: outcome.oid,
						fastForward: outcome.fastForward,
						changedFiles: outcome.changedFiles,
					});
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
		if (!ref.startsWith("task:")) return { repoName: meta.name, ref };
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

	/** Fork and import are asynchronous in Artifacts; wait until the repo accepts Git traffic. */
	private async waitReady(repoName: string, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (let delay = 100; ; delay = Math.min(delay * 2, 2000)) {
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

	private emit(type: EventType, taskId: string | null, data: Record<string, unknown>) {
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
		const message = JSON.stringify({ seq, ts, type, taskId, data } satisfies ProjectEvent);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				// Socket already closed; the runtime cleans it up.
			}
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

/** Runs one Artifacts call, naming the step in the error so failures are attributable. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const e = toHttpError(err);
		throw new HttpError(e.status, e.code, `${name}: ${e.detail}`);
	}
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
