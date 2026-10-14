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
	| "main.advanced"
	| "tag.created"
	| "tag.deleted"
	| "release.published"
	| "release.edited"
	| "release.deleted"
	| "issue.opened"
	| "issue.closed"
	| "issue.reopened"
	| "issue.commented"
	| "pull.opened"
	| "pull.reviewed"
	| "pull.merged"
	| "ci.completed"
	| "wiki.updated";

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
	/** HTTPS clone URL served by maggot; push with a personal access token as the password. */
	cloneUrl: string;
	/** Whether the caller may push, change settings, and run tasks. */
	canWrite: boolean;
	/** Whether the caller may change settings, collaborators and webhooks, and archive it. */
	canAdmin: boolean;
	/** Whether the caller owns it (or owns the organization that does), so may transfer or delete it. */
	isOwner: boolean;
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
	openIssues: number;
	openPulls: number;
	/** Whether the wiki is turned on (its pages are kept while it's off). */
	hasWiki: boolean;
	/** Where the wiki clones from: `<origin>/<owner>/<name>.wiki.git`. */
	wikiUrl: string;
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

/** How to reach maggot over SSH. */
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

/** `gollum` is GitHub's name for wiki page changes. */
export type WebhookEvent = "push" | "task" | "merge" | "release" | "issues" | "pull_request" | "workflow_run" | "gollum";

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

export type NotificationKind = "star" | "fork" | "transfer" | "issue" | "invitation" | "task.merged" | "task.failed" | "task.conflict" | "webhook.failing";

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

// ── Tags and releases ────────────────────────────────────────────────────────

export interface Tag {
	name: string;
	/** The commit the tag names. */
	commit: string;
	annotated: boolean;
	/** The commit's first line, author and date; null if it couldn't be read. */
	summary: Pick<Commit, "message" | "author" | "committedAt"> | null;
}

export interface Release {
	id: string;
	tag: string;
	name: string;
	/** Markdown. */
	notes: string;
	prerelease: boolean;
	author: string | null;
	createdAt: string;
	updatedAt: string;
	/** The commit the tag names now; null if the tag has since been deleted. */
	commit: string | null;
}

// ── Commit graph ─────────────────────────────────────────────────────────────

export interface GraphCommit extends Commit {
	/** Branches whose head is this commit. */
	branches: string[];
	tags: string[];
}

/** Recent commits across every branch, newest first, with their parents, for drawing the graph. */
export interface Graph {
	commits: GraphCommit[];
	/** Older history exists beyond what's listed. */
	truncated: boolean;
}

// ── Branch protection ────────────────────────────────────────────────────────

export interface BranchRule {
	/** A branch name, or a pattern: `*` matches within one path segment, `**` across them. */
	pattern: string;
	blockDeletions: boolean;
	/** Pushes may only fast-forward. */
	blockForcePushes: boolean;
	/** No pushes or web commits at all: changes land through the merge queue (agent tasks). */
	requireMergeQueue: boolean;
	/** Pull requests into it need an approving review from someone who can merge, and no changes requested. */
	requireReview: boolean;
	/** Pull requests into it need their maggot Actions runs on the head commit to have passed. */
	requireChecks: boolean;
	createdAt: string;
}

// ── Issues ───────────────────────────────────────────────────────────────────

export type IssueState = "open" | "closed";

