// Public API types. This file has no runtime imports so a UI can import it directly.

export type TaskStatus =
	| "provisioning" // waiting in the project's fork queue; no fork yet
	| "open" // fork exists, agent is working
	| "queued" // submitted, waiting in the merge queue
	| "merging" // the coordinator is merging it right now
	| "merged" // landed on the project's default branch
	| "conflict" // merge hit conflicts; agent must sync and resubmit
	| "failed" // merge failed for a non-conflict reason; resubmit to retry
	| "abandoned"; // fork deleted without merging

export const ACTIVE_STATUSES: TaskStatus[] = ["provisioning", "open", "queued", "merging", "conflict", "failed"];

export const TASK_STATUSES: TaskStatus[] = [
	"provisioning",
	"open",
	"queued",
	"merging",
	"merged",
	"conflict",
	"failed",
	"abandoned",
];

export interface Project {
	name: string;
	description: string | null;
	defaultBranch: string;
	remote: string;
	createdAt: string;
	head: string | null;
	stats: Record<TaskStatus, number>;
	queueLength: number;
}

export interface Task {
	id: string;
	project: string;
	title: string;
	agent: string | null;
	status: TaskStatus;
	/** Advisory path claims (files or directory prefixes) the agent intends to touch. */
	paths: string[];
	/** Artifacts repo backing this task (a fork of the project repo). Changes if a fork attempt is retried. */
	repo: string;
	/** Git remote of the fork; null while provisioning or if the fork could not be created. */
	remote: string | null;
	/** Fork attempts so far (more than 1 means Artifacts failed and the fork was retried under a new name). */
	forkAttempts: number;
	/** Default-branch commit the fork was created from or last merged/synced against. */
	baseOid: string | null;
	/** Fork head commit at the last submit. */
	headOid: string | null;
	mergedOid: string | null;
	changedFiles: string[];
	conflict: ConflictInfo | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	submittedAt: string | null;
	mergedAt: string | null;
}

export interface ConflictInfo {
	files: string[];
	/** Other merged tasks that touched the conflicting files since this task's base. */
	withTasks: string[];
}

export interface GitCredentials {
	remote: string;
	branch: string;
	token: string;
	expiresAt: string;
}

/**
 * Returned when a task is created or credentials are refreshed. While the task is still
 * `provisioning`, `fork` and `base` are null: wait for `task.ready` (or poll the task), then call
 * the access endpoint.
 */
export interface TaskAccess {
	task: Task;
	/** Read/write access to the task's own fork. */
	fork: GitCredentials | null;
	/** Read-only access to the project's repo, used to sync with the latest default branch. */
	base: GitCredentials | null;
	/** Active tasks whose path claims overlap this one. */
	overlaps: Pick<Task, "id" | "title" | "agent" | "status" | "paths">[];
}

export interface QueueEntry {
	position: number;
	taskId: string;
	title: string;
	agent: string | null;
	status: TaskStatus;
	enqueuedAt: string;
}

export type EventType =
	| "project.created"
	| "repo.pushed"
	| "task.created"
	| "task.ready"
	| "task.submitted"
	| "task.merging"
	| "task.merged"
	| "task.conflict"
	| "task.failed"
	| "task.abandoned"
	| "main.advanced";

export interface ProjectEvent {
	seq: number;
	ts: string;
	type: EventType;
	taskId: string | null;
	data: Record<string, unknown>;
}

export interface Commit {
	hash: string;
	message: string;
	author: { name: string; email: string };
	parents: string[];
	committedAt: number;
}

export interface TreeEntry {
	name: string;
	/** Path from the repo root. */
	path: string;
	type: "tree" | "blob" | "exec" | "symlink" | "gitlink";
	hash: string;
}

/** A directory listing; directories first, then files, each alphabetical. */
export interface Tree {
	/** Commit the listing was read from; null if the repo has no commits. */
	commit: string | null;
	path: string;
	entries: TreeEntry[];
}

/** A commit with everything the commit page shows. */
export interface CommitDetail extends Commit {
	treeHash: string;
	committer: { name: string; email: string };
	authoredAt: number;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Each line starts with " ", "+", "-", or "\\" (for "No newline at end of file"). */
	lines: string[];
}

export interface FileDiff {
	path: string;
	status: "added" | "deleted" | "modified";
	oldMode: string | null;
	newMode: string | null;
	additions: number;
	deletions: number;
	binary: boolean;
	/** Too big to diff inline; additions and deletions are 0. */
	tooLarge: boolean;
	hunks: DiffHunk[];
}

export interface Diff {
	files: FileDiff[];
	additions: number;
	deletions: number;
	/** More files changed than a diff lists; `files` holds the first ones found, sorted by path. */
	truncated: boolean;
}

