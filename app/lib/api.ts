// Browser client for the megit API. Same origin; the session cookie set at login authenticates it.
import type {
	Branches,
	CodeSearch,
	Commit,
	CommitDetail,
	FileList,
	MergeMethod,
	Collaborator,
	Invitation,
	Org,
	OrgRole,
	Permission,
	Pull,
	PullList,
	Review,
	ReviewComment,
	ReviewState,
	Blame,
	FileHistory,
	BranchRule,
	Graph,
	Issue,
	IssueComment,
	IssueList,
	IssueState,
	Release,
	Tag,
	Comparison,
	Diff,
	GitCredentials,
	Project,
	ProjectEvent,
	QueueEntry,
	RepoInfo,
	RepoTransfer,
	SshInfo,
	SshKey,
	Task,
	TaskAccess,
	Tree,
	Viewer,
	Visibility,
	Webhook,
	WebhookDelivery,
	WebhookEvent,
	Notification,
} from "../../src/api.ts";

export type * from "../../src/api.ts";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method,
		credentials: "same-origin",
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		// Our API nests errors under `error`; Better Auth's /auth routes return { code, message } at the top.
		const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string }; code?: string; message?: string } | null;
		throw new ApiError(res.status, json?.error?.code ?? json?.code ?? "HTTP_ERROR", json?.error?.message ?? json?.message ?? res.statusText);
	}
	return (await res.json()) as T;
}

/** `project` is a repository's full name, `owner/repo`. */
const p = (project: string) => `/repos/${project.split("/").map(encodeURIComponent).join("/")}`;

/** Route params for a repository's full name. */
export function repoParams(project: string): { owner: string; repo: string } {
	const [owner = "", repo = ""] = project.split("/");
	return { owner, repo };
}

