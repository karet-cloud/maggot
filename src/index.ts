import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ApiError, Project, RepoInfo, TaskStatus, Visibility } from "./api.ts";
import { archiveStream, listFiles, type ArchiveFormat } from "./archive.ts";
import { auth, canRead, canWrite, issueLink, requireVerified, resolvePrincipal, type Principal } from "./auth.ts";
import {
	assertRepoName,
	createToken,
	db,
	deleteRepo,
	ensureSchema,
	findRepo,
	insertRepo,
	listRepos,
	listTokens,
	revokeToken,
	setRepoBytes,
	toRepoInfo,
	updateRepo,
	type RepoRow,
} from "./db.ts";
import { HttpError, toHttpError } from "./errors.ts";
import { emailConfigured } from "./mail.ts";
import { assertProjectName } from "./names.ts";
import { measureRepository } from "./git/protocol.ts";
import { assertCanCreateRepo, clientIp, formatBytes, guardCredentials, limit, pushBlocked, policy, RateLimited, rules, usage, verificationRequired } from "./policy.ts";
import type { ProjectCoordinator, Registry } from "./project.ts";
import { repoStore } from "./store.ts";

export { Limiter } from "./policy.ts";
export { ProjectCoordinator, Registry } from "./project.ts";

type Vars = { principal: Principal; projectId: string; repo: RepoRow | null };
type App = { Bindings: Env; Variables: Vars };

const app = new Hono<App>();

// Bearer-token clients (agents, scripts) may call from anywhere; cookies are never sent cross-origin
// with credentials because allowCredentials is off.
app.use("/api/*", cors({ origin: (origin) => origin, allowHeaders: ["authorization", "content-type"], maxAge: 86400 }));

// Sign-ups, sign-ins and outgoing email are limited per IP address; sign-ins also per account, so
// guessing one account's password from many addresses is slow too.
app.use("/api/auth/*", async (c, next) => {
	if (c.req.method !== "POST") return next();
	// Better Auth also takes form bodies; only JSON is accepted, so the limits below always see the fields.
	if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send a JSON body");
	}
	const p = policy(c.env);
	const ip = `ip:${clientIp(c.req.raw)}`;
	const action = c.req.path.slice("/api/auth/".length);
	const fields = (await c.req.raw.clone().json().catch(() => ({}))) as Record<string, unknown>;
	const field = (name: string) => {
		const value = fields?.[name];
		return typeof value === "string" ? value.trim().toLowerCase() : "";
	};
	if (action === "sign-up/email") {
		await limit(c.env, ip, rules.signUp(p), "Too many accounts created from your network");
	} else if (action === "sign-in/username" || action === "sign-in/email") {
		// The field the endpoint signs in with, resolved to the account, so a username and its email share one budget.
		const given = field(action === "sign-in/username" ? "username" : "email");
		await limit(c.env, ip, rules.signInIp(p), "Too many sign-in attempts");
		if (given) {
			await ensureSchema(db(c.env));
			const user = await db(c.env).prepare(`select "id" from "user" where "username" = ? or "email" = ?`).bind(given, given).first<{ id: string }>();
			await limit(c.env, `account:${user?.id ?? given}`, rules.signInAccount(p), "Too many sign-in attempts for this account");
		}
	} else if (action.startsWith("sign-in/")) {
		throw new HttpError(404, "NOT_FOUND", "Sign in with a username or email and password");
	} else if (action === "update-user" && ["username", "displayUsername", "email"].some((k) => k in (fields ?? {}))) {
		// Repository URLs are owner/name; renaming would need every repository moved and the old name held.
		throw new HttpError(400, "IMMUTABLE_USERNAME", "Usernames and email addresses can't be changed yet");
	} else if (action === "request-password-reset" || action === "send-verification-email") {
		const email = field("email");
		await limit(c.env, ip, rules.email(p), "Too many emails requested");
		if (email) await limit(c.env, `email:${email}`, rules.email(p), "Too many emails sent to this address");
	} else {
		await limit(c.env, ip, rules.api(p, true));
	}
	return next();
});

// Better Auth: sign-up, sign-in, sign-out, session. It does its own origin checks.
app.on(["GET", "POST"], "/api/auth/*", async (c) => (await auth(c.env, c.req.raw)).handler(c.req.raw));

