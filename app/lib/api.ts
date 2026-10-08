// Browser client for the megit API. Same origin; the session cookie set at login authenticates it.
import type { Commit, GitCredentials, Project, ProjectEvent, QueueEntry, Task, TaskAccess, Tree } from "../../src/api.ts";

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
		const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
		throw new ApiError(res.status, json?.error?.code ?? "HTTP_ERROR", json?.error?.message ?? res.statusText);
	}
	return (await res.json()) as T;
}

const p = (project: string) => `/projects/${encodeURIComponent(project)}`;

export const api = {
	session: () => call<{ ok: true }>("GET", "/session"),
	login: (key: string) => call<{ ok: true }>("POST", "/session", { key }),
	logout: () => call<{ ok: true }>("DELETE", "/session"),

	projects: () => call<{ projects: Project[] }>("GET", "/projects").then((r) => r.projects),
	createProject: (input: { name: string; description?: string; importUrl?: string; importBranch?: string; readme?: boolean }) =>
		call<{ project: Project }>("POST", "/projects", input).then((r) => r.project),
	project: (project: string) => call<{ project: Project }>("GET", p(project)).then((r) => r.project),
	credentials: (project: string, scope: "read" | "write" = "write") =>
		call<GitCredentials>("POST", `${p(project)}/credentials`, { scope }),
	deleteProject: (project: string) => call<{ deleted: true }>("DELETE", p(project)),

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
	liveUrl: (project: string, after: number) => {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		return `${proto}//${location.host}/api${p(project)}/live?after=${after}`;
	},
};

/** Query keys, so live events can invalidate exactly what changed. */
export const keys = {
	projects: ["projects"] as const,
	project: (project: string) => ["project", project] as const,
	tasks: (project: string) => ["project", project, "tasks"] as const,
	task: (project: string, id: string) => ["project", project, "task", id] as const,
	queue: (project: string) => ["project", project, "queue"] as const,
	events: (project: string) => ["events", project] as const,
	log: (project: string, ref?: string) => ["project", project, "log", ref ?? ""] as const,
	code: (project: string) => ["project", project, "code"] as const,
};