export interface TokenInfo {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export interface RepoFilter {
	owner?: string;
	/** A username: the repositories they starred. */
	starredBy?: string;
	q?: string;
	sort?: "created" | "stars";
}

export interface CreateRepoInput {
	name: string;
	description?: string;
	visibility: Visibility;
	defaultBranch?: string;
	importUrl?: string;
	readme?: boolean;
	/** An organization to create it in. */
	owner?: string;
}

export const api = {
	me: () => call<{ user: Viewer | null }>("GET", "/me").then((r) => r.user),
	signUp: (input: { email: string; password: string; name: string; username: string }) =>
		call<unknown>("POST", "/auth/sign-up/email", { ...input, callbackURL: "/verify-email" }),
	signIn: (input: { username: string; password: string }) => call<unknown>("POST", "/auth/sign-in/username", input),
	signOut: () => call<unknown>("POST", "/auth/sign-out", {}),
	config: () => call<{ emailDelivery: boolean; verificationRequired: boolean }>("GET", "/config"),
	resendVerification: (email: string) => call<unknown>("POST", "/auth/send-verification-email", { email, callbackURL: "/verify-email" }),
	requestPasswordReset: (email: string) => call<unknown>("POST", "/auth/request-password-reset", { email, redirectTo: "/reset-password" }),
	resetPassword: (token: string, newPassword: string) => call<unknown>("POST", "/auth/reset-password", { token, newPassword }),
	changePassword: (currentPassword: string, newPassword: string) =>
		call<unknown>("POST", "/auth/change-password", { currentPassword, newPassword, revokeOtherSessions: true }),

	repos: (filter: string | RepoFilter = {}) => {
		const f: RepoFilter = typeof filter === "string" ? { owner: filter } : filter;
		const q = new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => Boolean(e[1])));
		return call<{ repos: RepoInfo[] }>("GET", `/repos${q.size ? `?${q}` : ""}`).then((r) => r.repos);
	},
	createRepo: (input: CreateRepoInput) => call<{ repo: RepoInfo }>("POST", "/repos", input).then((r) => r.repo),
	/** The repository's Git state (head, task counts) with its settings, which win where both have a field. */
	project: (project: string) =>
		call<{ project: Project; repo: RepoInfo }>("GET", p(project)).then(({ project: info, repo }) => ({
			...info,
			description: repo.description,
			defaultBranch: repo.defaultBranch,
			repo,
		})),
	updateRepo: (project: string, patch: { visibility?: Visibility; description?: string | null; name?: string; archived?: boolean }) =>
		call<{ repo: RepoInfo }>("PATCH", p(project), patch).then((r) => r.repo),
	deleteRepo: (project: string) => call<{ deleted: true }>("DELETE", p(project)),
	fileHistory: (project: string, path: string, ref?: string, from?: string) =>
		call<FileHistory>("GET", `${p(project)}/history?${new URLSearchParams({ path, ...(ref ? { ref } : {}), ...(from ? { from } : {}) })}`),
	blame: (project: string, path: string, ref?: string) => call<Blame>("GET", `${p(project)}/blame?${new URLSearchParams({ path, ...(ref ? { ref } : {}) })}`),
	/** Every file path at a ref, for "Go to file". */
	paths: (project: string, ref?: string) => call<FileList>("GET", `${p(project)}/paths${ref ? `?${new URLSearchParams({ ref })}` : ""}`),
	transfer: (project: string) => call<{ transfer: RepoTransfer | null }>("GET", `${p(project)}/transfer`).then((r) => r.transfer),
	offerTransfer: (project: string, to: string) => call<{ transfer: RepoTransfer }>("POST", `${p(project)}/transfer`, { to }).then((r) => r.transfer),
	cancelTransfer: (project: string) => call<{ deleted: true }>("DELETE", `${p(project)}/transfer`),
	transfers: () => call<{ transfers: RepoTransfer[] }>("GET", "/transfers").then((r) => r.transfers),
	acceptTransfer: (id: string, name?: string) => call<{ repo: RepoInfo }>("POST", `/transfers/${encodeURIComponent(id)}/accept`, name ? { name } : {}).then((r) => r.repo),
	declineTransfer: (id: string) => call<{ deleted: true }>("POST", `/transfers/${encodeURIComponent(id)}/decline`, {}),
	tags: (project: string, summaries = true) => call<{ tags: Tag[] }>("GET", `${p(project)}/tags${summaries ? "" : "?summary=0"}`).then((r) => r.tags),
	createTag: (project: string, name: string, target?: string) => call<{ tag: Tag }>("POST", `${p(project)}/tags`, { name, target }).then((r) => r.tag),
	deleteTag: (project: string, name: string) =>
		call<{ deleted: true }>("DELETE", `${p(project)}/tags/${name.split("/").map(encodeURIComponent).join("/")}`),
	releases: (project: string, limit = 20) => call<{ releases: Release[]; more: boolean }>("GET", `${p(project)}/releases?limit=${limit}`),
	createRelease: (project: string, input: { tag: string; target?: string; name?: string; notes?: string; prerelease?: boolean }) =>
		call<{ release: Release }>("POST", `${p(project)}/releases`, input).then((r) => r.release),
	updateRelease: (project: string, id: string, patch: { name?: string; notes?: string; prerelease?: boolean }) =>
		call<{ release: Release }>("PATCH", `${p(project)}/releases/${encodeURIComponent(id)}`, patch).then((r) => r.release),
	deleteRelease: (project: string, id: string, deleteTag = false) =>
		call<{ deleted: true }>("DELETE", `${p(project)}/releases/${encodeURIComponent(id)}${deleteTag ? "?deleteTag" : ""}`),
	graph: (project: string, limit = 150) => call<Graph>("GET", `${p(project)}/graph?limit=${limit}`),
	branchRules: (project: string) => call<{ rules: BranchRule[] }>("GET", `${p(project)}/protection`).then((r) => r.rules),
	setBranchRule: (project: string, rule: Omit<BranchRule, "createdAt">) =>
		call<{ rules: BranchRule[] }>("PUT", `${p(project)}/protection`, rule).then((r) => r.rules),
	deleteBranchRule: (project: string, pattern: string) =>
		call<{ rules: BranchRule[] }>("DELETE", `${p(project)}/protection?${new URLSearchParams({ pattern })}`).then((r) => r.rules),
	issues: (project: string, filter: { state?: IssueState | "all"; q?: string; label?: string } = {}) =>
		call<IssueList>("GET", `${p(project)}/issues?${new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])))}`),
	issue: (project: string, number: number) => call<{ issue: Issue; comments: IssueComment[]; earlier: boolean }>("GET", `${p(project)}/issues/${number}`),
	earlierComments: (project: string, number: number, before: string) =>
		call<{ comments: IssueComment[]; earlier: boolean }>("GET", `${p(project)}/issues/${number}/comments?${new URLSearchParams({ before })}`),
	createIssue: (project: string, input: { title: string; body: string; labels?: string[] }) =>
		call<{ issue: Issue }>("POST", `${p(project)}/issues`, input).then((r) => r.issue),
	updateIssue: (project: string, number: number, patch: { title?: string; body?: string; state?: IssueState; labels?: string[] }) =>
		call<{ issue: Issue }>("PATCH", `${p(project)}/issues/${number}`, patch).then((r) => r.issue),
	comment: (project: string, number: number, body: string, state?: IssueState) =>
		call<{ comment: IssueComment; issue: Issue }>("POST", `${p(project)}/issues/${number}/comments`, { body, state }),
	editComment: (project: string, number: number, id: string, body: string) =>
		call<{ comment: IssueComment }>("PATCH", `${p(project)}/issues/${number}/comments/${encodeURIComponent(id)}`, { body }).then((r) => r.comment),
	deleteComment: (project: string, number: number, id: string) =>
		call<{ deleted: true }>("DELETE", `${p(project)}/issues/${number}/comments/${encodeURIComponent(id)}`),
	pulls: (project: string, filter: { state?: "open" | "closed" | "all"; q?: string } = {}) =>
		call<PullList>("GET", `${p(project)}/pulls?${new URLSearchParams(Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])))}`),
	pull: (project: string, number: number) =>
		call<{ pull: Pull; comments: IssueComment[]; earlier: boolean; reviews: Review[]; reviewComments: ReviewComment[] }>("GET", `${p(project)}/pulls/${number}`),
	pullFiles: (project: string, number: number) => call<{ comparison: Comparison }>("GET", `${p(project)}/pulls/${number}/files`).then((r) => r.comparison),
	pullPreview: (project: string, base: string, head: string, headRepo?: string) =>
		call<{ comparison: Comparison }>("GET", `${p(project)}/pulls/compare?${new URLSearchParams({ base, head, ...(headRepo ? { headRepo } : {}) })}`).then((r) => r.comparison),
	createPull: (project: string, input: { title: string; body: string; base: string; head: string; headRepo?: string }) =>
		call<{ pull: Pull }>("POST", `${p(project)}/pulls`, input).then((r) => r.pull),
	review: (project: string, number: number, input: { state: ReviewState; body: string; commit?: string; comments: { path: string; line: number; side: "new" | "old"; body: string }[] }) =>
		call<{ review: string }>("POST", `${p(project)}/pulls/${number}/reviews`, input),
	mergePull: (project: string, number: number, method: MergeMethod) => call<{ pull: Pull; commit: string }>("POST", `${p(project)}/pulls/${number}/merge`, { method }),
	myOrgs: () => call<{ orgs: { name: string; displayName: string; role: OrgRole }[] }>("GET", "/orgs").then((r) => r.orgs),
	createOrg: (name: string, displayName: string) => call<{ org: Org }>("POST", "/orgs", { name, displayName }).then((r) => r.org),
	org: (name: string) => call<{ org: Org }>("GET", `/orgs/${encodeURIComponent(name)}`).then((r) => r.org),
	deleteOrg: (name: string) => call<{ deleted: true }>("DELETE", `/orgs/${encodeURIComponent(name)}`),
	inviteMember: (org: string, username: string, role: OrgRole) => call<{ org: Org }>("POST", `/orgs/${encodeURIComponent(org)}/members`, { username, role }).then((r) => r.org),
	setMemberRole: (org: string, username: string, role: OrgRole) =>
		call<{ org: Org }>("PATCH", `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`, { role }).then((r) => r.org),
	removeMember: (org: string, username: string) => call<{ org: Org }>("DELETE", `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`).then((r) => r.org),
	createTeam: (org: string, name: string) => call<{ org: Org }>("POST", `/orgs/${encodeURIComponent(org)}/teams`, { name }).then((r) => r.org),
	deleteTeam: (org: string, team: string) => call<{ org: Org }>("DELETE", `/orgs/${encodeURIComponent(org)}/teams/${team}`).then((r) => r.org),
	setTeamMember: (org: string, team: string, username: string, member: boolean) =>
		call<{ org: Org }>(member ? "PUT" : "DELETE", `/orgs/${encodeURIComponent(org)}/teams/${team}/members/${encodeURIComponent(username)}`).then((r) => r.org),
	setTeamRepo: (org: string, team: string, repo: string, permission: Permission | null) =>
		call<{ org: Org }>(permission ? "PUT" : "DELETE", `/orgs/${encodeURIComponent(org)}/teams/${team}/repos/${encodeURIComponent(repo)}`, permission ? { permission } : undefined).then((r) => r.org),
	collaborators: (project: string) => call<{ collaborators: Collaborator[] }>("GET", `${p(project)}/collaborators`).then((r) => r.collaborators),
	setCollaborator: (project: string, username: string, permission: Permission) =>
		call<{ collaborators: Collaborator[] }>("PUT", `${p(project)}/collaborators/${encodeURIComponent(username)}`, { permission }).then((r) => r.collaborators),
	removeCollaborator: (project: string, username: string) =>
		call<{ collaborators: Collaborator[] }>("DELETE", `${p(project)}/collaborators/${encodeURIComponent(username)}`).then((r) => r.collaborators),
	invitations: () => call<{ invitations: Invitation[] }>("GET", "/invitations").then((r) => r.invitations),
	answerInvitation: (invitation: Invitation, accept: boolean) =>
		call<{ ok: true }>("POST", `/invitations/${invitation.kind}/${encodeURIComponent(invitation.id)}/${accept ? "accept" : "decline"}`),
	ssh: () => call<SshInfo>("GET", "/ssh"),
	sshKeys: () => call<{ keys: SshKey[] }>("GET", "/ssh/keys").then((r) => r.keys),
	addSshKey: (key: string, name?: string) => call<{ key: SshKey }>("POST", "/ssh/keys", { key, name }).then((r) => r.key),
	deleteSshKey: (id: string) => call<{ deleted: true }>("DELETE", `/ssh/keys/${encodeURIComponent(id)}`),
	searchCode: (project: string, q: string) => call<CodeSearch>("GET", `${p(project)}/search?${new URLSearchParams({ q })}`),
	hooks: (project: string) => call<{ hooks: Webhook[] }>("GET", `${p(project)}/hooks`).then((r) => r.hooks),
	createHook: (project: string, input: { url: string; secret: string; events: WebhookEvent[] }) =>
		call<{ hook: Webhook }>("POST", `${p(project)}/hooks`, input).then((r) => r.hook),
	updateHook: (project: string, id: string, patch: { active?: boolean; events?: WebhookEvent[] }) =>
		call<{ hook: Webhook }>("PATCH", `${p(project)}/hooks/${id}`, patch).then((r) => r.hook),
	deleteHook: (project: string, id: string) => call<{ deleted: true }>("DELETE", `${p(project)}/hooks/${id}`),
	deliveries: (project: string, id: string) => call<{ deliveries: WebhookDelivery[] }>("GET", `${p(project)}/hooks/${id}/deliveries`).then((r) => r.deliveries),
	pingHook: (project: string, id: string) => call<{ delivery: WebhookDelivery }>("POST", `${p(project)}/hooks/${id}/ping`),
	redeliver: (project: string, id: string, delivery: string) =>
		call<{ delivery: WebhookDelivery }>("POST", `${p(project)}/hooks/${id}/deliveries/${delivery}/redeliver`),
	notifications: (unread = false) => call<{ notifications: Notification[]; unread: number }>("GET", `/notifications${unread ? "?unread" : ""}`),
	markRead: (ids?: string[]) => call<{ ok: true }>("POST", "/notifications/read", ids ? { ids } : {}),

	/** Commits files from the web editor; `content: null` deletes a file. */
	commitFiles: (
		project: string,
		input: {
			branch: string;
			baseCommit: string | null;
			newBranch?: string;
			message: string;
			/** `previousPath`: the file this one was renamed from, whose mode it keeps. */
			files: { path: string; content: string | null; previousPath?: string; encoding?: "base64" }[];
		},
	) => call<{ commit: string; branch: string }>("POST", `${p(project)}/contents`, input),
	star: (project: string, starred: boolean) => call<{ starred: boolean; stars: number }>(starred ? "PUT" : "DELETE", `${p(project)}/star`),
	forks: (project: string) => call<{ repos: RepoInfo[] }>("GET", `${p(project)}/forks`).then((r) => r.repos),
	fork: (project: string, name: string) => call<{ repo: RepoInfo }>("POST", `${p(project)}/forks`, { name }).then((r) => r.repo),

	tokens: () => call<{ tokens: TokenInfo[] }>("GET", "/tokens").then((r) => r.tokens),
	createToken: (name: string) => call<{ token: string; info: TokenInfo }>("POST", "/tokens", { name }),
	revokeToken: (id: string) => call<{ deleted: true }>("DELETE", `/tokens/${id}`),

	tasks: (project: string) => call<{ tasks: Task[] }>("GET", `${p(project)}/tasks`).then((r) => r.tasks),
	task: (project: string, id: string) => call<{ task: Task }>("GET", `${p(project)}/tasks/${id}`).then((r) => r.task),
	createTask: (project: string, input: { title: string; agent?: string; paths?: string[] }) =>
		call<TaskAccess>("POST", `${p(project)}/tasks?wait=0`, input),
	access: (project: string, id: string) => call<TaskAccess>("POST", `${p(project)}/tasks/${id}/access`),
	submit: (project: string, id: string) => call<{ task: Task }>("POST", `${p(project)}/tasks/${id}/submit`).then((r) => r.task),
	abandon: (project: string, id: string) => call<{ task: Task }>("POST", `${p(project)}/tasks/${id}/abandon`).then((r) => r.task),

	queue: (project: string) => call<{ queue: QueueEntry[] }>("GET", `${p(project)}/queue`).then((r) => r.queue),
	events: (project: string, limit = 200) =>
		call<{ events: ProjectEvent[] }>("GET", `${p(project)}/events?limit=${limit}`).then((r) => r.events),
	log: (project: string, ref?: string, limit = 50) =>
		call<{ commits: Commit[] }>("GET", `${p(project)}/log?${new URLSearchParams({ limit: String(limit), ...(ref ? { ref } : {}) })}`).then(
			(r) => r.commits,
		),
	tree: (project: string, path: string, ref?: string) =>
		call<{ tree: Tree }>("GET", `${p(project)}/tree?${new URLSearchParams({ path, ...(ref ? { ref } : {}) })}`).then((r) => r.tree),
	file: async (project: string, path: string, ref?: string) => {
		const q = ref ? `?${new URLSearchParams({ ref })}` : "";
		const res = await fetch(`/api${p(project)}/files/${path.split("/").map(encodeURIComponent).join("/")}${q}`);
		if (!res.ok) {
			const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
			throw new ApiError(res.status, json?.error?.code ?? "HTTP_ERROR", json?.error?.message ?? res.statusText);
		}
		return res.text();
	},
	commit: (project: string, hash: string, ref?: string) =>
		call<{ commit: CommitDetail; diff: Diff }>("GET", `${p(project)}/commits/${hash}${ref ? `?${new URLSearchParams({ ref })}` : ""}`),
	compare: (project: string, base: string, head: string) =>
		call<{ comparison: Comparison }>("GET", `${p(project)}/compare?${new URLSearchParams({ base, head })}`).then((r) => r.comparison),
	taskChanges: (project: string, id: string) =>
		call<{ comparison: Comparison }>("GET", `${p(project)}/tasks/${id}/changes`).then((r) => r.comparison),
	branches: (project: string, counts = true) => call<Branches>("GET", `${p(project)}/branches${counts ? "" : "?counts=0"}`),
	deleteBranch: (project: string, name: string) =>
		call<{ deleted: true }>("DELETE", `${p(project)}/branches/${name.split("/").map(encodeURIComponent).join("/")}`),
	/** Plain URLs (the session cookie authenticates them), for links, images and downloads. */
	rawUrl: (project: string, path: string, ref?: string, download?: boolean) =>
		`/api${p(project)}/raw?${new URLSearchParams({ path, ...(ref ? { ref } : {}), ...(download ? { download: "1" } : {}) })}`,
	archiveUrl: (project: string, format: "tar.gz" | "zip", ref?: string) =>
		`/api${p(project)}/archive?${new URLSearchParams({ format, ...(ref ? { ref } : {}) })}`,
	liveUrl: (project: string, after: number) => {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		return `${proto}//${location.host}/api${p(project)}/live?after=${after}`;
	},
};