app.use("/api/*", async (c, next) => {
	if (c.req.method === "OPTIONS") return next();
	const principal = await guardCredentials(c.env, c.req.raw, () => resolvePrincipal(c.env, c.req.raw));
	c.set("principal", principal);
	// The admin key (agents, scripts) isn't limited. Signed-out callers are, by address; signed-in
	// people only for writes, so browsing costs no extra round trip.
	const write = !["GET", "HEAD"].includes(c.req.method);
	if (principal.kind === "anonymous" || (principal.kind === "user" && write)) {
		const subject = principal.kind === "user" ? `user:${principal.id}` : `ip:${clientIp(c.req.raw)}`;
		await limit(c.env, subject, rules.api(policy(c.env), write));
	}
	// Browsers attach the session cookie on their own, so anything it authorizes beyond a read must come
	// from this origin. Tokens aren't sent automatically, so they skip the check.
	if (principal.kind === "user" && principal.via === "session") {
		if (!["GET", "HEAD"].includes(c.req.method) || c.req.header("upgrade") === "websocket") requireSameOrigin(c);
	}
	return next();
});

/** Rejects browser requests from another origin (including same-site siblings that SameSite lets through). */
function requireSameOrigin(c: Context<App>) {
	const origin = c.req.header("origin");
	if (origin !== undefined && origin !== new URL(c.req.url).origin) {
		throw new HttpError(403, "FORBIDDEN", "Cross-origin request refused");
	}
	if (origin === undefined && c.req.header("sec-fetch-site") === "cross-site") {
		throw new HttpError(403, "FORBIDDEN", "Cross-origin request refused");
	}
}

function requireUser(c: Context<App>): Extract<Principal, { kind: "user" }> {
	const p = c.var.principal;
	if (p.kind !== "user") throw new HttpError(401, "UNAUTHORIZED", "Sign in first");
	return p;
}

function requireAdmin(c: Context<App>) {
	if (c.var.principal.kind !== "admin") throw new HttpError(401, "UNAUTHORIZED", "This endpoint needs the admin API key");
}

app.onError((err, c) => {
	const e = toHttpError(err);
	if (e.status >= 500) console.error(err);
	if (err instanceof RateLimited) c.header("retry-after", String(err.retryAfter));
	return c.json<ApiError>({ error: { code: e.code, message: e.detail } }, e.status as 500);
});