export interface IssueSummary {
	number: number;
	title: string;
	state: IssueState;
	labels: string[];
	author: string | null;
	comments: number;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

export interface Issue extends IssueSummary {
	/** Markdown. */
	body: string;
	closedBy: string | null;
	/** The commit that closed it with "fixes #n", if one did. */
	closedByCommit: string | null;
	/** Whether the caller may edit, close and label it. */
	canEdit: boolean;
	canLabel: boolean;
}

export interface IssueComment {
	id: string;
	author: string | null;
	body: string;
	createdAt: string;
	updatedAt: string;
	canEdit: boolean;
}

export interface IssueList {
	issues: IssueSummary[];
	open: number;
	closed: number;
}

// ── File history and blame ───────────────────────────────────────────────────

export interface FileHistory {
	path: string;
	/** Commits that changed the file, newest first. */
	commits: (Commit & { change: "modified" | "deleted" })[];
	/** Where to carry on from (`?from=`) for older history; null when it's all here. */
	next: string | null;
}

/** A wiki page as listed: `slug` names it in URLs ("Getting-Started"), `title` is how it reads. */
export interface WikiPageSummary {
	slug: string;
	title: string;
	/** Its file in the wiki repository (Getting-Started.md). */
	path: string;
}

export interface WikiIndex {
	/** The wiki's head commit; null while it has no pages. Edits name it as their base. */
	head: string | null;
	/** Home first, then by title. */
	pages: WikiPageSummary[];
	/** _Sidebar.md and _Footer.md, when the wiki has them. */
	sidebar: string | null;
	footer: string | null;
}

export interface WikiPage extends WikiPageSummary {
	source: string;
	/** The wiki's head when the page was read. */
	head: string;
	/** The last commit that changed the page, if it's within the history looked through. */
	lastCommit: Commit | null;
}

/** A page a wiki change touched, as the feed and `gollum` webhooks report it. */
export interface WikiPageChange {
	page_name: string;
	title: string;
	action: "created" | "edited" | "deleted";
	sha: string;
}

export interface Blame {
	path: string;
	/** Each line of the file with the commit that last changed it. */
	lines: { text: string; commit: string; boundary: boolean }[];
	commits: Record<string, Commit>;
	/** Binary, or too big to blame. */
	tooLarge: boolean;
}

// ── Pull requests and code review ────────────────────────────────────────────

export type PullState = "open" | "closed" | "merged";
export type ReviewState = "approved" | "changes_requested" | "commented";
export type MergeMethod = "merge" | "squash";

export interface PullSummary extends IssueSummary {
	pullState: PullState;
	base: string;
	head: string;
	/** `owner/name` of the fork the changes come from; null for a branch of this repository. */
	headRepo: string | null;
	/** Approved or changes requested, by the latest review of each reviewer with write access. */
	decision: "approved" | "changes_requested" | null;
}

export interface Pull extends PullSummary {
	body: string;
	closedBy: string | null;
	mergedAt: string | null;
	mergedBy: string | null;
	mergeCommit: string | null;
	canEdit: boolean;
	canLabel: boolean;
	/** Whether the caller may merge it (write access to the base). */
	canMerge: boolean;
	/** A branch rule on the base wants an approving review before merging. */
	reviewRequired: boolean;
	/** A branch rule on the base wants its Actions runs on the head commit to have passed before merging. */
	checksRequired: boolean;
}

export interface Review {
	id: string;
	author: string | null;
	state: ReviewState;
	body: string;
	commit: string | null;
	createdAt: string;
}

export interface ReviewComment {
	id: string;
	reviewId: string;
	author: string | null;
	path: string;
	line: number;
	side: "new" | "old";
	body: string;
	commit: string | null;
	createdAt: string;
}

export interface PullList {
	pulls: PullSummary[];
	open: number;
	closed: number;
}

// ── Organizations, teams and collaborators ───────────────────────────────────

export type OrgRole = "owner" | "member";
export type Permission = "read" | "write" | "admin";

export interface OrgMember {
	username: string;
	role: OrgRole;
	/** Invited people show only to members. */
	state: "active" | "invited";
	createdAt: string;
}

export interface Team {
	id: string;
	name: string;
	members: string[];
	repos: { repo: string; permission: Permission }[];
}

export interface Org {
	name: string;
	displayName: string;
	createdAt: string;
	/** The caller's role, if they're a member. */
	role: OrgRole | null;
	/** The caller has an invitation waiting. */
	invited: boolean;
	members: OrgMember[];
	/** Teams, for members only. */
	teams: Team[];
}

export interface Collaborator {
	username: string;
	permission: Permission;
	state: "active" | "invited";
	createdAt: string;
}

/** An invitation waiting for the caller: to join an organization, or to collaborate on a repository. */
export interface Invitation {
	kind: "org" | "repo";
	/** What to accept or decline with. */
	id: string;
	/** The organization, or the repository's owner/name. */
	name: string;
	/** The role or permission on offer. */
	access: string;
	from: string | null;
	createdAt: string;
}

// ── Actions (CI) ─────────────────────────────────────────────────────────────

/** Where jobs run: a Cloudflare container, or a Depot sandbox paid for with the repository's Depot token. */
export type CiRunner = "cloudflare" | "depot";
export type CiEvent = "push" | "pull_request" | "workflow_dispatch" | "schedule";
/** `waiting`: a run from a fork's pull request, until someone who can merge approves it. */
export type CiStatus = "queued" | "waiting" | "in_progress" | "completed";
export type CiConclusion = "success" | "failure" | "cancelled" | "skipped";

export interface CiStep {
	name: string;
	status: "pending" | "in_progress" | "completed";
	conclusion: CiConclusion | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface CiJob {
	id: string;
	key: string;
	name: string;
	runner: CiRunner;
	vcpus: number | null;
	needs: string[];
	status: CiStatus;
	conclusion: CiConclusion | null;
	error: string | null;
	steps: CiStep[];
	startedAt: string | null;
	finishedAt: string | null;
}

export interface CiRunSummary {
	number: number;
	workflow: string;
	path: string;
	event: CiEvent;
	branch: string;
	sha: string;
	/** The pull request it ran for. */
	pull: number | null;
	fromFork: boolean;
	actor: string | null;
	status: CiStatus;
	conclusion: CiConclusion | null;
	error: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface CiRun extends CiRunSummary {
	jobs: CiJob[];
}

export interface CiRunList {
	runs: CiRunSummary[];
	/** Pass as `before` for older runs; null at the end. */
	next: number | null;
}

/**
 * A pull request's checks on its head commit, as the server judges them for "require Actions to pass":
 * the same answer a merge gets.
 */
export interface PullChecks {
	/** The head commit they're for. */
	head: string;
	/** A branch rule on the base requires them to pass before merging. */
	required: boolean;
	/** `missing`: a workflow that should run for this head has no run (start it with POST …/checks). */
	state: "none" | "success" | "pending" | "waiting" | "missing" | "failure";
	/** What's counted: the newest run of each workflow and event on the head (push, pull request and manual runs alike). */
	runs: CiRunSummary[];
	/** Workflow files that should run for this pull request at this head, but haven't. */
	missing: string[];
	/** Why the checks stop a merge (when required), or null when they don't. */
	reason: string | null;
	/** The caller may start the missing runs. */
	canStart: boolean;
}

export interface CiLogChunk {
	seq: number;
	step: number;
	text: string;
}

export interface CiWorkflow {
	path: string;
	name: string;
	/** Why the file can't run, if it can't. */
	error: string | null;
	dispatch: boolean;
	/** Its cron schedules (UTC), if it runs on a schedule. */
	schedule: string[];
}

/** A file a run uploaded (actions/upload-artifact), kept for its retention days. */
export interface CiArtifact {
	id: string;
	name: string;
	/** Compressed (.tar.gz) size in bytes. */
	size: number;
	createdAt: string;
	expiresAt: string;
}

/** A saved cache (actions/cache). `scope` is the branch (or pull request) it was saved from. */
export interface CiCache {
	id: string;
	key: string;
	scope: string;
	size: number;
	createdAt: string;
	usedAt: string;
}

export interface CiSettings {
	/** What `runs-on: ubuntu-latest` (or no runs-on) means here. */
	defaultRunner: CiRunner;
	cloudflareAvailable: boolean;
	depot: { configured: boolean; orgId: string | null };
	/** Secret names; values are never shown again. */
	secrets: string[];
}