/** Query keys, so live events can invalidate exactly what changed. */
export const keys = {
	me: ["me"] as const,
	config: ["config"] as const,
	repos: (filter: string | RepoFilter = "") => ["repos", filter] as const,
	forks: (project: string) => ["project", project, "forks"] as const,
	hooks: (project: string) => ["project", project, "hooks"] as const,
	deliveries: (project: string, id: string) => ["project", project, "hooks", id] as const,
	search: (project: string, q: string) => ["project", project, "search", q] as const,
	notifications: ["notifications"] as const,
	tokens: ["tokens"] as const,
	ssh: ["ssh"] as const,
	sshKeys: ["ssh", "keys"] as const,
	transfers: ["transfers"] as const,
	invitations: ["invitations"] as const,
	myOrgs: ["orgs", "mine"] as const,
	org: (name: string) => ["orgs", name] as const,
	collaborators: (project: string) => ["project", project, "collaborators"] as const,
	transfer: (project: string) => ["project", project, "transfer"] as const,
	paths: (project: string, ref?: string) => ["project", project, "paths", ref ?? ""] as const,
	fileHistory: (project: string, path: string, ref?: string) => ["project", project, "file-history", path, ref ?? ""] as const,
	blame: (project: string, path: string, ref?: string) => ["project", project, "blame", path, ref ?? ""] as const,
	tags: (project: string) => ["project", project, "tags"] as const,
	tagNames: (project: string) => ["project", project, "tags", "names"] as const,
	releases: (project: string) => ["project", project, "releases"] as const,
	graph: (project: string) => ["project", project, "graph"] as const,
	branchRules: (project: string) => ["project", project, "protection"] as const,
	issues: (project: string) => ["project", project, "issues"] as const,
	pulls: (project: string) => ["project", project, "pulls"] as const,
	pull: (project: string, number: number) => ["project", project, "pulls", number] as const,
	pullFiles: (project: string, number: number) => ["project", project, "pulls", number, "files"] as const,
	issue: (project: string, number: number) => ["project", project, "issues", number] as const,
	projects: ["projects"] as const,
	project: (project: string) => ["project", project] as const,
	tasks: (project: string) => ["project", project, "tasks"] as const,
	task: (project: string, id: string) => ["project", project, "task", id] as const,
	queue: (project: string) => ["project", project, "queue"] as const,
	events: (project: string) => ["events", project] as const,
	log: (project: string, ref?: string) => ["project", project, "log", ref ?? ""] as const,
	code: (project: string) => ["project", project, "code"] as const,
	branches: (project: string) => ["project", project, "branches"] as const,
	commit: (project: string, hash: string) => ["commit", project, hash] as const,
	compare: (project: string, base: string, head: string) => ["project", project, "compare", base, head] as const,
	taskChanges: (project: string, id: string) => ["project", project, "task", id, "changes"] as const,
};