app.notFound((c) => c.json<ApiError>({ error: { code: "NOT_FOUND", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

app.get("/api", (c) => c.json({ name: "megit", description: "A Git platform for people and many concurrent agents, on Cloudflare Artifacts." }));

// cloudflare.config.ts binds these by worker name, which the generated types can't resolve to a class.
const projects = (env: Env) => env.PROJECT as DurableObjectNamespace<ProjectCoordinator>;
const registry = (env: Env) => (env.REGISTRY as DurableObjectNamespace<Registry>).getByName("projects");
const project = (c: Context<App>) => projects(c.env).getByName(c.var.projectId);

/** Headers that keep repository content from running as a page on this origin. */
const INERT = {
	"content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
	"x-content-type-options": "nosniff",
};

/** A whole number in [min, max] from a query parameter, or `fallback` when absent or malformed. */
function intParam(value: string | undefined, fallback: number, max: number, min = 1): number {
	const n = Number(value);
	if (value === undefined || value === "" || !Number.isInteger(n) || n < min) return fallback;
	return Math.min(n, max);
}

/**
 * The rest of a per-repository route's path after `segment` (such as "/files/"), decoded. The
 * repository prefix is skipped by position, so an owner or repository named like a segment can't
 * be mistaken for it.
 */
function routeRest(c: Context<App>, segment: string): string {
	const prefixSegments = c.req.param("owner") === undefined ? 4 : 5; // "", "api", "projects", p | "", "api", "repos", owner, repo
	const rest = `/${c.req.path.split("/").slice(prefixSegments).join("/")}`;
	return rest.startsWith(segment) ? decodeURIComponent(rest.slice(segment.length)) : "";
}

async function body<T>(c: Context<App>): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		throw new HttpError(400, "INVALID_INPUT", "Expected a JSON body");
	}
}

const origin = (c: Context<App>) => new URL(c.req.url).origin;

// ── Accounts ─────────────────────────────────────────────────────────────────

app.get("/api/me", async (c) => {
	const p = c.var.principal;
	if (p.kind === "admin") return c.json({ user: null, admin: true });
	if (p.kind !== "user") return c.json({ user: null, admin: false });
	const database = db(c.env);
	const [row, used] = await Promise.all([
		database.prepare(`select "name", "email" from "user" where "id" = ?`).bind(p.id).first<{ name: string; email: string }>(),
		usage(database, p.id),
	]);
	const limits = policy(c.env);
	return c.json({
		user: {
			id: p.id,
			username: p.username,
			name: row?.name ?? p.username,
			email: row?.email ?? "",
			emailVerified: p.verified,
			usage: { ...used, maxRepos: limits.reposPerUser, maxBytes: limits.userBytes },
		},
		admin: false,
	});
});

/** What the sign-in pages need to know about this server, e.g. whether reset emails actually go out. */
app.get("/api/config", (c) => c.json({ emailDelivery: emailConfigured(c.env), verificationRequired: verificationRequired(c.env) }));

// Without email delivery, an admin can look a user up and hand them a one-time link: a password reset
// (valid an hour) or an email verification (valid a day).
for (const [path, kind, expiresInSeconds] of [
	["/api/admin/password-reset", "reset", 3600],
	["/api/admin/verify-email", "verify", 24 * 3600],
] as const) {
	app.post(path, async (c) => {
		requireAdmin(c);
		const { username, email } = await body<{ username?: string; email?: string }>(c);
		await ensureSchema(db(c.env));
		const row = await db(c.env)
			.prepare(`select "email" from "user" where "username" = ? or "email" = ?`)
			.bind(username?.trim().toLowerCase() ?? "", email?.trim().toLowerCase() ?? "")
			.first<{ email: string }>();
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such user");
		const link = await issueLink(c.env, c.req.raw, kind, row.email);
		if (!link) {
			throw kind === "verify"
				? new HttpError(409, "ALREADY_VERIFIED", "That email address is already verified")
				: new HttpError(500, "LINK_FAILED", "Couldn't issue a reset link");
		}
		return c.json({ url: link, expiresInSeconds });
	});
}

app.get("/api/tokens", async (c) => c.json({ tokens: await listTokens(db(c.env), requireUser(c).id) }));

app.post("/api/tokens", async (c) => {
	const user = requireUser(c);
	const { name } = await body<{ name?: string }>(c);
	const label = name?.trim().slice(0, 80);
	if (!label) throw new HttpError(400, "INVALID_INPUT", "Give the token a name");
	const { token, info } = await createToken(db(c.env), user.id, label);
	return c.json({ token, info }, 201);
});

app.delete("/api/tokens/:id", async (c) => {
	const removed = await revokeToken(db(c.env), requireUser(c).id, c.req.param("id"));
	if (!removed) throw new HttpError(404, "NOT_FOUND", "No such token");
	return c.json({ deleted: true });
});

// ── Repositories ─────────────────────────────────────────────────────────────

/** Public repositories (and the caller's own private ones), optionally for one owner. */
app.get("/api/repos", async (c) => {
	await ensureSchema(db(c.env));
	const p = c.var.principal;
	const owner = c.req.query("owner");
	const rows = await listRepos(db(c.env), { owner, viewerId: p.kind === "user" ? p.id : null, limit: intParam(c.req.query("limit"), 100, 500) });
	return c.json({ repos: rows.map((r) => toRepoInfo(r, origin(c), canWrite(p, r))) });
});

app.post("/api/repos", async (c) => {
	const user = requireUser(c);
	requireVerified(c.env, user);
	const input = await body<{
		name?: string;
		description?: string;
		visibility?: Visibility;
		defaultBranch?: string;
		importUrl?: string;
		importBranch?: string;
		readme?: boolean;
	}>(c);
	const name = assertRepoName(input.name?.trim() ?? "");
	const visibility = input.visibility ?? "public";
	if (visibility !== "public" && visibility !== "private") throw new HttpError(400, "INVALID_INPUT", "visibility is public or private");
	const defaultBranch = input.defaultBranch?.trim() || "master";
	if (!/^[A-Za-z0-9._/-]{1,100}$/.test(defaultBranch) || defaultBranch.includes("..")) throw new HttpError(400, "INVALID_INPUT", "Invalid branch name");
	const row: RepoRow = {
		id: `r${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`,
		ownerId: user.id,
		owner: user.username,
		name,
		description: input.description?.trim() || null,
		visibility,
		defaultBranch,
		createdAt: new Date().toISOString(),
		bytes: 0,
	};
	await ensureSchema(db(c.env));
	await assertCanCreateRepo(c.env, db(c.env), user.id);
	await limit(c.env, `user:${user.id}`, rules.repoCreate(policy(c.env)), "Too many repositories created");
	// Claim owner/name first, so two creates of the same name can't both make a repository.
	await insertRepo(db(c.env), row, policy(c.env).reposPerUser);
	let created: Project;
	try {
		created = await projects(c.env).getByName(row.id).create({
			name: row.id,
			description: row.description ?? undefined,
			defaultBranch: input.importUrl ? undefined : defaultBranch,
			importUrl: input.importUrl?.trim() || undefined,
			importBranch: input.importBranch?.trim() || undefined,
			readme: input.readme ?? false,
		});
	} catch (err) {
		await deleteRepo(db(c.env), row.id);
		throw err;
	}
	// An import's size isn't known until it's there: measure it, and undo the import if it doesn't fit.
	if (input.importUrl) {
		const p = policy(c.env);
		const used = await usage(db(c.env), user.id);
		const room = Math.min(p.repoBytes, p.userBytes - used.bytes);
		const undo = async () => {
			await projects(c.env).getByName(row.id).destroy();
			await deleteRepo(db(c.env), row.id);
		};
		const size = await measureRepository(await projects(c.env).getByName(row.id).gitRemote("read"), Math.max(room, 0)).catch(async (err) => {
			await undo();
			throw err;
		});
		if (size > room) {
			await undo();
			throw new HttpError(403, "QUOTA_EXCEEDED", `That repository is bigger than the ${formatBytes(Math.max(room, 0))} you have room for.`);
		}
		await setRepoBytes(db(c.env), row.id, size);
		row.bytes = size;
	}
	// An import keeps the source's default branch.
	if (created.defaultBranch !== row.defaultBranch) {
		await db(c.env).prepare(`update "repo" set "defaultBranch" = ? where "id" = ?`).bind(created.defaultBranch, row.id).run();
		row.defaultBranch = created.defaultBranch;
	}
	return c.json({ repo: toRepoInfo(row, origin(c), true), project: created }, 201);
});

// ── Admin: projects by internal name (agents, scripts and tests use the API key) ─

app.use("/api/projects", async (c, next) => {
	requireAdmin(c);
	return next();
});

app.get("/api/projects", async (c) => {
	const names = await registry(c.env).list();
	const found = await Promise.all(names.map((n) => projects(c.env).getByName(n).getProject().catch(() => null)));
	return c.json({ projects: found.filter((p) => p !== null) });
});

app.post("/api/projects", async (c) => {
	const input = await body<{
		name: string;
		description?: string;
		defaultBranch?: string;
		importUrl?: string;
		importBranch?: string;
		readme?: boolean;
	}>(c);
	const name = assertProjectName(input.name ?? "");
	const created = await projects(c.env).getByName(name).create({ ...input, name });
	await registry(c.env).add(name);
	return c.json({ project: created }, 201);
});

// ── One repository: the same routes under /api/repos/:owner/:repo and /api/projects/:project ─

const repo = new Hono<App>();

/**
 * Resolves the repository and checks access: reads need read access, anything else (and the live
 * socket's credentials, task changes, settings) needs write access. Private repositories the caller
 * can't read answer 404, so their names don't leak.
 */
repo.use("*", async (c, next) => {
	const owner = c.req.param("owner");
	if (owner === undefined) {
		requireAdmin(c);
		c.set("projectId", assertProjectName(c.req.param("project") ?? ""));
		c.set("repo", null);
		return next();
	}
	await ensureSchema(db(c.env));
	const row = await findRepo(db(c.env), owner, c.req.param("repo") ?? "");
	const p = c.var.principal;
	if (!row || !canRead(p, row)) throw new HttpError(404, "NOT_FOUND", `${owner}/${c.req.param("repo")} not found`);
	const write = !["GET", "HEAD"].includes(c.req.method);
	if (write && !canWrite(p, row)) throw new HttpError(p.kind === "anonymous" ? 401 : 403, "FORBIDDEN", "You can't change this repository");
	c.set("projectId", row.id);
	c.set("repo", row);
	return next();
});

repo.get("/", async (c) => {
	const row = c.var.repo;
	const info: RepoInfo | null = row ? toRepoInfo(row, origin(c), canWrite(c.var.principal, row)) : null;
	const state = await project(c).getProject();
	// People reach user repositories through megit's own git URL; the storage remote stays internal.
	return c.json({ project: info ? { ...state, name: info.fullName, remote: info.cloneUrl } : state, repo: info });
});

repo.patch("/", async (c) => {
	const row = c.var.repo;
	if (!row) throw new HttpError(400, "INVALID_INPUT", "Only user repositories have settings");
	const input = await body<{ visibility?: Visibility; description?: string | null }>(c);
	if (input.visibility !== undefined && input.visibility !== "public" && input.visibility !== "private") {
		throw new HttpError(400, "INVALID_INPUT", "visibility is public or private");
	}
	await updateRepo(db(c.env), row.id, { visibility: input.visibility, description: input.description === undefined ? undefined : input.description?.trim() || null });
	// Live sockets were authorized when they connected; after a visibility change they reconnect and are checked again.
	if (input.visibility !== undefined && input.visibility !== row.visibility) await project(c).disconnectAll("Visibility changed");
	const updated = (await findRepo(db(c.env), row.owner, row.name)) as RepoRow;
	return c.json({ repo: toRepoInfo(updated, origin(c), true) });
});

repo.delete("/", async (c) => {
	// A repository whose creation died partway has a record but no coordinator; deleting it still works.
	await project(c)
		.destroy()
		.catch((err) => {
			if (toHttpError(err).status !== 404) throw err;
		});
	if (c.var.repo) await deleteRepo(db(c.env), c.var.repo.id);
	else await registry(c.env).remove(c.var.projectId);
	return c.json({ deleted: true });
});

// Credentials for pushing to (or cloning) the project repo directly. Write by default.
// Admin only: these are the storage backend's own credentials, so pushes with them skip megit's limits.
repo.post("/credentials", async (c) => {
	requireAdmin(c);
	const { scope } = (await c.req.json().catch(() => ({}))) as { scope?: "read" | "write" };
	if (scope !== undefined && scope !== "read" && scope !== "write") throw new HttpError(400, "INVALID_INPUT", "scope is read or write");
	return c.json(await project(c).repoAccess(scope));
});

repo.get("/queue", async (c) => c.json({ queue: await project(c).mergeQueue() }));

repo.get("/events", async (c) => {
	const limit = intParam(c.req.query("limit"), 100, 1000);
	const after = c.req.query("after");
	// Without `after`, returns the newest `limit` events (for a feed); with it, pages forward from `after`.
	const events = after === undefined ? await project(c).recentEvents(limit) : await project(c).events(intParam(after, 0, Number.MAX_SAFE_INTEGER, 0), limit);
	return c.json({ events });
});

repo.get("/live", async (c) => {
	if (c.req.header("upgrade") !== "websocket") throw new HttpError(426, "UPGRADE_REQUIRED", "Connect with a WebSocket");
	return project(c).fetch(c.req.raw);
});

repo.get("/log", async (c) => {
	const commits = await project(c).log(c.req.query("ref"), intParam(c.req.query("limit"), 50, 200));
	return c.json({ commits });
});

repo.get("/tree", async (c) => {
	c.header("cache-control", "no-store");
	return c.json({ tree: await project(c).tree(c.req.query("ref"), c.req.query("path") ?? "") });
});

repo.get("/files/*", async (c) => {
	const path = routeRest(c, "/files/");
	if (!path) throw new HttpError(400, "INVALID_INPUT", "File path is required");
	const file = await project(c).readFile(c.req.query("ref"), path);
	if (!file) throw new HttpError(404, "NOT_FOUND", `${path} not found`);
	// Always text: this is for reading source in the UI. /raw serves real content types, sandboxed.
	return c.body(file.content, 200, { "content-type": "text/plain;charset=utf-8", ...INERT });
});

// Raw bytes of one file. Served from the API origin, so nothing in a repo may run as a page here:
// the sandbox CSP and nosniff keep an uploaded .html or .svg inert.
repo.get("/raw", async (c) => {
	const path = c.req.query("path");
	if (!path) throw new HttpError(400, "INVALID_INPUT", "path is required");
	const at = await project(c).locate(c.req.query("ref"));
	using repo = await repoStore(c.env).get(at.repo);
	const blob = await repo.readFile({ ref: at.commit, path });
	if (!blob) throw new HttpError(404, "NOT_FOUND", `${path} not found`);
	const name = path.split("/").pop() ?? "file";
	const download = c.req.query("download") !== undefined;
	return c.body(blob.stream(), 200, {
		"content-type": download ? "application/octet-stream" : blob.type || "text/plain;charset=utf-8",
		"content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
		...INERT,
		// A commit's contents never change; a branch's do.
		"cache-control": c.req.query("ref") === at.commit ? "private, max-age=31536000, immutable" : "private, no-cache",
	});
});

repo.get("/archive", async (c) => {
	const format = (c.req.query("format") ?? "tar.gz") as ArchiveFormat;
	if (format !== "tar.gz" && format !== "zip") throw new HttpError(400, "INVALID_INPUT", "format is tar.gz or zip");
	const name = c.var.repo?.name ?? c.var.projectId;
	const ref = c.req.query("ref");
	const at = await project(c).locate(ref);
	const repo = await repoStore(c.env).get(at.repo);
	try {
		const files = await listFiles(repo, at.treeHash);
		const label = ref && !ref.startsWith("task:") && ref !== at.commit ? ref.replaceAll("/", "-") : at.commit.slice(0, 7);
		const root = `${name}-${label}`;
		const stream = archiveStream(repo, files, { format, root, mtime: at.committedAt, onDone: () => repo[Symbol.dispose]() });
		return c.body(stream, 200, {
			"content-type": format === "zip" ? "application/zip" : "application/gzip",
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${root}.${format}`)}`,
			"cache-control": "private, no-cache",
		});
	} catch (err) {
		repo[Symbol.dispose]();
		throw err;
	}
});

repo.get("/commits/:hash", async (c) => c.json(await project(c).commit(c.req.param("hash"), c.req.query("ref"))));

repo.get("/compare", async (c) => {
	const base = c.req.query("base");
	const head = c.req.query("head");
	if (!base || !head) throw new HttpError(400, "INVALID_INPUT", "base and head are required");
	return c.json({ comparison: await project(c).compare(base, head) });
});

// ?counts=0 skips the ahead/behind walks, for pickers that only need names.
repo.get("/branches", async (c) => c.json(await project(c).branches(c.req.query("counts") !== "0")));

repo.delete("/branches/*", async (c) => {
	const name = routeRest(c, "/branches/");
	if (!name) throw new HttpError(400, "INVALID_INPUT", "Branch name is required");
	await project(c).deleteBranch(name);
	return c.json({ deleted: true });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

repo.get("/tasks", async (c) => {
	const tasks = await project(c).listTasks(c.req.query("status") as TaskStatus | undefined);
	return c.json({ tasks });
});

// Waits up to ?wait=<seconds> (default and max 25) for the fork. 201 with credentials once it exists,
// 202 with `fork: null` while the task is still provisioning (watch for `task.ready`).
/**
 * Agent tasks hand out credentials for their forks, so they need what a push needs: a verified email,
 * and room under the repository's size limit.
 */
async function requireCanPush(c: Context<App>) {
	const row = c.var.repo;
	if (!row) return;
	requireVerified(c.env, c.var.principal);
	const blocked = await pushBlocked(c.env, db(c.env), row);
	if (blocked) throw new HttpError(403, "QUOTA_EXCEEDED", blocked);
}

repo.post("/tasks", async (c) => {
	await requireCanPush(c);
	const input = await body<{ title: string; agent?: string; paths?: string[] }>(c);
	const wait = c.req.query("wait");
	const access = await project(c).createTask(input, wait === undefined ? undefined : intParam(wait, 25, 25, 0) * 1000);
	return c.json(access, access.fork ? 201 : 202);
});

repo.get("/tasks/:task", async (c) => c.json({ task: await project(c).getTask(c.req.param("task")) }));

repo.get("/tasks/:task/changes", async (c) =>
	c.json({ comparison: await project(c).taskChanges(c.req.param("task")) }),
);

repo.post("/tasks/:task/access", async (c) => {
	await requireCanPush(c);
	return c.json(await project(c).access(c.req.param("task")));
});

repo.post("/tasks/:task/submit", async (c) => c.json({ task: await project(c).submit(c.req.param("task")) }, 202));

repo.post("/tasks/:task/abandon", async (c) => c.json({ task: await project(c).abandon(c.req.param("task")) }));


app.route("/api/repos/:owner/:repo", repo);
app.route("/api/projects/:project", repo);

export default app satisfies ExportedHandler<Env>;