/** What `head` adds on top of `base`: the commits only `head` has and the diff from their merge base. */
export interface Comparison {
	base: string;
	head: string;
	/** Null when no common ancestor is within the searched history. */
	mergeBase: string | null;
	/** Newest first. */
	commits: Commit[];
	/** `commits` stopped at the search limit. */
	capped: boolean;
	diff: Diff;
}

export interface BranchSummary {
	name: string;
	head: string;
	commit: Pick<Commit, "message" | "author" | "committedAt"> | null;
	/** Commits on the branch but not the default branch; null if not computed. */
	ahead: number | null;
	/** Commits on the default branch (first-parent) since the branch split off. */
	behind: number | null;
	/** The ahead count stopped at its limit. */
	capped: boolean;
}

export interface Branches {
	defaultBranch: string;
	branches: (BranchSummary & { default: boolean })[];
	/** Task forks: each agent works on its own fork's copy of the default branch. */
	agents: (BranchSummary & { taskId: string; title: string; agent: string | null; status: TaskStatus })[];
}

export type Visibility = "public" | "private";

/** A user-owned repository: `owner/name` on the web, `<origin>/owner/name.git` for git. */
export interface RepoInfo {
	owner: string;
	name: string;
	fullName: string;
	description: string | null;
	visibility: Visibility;
	defaultBranch: string;
	createdAt: string;
	/** HTTPS clone URL served by megit; push with a personal access token as the password. */
	cloneUrl: string;
	/** Whether the caller may push, change settings, and run tasks. */
	canWrite: boolean;
	stars: number;
	/** Public forks. */
	forks: number;
	/** Whether the caller has starred it. */
	starred: boolean;
	/** The repository it was forked from, if the caller can see that one. */
	forkOf: { owner: string; name: string } | null;
	/** Bytes pushed to it so far, which the size limit is checked against. */
	sizeBytes: number;
	/** SSH clone URL (`git@host:owner/name.git`); needs the WebSocket ProxyCommand from the SSH keys page. */
	sshUrl: string;
	/** When it was archived (made read-only); null if it's live. */
	archivedAt: string | null;
}

/** A pending offer to hand a repository to another user, who has to accept it. */
export interface RepoTransfer {
	/** The repository's internal id; accept or decline with it. */
	id: string;
	repo: string;
	from: string;
	to: string;
	description: string | null;
	visibility: Visibility;
	createdAt: string;
	expiresAt: string;
}

/** Every file path in a commit, for the file finder. */
export interface FileList {
	commit: string | null;
	paths: string[];
	/** The repository has more files than the finder lists. */
	truncated: boolean;
}

export interface SshKey {
	id: string;
	name: string;
	/** ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa, ... */
	type: string;
	/** SHA256:..., as `ssh-keygen -lf` prints it. */
	fingerprint: string;
	createdAt: string;
	lastUsedAt: string | null;
}

/** How to reach megit over SSH. */
export interface SshInfo {
	/** The host key, in known_hosts form (`ssh-ed25519 AAAA...`). */
	hostKey: string;
	fingerprint: string;
	/** WebSocket URL the ProxyCommand connects to. */
	url: string;
	host: string;
}

export interface Viewer {
	id: string;
	username: string;
	name: string;
	email: string;
	emailVerified: boolean;
	/** What the account uses against its quotas. */
	usage: { repos: number; bytes: number; maxRepos: number; maxBytes: number };
}

export interface ApiError {
	error: { code: string; message: string };
}

/** Code search in one repository's default branch. */
export interface CodeSearch {
	/** The commit the index reflects; null until the first index is built. */
	commit: string | null;
	/** Some files weren't indexed (too many, or the index is full). */
	partial: boolean;
	/** Files in the index. */
	files: number;
	/** The index is being brought up to date; results may be from an older commit. */
	indexing: boolean;
	results: { path: string; matches: number; lines: { line: number; text: string }[] }[];
}

export type WebhookEvent = "push" | "task" | "merge";

export interface Webhook {
	id: string;
	url: string;
	events: WebhookEvent[];
	active: boolean;
	createdAt: string;
	/** The last delivery's outcome, if any. */
	lastStatus: "pending" | "delivered" | "failed" | null;
}

export interface WebhookDelivery {
	id: string;
	hookId: string;
	event: WebhookEvent | "ping";
	status: "pending" | "delivered" | "failed";
	attempts: number;
	responseStatus: number | null;
	/** The start of the response body, or the error that stopped the request. */
	response: string | null;
	durationMs: number | null;
	payload: unknown;
	createdAt: string;
	deliveredAt: string | null;
	/** When the next attempt is due, while pending. */
	nextAt: string | null;
}

export type NotificationKind = "star" | "fork" | "transfer" | "task.merged" | "task.failed" | "task.conflict" | "webhook.failing";

export interface Notification {
	id: string;
	kind: NotificationKind;
	/** `owner/name` of the repository it's about. */
	repo: string | null;
	title: string;
	/** Site path to open. */
	url: string;
	actor: string | null;
	createdAt: string;
	readAt: string | null;
}
