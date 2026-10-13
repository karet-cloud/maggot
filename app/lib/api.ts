// Browser client for the megit API. Same origin; the session cookie set at login authenticates it.
import type {
	Branches,
	Commit,
	CommitDetail,
	Comparison,
	Diff,
	GitCredentials,
	Project,
	ProjectEvent,
	QueueEntry,
	RepoInfo,
	Task,
	TaskAccess,
	Tree,
	Viewer,
	Visibility,
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
	updateRepo: (project: string, patch: { visibility?: Visibility; description?: string | null }) =>
		call<{ repo: RepoInfo }>("PATCH", p(project), patch).then((r) => r.repo),
	deleteRepo: (project: string) => call<{ deleted: true }>("DELETE", p(project)),
	/** Commits files from the web editor; `content: null` deletes a file. */
	commitFiles: (
		project: string,
		input: {
			branch: string;
			baseCommit: string | null;
			newBranch?: string;
			message: string;
			/** `previousPath`: the file this one was renamed from, whose mode it keeps. */
			files: { path: string; content: string | null; previousPath?: string }[];
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
	tokens: ["tokens"] as const,
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
