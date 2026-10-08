import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ApiError, TaskStatus } from "./api.ts";
import { HttpError, toHttpError } from "./errors.ts";
import { assertProjectName } from "./names.ts";
import type { ProjectCoordinator, Registry } from "./project.ts";

export { ProjectCoordinator, Registry } from "./project.ts";

type App = { Bindings: Env };

const app = new Hono<App>();

app.use("/api/*", cors({ origin: (origin) => origin, allowHeaders: ["authorization", "content-type"], maxAge: 86400 }));

// Single shared API key for the MVP. WebSockets can't set headers from browsers, so `?key=` is accepted too.
app.use("/api/*", async (c, next) => {
	if (c.req.method === "OPTIONS") return next();
	const expected = c.env.MEGIT_API_KEY;
	if (!expected) throw new HttpError(500, "MISCONFIGURED", "MEGIT_API_KEY is not set");
	const header = c.req.header("authorization");
	const given = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("key");
	if (given !== expected) throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid API key");
	await next();
});

app.onError((err, c) => {
	const e = toHttpError(err);
	if (e.status >= 500) console.error(err);
	return c.json<ApiError>({ error: { code: e.code, message: e.detail } }, e.status as 500);
});

app.notFound((c) => c.json<ApiError>({ error: { code: "NOT_FOUND", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

app.get("/", (c) =>
	c.json({ name: "megit", description: "A Git platform for many concurrent agents, on Cloudflare Artifacts.", api: "/api" }),
);

// cloudflare.config.ts binds these by worker name, which the generated types can't resolve to a class.
const projects = (env: Env) => env.PROJECT as DurableObjectNamespace<ProjectCoordinator>;
const registry = (env: Env) => (env.REGISTRY as DurableObjectNamespace<Registry>).getByName("projects");
const project = (c: Context<App>) => projects(c.env).getByName(assertProjectName(c.req.param("project") ?? ""));

async function body<T>(c: Context<App>): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		throw new HttpError(400, "INVALID_INPUT", "Expected a JSON body");
	}
}

// ── Projects ─────────────────────────────────────────────────────────────────

app.get("/api/projects", async (c) => {
	const names = await registry(c.env).list();
	const found = await Promise.all(names.map((n) => projects(c.env).getByName(n).getProject().catch(() => null)));
	return c.json({ projects: found.filter((p) => p !== null) });
});

app.post("/api/projects", async (c) => {
	const input = await body<{ name: string; description?: string; defaultBranch?: string; importUrl?: string; importBranch?: string }>(c);
	const name = assertProjectName(input.name ?? "");
	const created = await projects(c.env).getByName(name).create({ ...input, name });
	await registry(c.env).add(name);
	return c.json({ project: created }, 201);
});

app.get("/api/projects/:project", async (c) => c.json({ project: await project(c).getProject() }));

app.delete("/api/projects/:project", async (c) => {
	await project(c).destroy();
	await registry(c.env).remove(c.req.param("project"));
	return c.json({ deleted: true });
});

app.get("/api/projects/:project/queue", async (c) => c.json({ queue: await project(c).queue() }));

app.get("/api/projects/:project/events", async (c) => {
	const events = await project(c).events(Number(c.req.query("after") ?? 0), Number(c.req.query("limit") ?? 100));
	return c.json({ events });
});

app.get("/api/projects/:project/live", async (c) => {
	if (c.req.header("upgrade") !== "websocket") throw new HttpError(426, "UPGRADE_REQUIRED", "Connect with a WebSocket");
	return project(c).fetch(c.req.raw);
});

app.get("/api/projects/:project/log", async (c) => {
	const commits = await project(c).log(c.req.query("ref"), Number(c.req.query("limit") ?? 50));
	return c.json({ commits });
});

app.get("/api/projects/:project/files/*", async (c) => {
	const prefix = `/api/projects/${c.req.param("project")}/files/`;
	const path = decodeURIComponent(c.req.path.slice(prefix.length));
	if (!path) throw new HttpError(400, "INVALID_INPUT", "File path is required");
	const file = await project(c).readFile(c.req.query("ref"), path);
	if (!file) throw new HttpError(404, "NOT_FOUND", `${path} not found`);
	return c.body(file.content, 200, { "content-type": file.contentType });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

app.get("/api/projects/:project/tasks", async (c) => {
	const tasks = await project(c).listTasks(c.req.query("status") as TaskStatus | undefined);
	return c.json({ tasks });
});

// Waits up to ?wait=<seconds> (default and max 25) for the fork. 201 with credentials once it exists,
// 202 with `fork: null` while the task is still provisioning (watch for `task.ready`).
app.post("/api/projects/:project/tasks", async (c) => {
	const input = await body<{ title: string; agent?: string; paths?: string[] }>(c);
	const wait = c.req.query("wait");
	const access = await project(c).createTask(input, wait === undefined ? undefined : Number(wait) * 1000);
	return c.json(access, access.fork ? 201 : 202);
});

app.get("/api/projects/:project/tasks/:task", async (c) => c.json({ task: await project(c).getTask(c.req.param("task")) }));

app.post("/api/projects/:project/tasks/:task/access", async (c) => c.json(await project(c).access(c.req.param("task"))));

app.post("/api/projects/:project/tasks/:task/submit", async (c) => c.json({ task: await project(c).submit(c.req.param("task")) }, 202));

app.post("/api/projects/:project/tasks/:task/abandon", async (c) => c.json({ task: await project(c).abandon(c.req.param("task")) }));

export default app satisfies ExportedHandler<Env>;
