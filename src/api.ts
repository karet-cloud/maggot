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

export interface ApiError {
	error: { code: string; message: string };
}
