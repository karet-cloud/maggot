import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ApiError, FileList, IssueState, Project, RepoInfo, SshInfo, TaskStatus, Visibility, WebhookEvent } from "./api.ts";
import { archiveStream, listFiles, type ArchiveFormat } from "./archive.ts";
import { auth, canRead, canWrite, issueLink, requireVerified, resolvePrincipal, type Principal } from "./auth.ts";
import {
	assertRepoName,
	createToken,
	db,
	deleteRepo,
	ensureSchema,
	findRepo,
	getListing,
	insertRepo,
	listRepos,
	listTokens,
	addRepoBytes,
	addSshKey,
	cancelTransfer,
	completeTransfer,
	deleteSshKey,
	getTransfer,
	incomingTransfers,
	listSshKeys,
	offerTransfer,
	renameRepo,
	setArchived,
	TRANSFER_DAYS,
	addComment,
	cleanLabels,
	createIssue,
	deleteComment,
	editComment,
	getComment,
	getIssue,
	issueParticipants,
	listComments,
	listIssues,
	MAX_ISSUE_BODY,
	MAX_ISSUE_TITLE,
	toIssue,
	toIssueSummary,
	updateIssue,
	type IssueRow,
	listNotifications,
	notifiedRecently,
	markRead,
	notifyUser,
	revokeToken,
	setRepoBytes,
	setStar,
	toRepoInfo,
	updateRepo,
	type RepoListing,
	type RepoRow,
} from "./db.ts";
import { HttpError, toHttpError } from "./errors.ts";
import { emailConfigured } from "./mail.ts";
import { assertProjectName } from "./names.ts";
import { measureRepository } from "./git/protocol.ts";
import { validateHookUrl } from "./hooks.ts";
import { MAX_QUERY_LENGTH } from "./search.ts";
import { assertCanCreateRepo, clientIp, formatBytes, guardCredentials, limit, pushBlocked, policy, RateLimited, rules, usage, verificationRequired } from "./policy.ts";
import type { ProjectCoordinator, Registry } from "./project.ts";
import { repoStore } from "./store.ts";
import { hostKey, parsePublicKey, SSH_PATH } from "./ssh/keys.ts";

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

// ── Notifications ────────────────────────────────────────────────────────────

app.get("/api/notifications", async (c) => {
	const user = requireUser(c);
	await ensureSchema(db(c.env));
	return c.json(await listNotifications(db(c.env), user.id, c.req.query("unread") !== undefined));
});

// Marks the given notifications read, or all of them without `ids`.
app.post("/api/notifications/read", async (c) => {
	const user = requireUser(c);
	const { ids } = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
	if (ids !== undefined && (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== "string"))) {
		throw new HttpError(400, "INVALID_INPUT", "ids is a list of up to 50 notification ids");
	}
	await markRead(db(c.env), user.id, ids as string[] | undefined);
	return c.json({ ok: true });
});

// ── Transfers offered to the signed-in user ──────────────────────────────────

app.get("/api/transfers", async (c) => {
	const user = requireUser(c);
	await ensureSchema(db(c.env));
	return c.json({ transfers: await incomingTransfers(db(c.env), user.id) });
});

/** Takes a repository offered to you, under its own name or `name` if you already have one called that. */
app.post("/api/transfers/:id/accept", async (c) => {
	const user = requireUser(c);
	requireVerified(c.env, user);
	const input = (await c.req.json().catch(() => ({}))) as { name?: string };
	const transfer = await getTransfer(db(c.env), c.req.param("id"));
	if (!transfer || transfer.toUserId !== user.id) throw new HttpError(404, "NOT_FOUND", `No transfer offer for you with that id (they expire after ${TRANSFER_DAYS} days)`);
	const before = (await db(c.env).prepare(`select * from "repo" where "id" = ?`).bind(transfer.id).first<RepoRow>()) as RepoRow;
	const name = assertRepoName((typeof input.name === "string" && input.name.trim()) || before.name);
	const p = policy(c.env);
	await completeTransfer(db(c.env), transfer, { id: user.id, username: user.username }, name, { maxRepos: p.reposPerUser, maxBytes: p.userBytes });
	const after: RepoRow = { ...before, ownerId: user.id, owner: user.username, name };
	const coordinator = projects(c.env).getByName(after.id);
	await coordinator.setRepository(repositoryRef(c, after));
	// Live views were authorized for the old owner.
	await coordinator.disconnectAll("Ownership changed");
	c.executionCtx.waitUntil(
		notifyUser(db(c.env), {
			userId: transfer.fromUserId,
			kind: "transfer",
			repoId: null,
			title: `${user.username} accepted ${before.owner}/${before.name}; it's now ${after.owner}/${after.name}`,
			url: `/${after.owner}/${after.name}`,
			actor: user.username,
		}),
	);
	const listing = await getListing(db(c.env), after.id, user.id);
	return c.json({ repo: toRepoInfo(listing ?? after, origin(c), true, user.id) });
});

app.post("/api/transfers/:id/decline", async (c) => {
	const user = requireUser(c);
	const transfer = await getTransfer(db(c.env), c.req.param("id"));
	if (!transfer || transfer.toUserId !== user.id) throw new HttpError(404, "NOT_FOUND", "No transfer offer for you with that id");
	await cancelTransfer(db(c.env), transfer.id);
	return c.json({ deleted: true });
});

// ── SSH keys ─────────────────────────────────────────────────────────────────

/** The server's host key and where the SSH WebSocket is, for the setup instructions. */
app.get("/api/ssh", async (c) => {
	const key = await hostKey(c.env);
	const url = new URL(SSH_PATH, c.req.url);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return c.json({ hostKey: key.line, fingerprint: key.fingerprint, url: url.toString(), host: url.hostname } satisfies SshInfo);
});

app.get("/api/ssh/keys", async (c) => {
	const user = requireUser(c);
	await ensureSchema(db(c.env));
	return c.json({ keys: await listSshKeys(db(c.env), user.id) });
});

app.post("/api/ssh/keys", async (c) => {
	const user = requireUser(c);
	const input = await body<{ name?: string; key?: string }>(c);
	const parsed = await parsePublicKey(typeof input.key === "string" ? input.key : "");
	const name = (typeof input.name === "string" && input.name.trim().slice(0, 80)) || parsed.comment.slice(0, 80) || parsed.type;
	await ensureSchema(db(c.env));
	const key = await addSshKey(db(c.env), user.id, { name, type: parsed.type, fingerprint: parsed.fingerprint, publicKey: parsed.blob });
	return c.json({ key }, 201);
});

app.delete("/api/ssh/keys/:id", async (c) => {
	if (!(await deleteSshKey(db(c.env), requireUser(c).id, c.req.param("id")))) throw new HttpError(404, "NOT_FOUND", "No such key");
	return c.json({ deleted: true });
});

// ── Repositories ─────────────────────────────────────────────────────────────

const viewerId = (p: Principal) => (p.kind === "user" ? p.id : null);

/**
 * Public repositories (and the caller's own private ones): optionally one owner's, the ones a user
 * starred (`starredBy=<username>`), or those matching `q`; `sort=stars` puts the most starred first.
 */
app.get("/api/repos", async (c) => {
	await ensureSchema(db(c.env));
	const p = c.var.principal;
	const starredBy = c.req.query("starredBy");
	const starrer = starredBy
		? await db(c.env).prepare(`select "id" from "user" where "username" = ?`).bind(starredBy.toLowerCase()).first<{ id: string }>()
		: null;
	if (starredBy && !starrer) return c.json({ repos: [] });
	const rows = await listRepos(db(c.env), {
		owner: c.req.query("owner"),
		viewerId: viewerId(p),
		starredBy: starrer?.id,
		query: c.req.query("q")?.trim().slice(0, 100) || undefined,
		sort: c.req.query("sort") === "stars" ? "stars" : "created",
		limit: intParam(c.req.query("limit"), 100, 500),
	});
	return c.json({ repos: rows.map((r) => toRepoInfo(r, origin(c), canWrite(p, r), viewerId(p))) });
});

interface NewRepo {
	name?: string;
	description?: string;
	visibility?: Visibility;
	defaultBranch?: string;
	importUrl?: string;
	importBranch?: string;
	readme?: boolean;
}

/**
 * Creates a repository for the signed-in user: empty, seeded with a README, imported from a URL, or
 * forked from `source` (all of its branches and tags).
 */
async function createRepo(c: Context<App>, input: NewRepo, source?: RepoRow) {
	const user = requireUser(c);
	requireVerified(c.env, user);
	const name = assertRepoName(input.name?.trim() ?? "");
	// A fork of a private repository stays private.
	const visibility = source?.visibility === "private" ? "private" : (input.visibility ?? source?.visibility ?? "public");
	if (visibility !== "public" && visibility !== "private") throw new HttpError(400, "INVALID_INPUT", "visibility is public or private");
	const defaultBranch = source?.defaultBranch ?? (input.defaultBranch?.trim() || "master");
	if (!/^[A-Za-z0-9._/-]{1,100}$/.test(defaultBranch) || defaultBranch.includes("..")) throw new HttpError(400, "INVALID_INPUT", "Invalid branch name");
	const row: RepoRow = {
		id: `r${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`,
		ownerId: user.id,
		owner: user.username,
		name,
		description: input.description?.trim() || source?.description || null,
		visibility,
		defaultBranch,
		createdAt: new Date().toISOString(),
		// A fork starts out as big as its source, so forking can't get around the storage quota.
		bytes: source?.bytes ?? 0,
		forkOf: source?.id ?? null,
		archivedAt: null,
	};
	await ensureSchema(db(c.env));
	await assertCanCreateRepo(c.env, db(c.env), user.id);
	if (source) {
		const room = policy(c.env).userBytes - (await usage(db(c.env), user.id)).bytes;
		if (source.bytes > room) throw new HttpError(403, "QUOTA_EXCEEDED", `${source.owner}/${source.name} is bigger than the ${formatBytes(Math.max(room, 0))} you have room for.`);
	}
	await limit(c.env, `user:${user.id}`, rules.repoCreate(policy(c.env)), "Too many repositories created");
	// Claim owner/name first, so two creates of the same name can't both make a repository.
	await insertRepo(db(c.env), row, policy(c.env).reposPerUser, policy(c.env).userBytes);
	let created: Project;
	try {
		if (source) await projects(c.env).getByName(source.id).forkInto(row.id, row.description ?? undefined);
		created = await projects(c.env).getByName(row.id).create({
			name: row.id,
			title: row.name,
			description: row.description ?? undefined,
			defaultBranch: input.importUrl || source ? undefined : defaultBranch,
			importUrl: source ? undefined : input.importUrl?.trim() || undefined,
			importBranch: source ? undefined : input.importBranch?.trim() || undefined,
			forked: Boolean(source),
			readme: source ? false : (input.readme ?? false),
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
	await projects(c.env)
		.getByName(row.id)
		.setRepository(repositoryRef(c, row));
	if (source && source.ownerId !== user.id) {
		c.executionCtx.waitUntil(
			notifyUser(db(c.env), {
				userId: source.ownerId,
				kind: "fork",
				repoId: source.id,
				// The fork can go private later, so the notification names only the source; its forks list shows what you may see.
				title: `${user.username} forked ${source.owner}/${source.name}`,
				url: `/${source.owner}/${source.name}/forks`,
				actor: user.username,
			}),
		);
	}
	const listing = await getListing(db(c.env), row.id, user.id);
	return c.json({ repo: toRepoInfo(listing ?? row, origin(c), true, user.id), project: created }, 201);
}

/** How webhook payloads name a repository. */
function repositoryRef(c: Context<App>, row: RepoRow) {
	return { fullName: `${row.owner}/${row.name}`, url: `${origin(c)}/${row.owner}/${row.name}`, cloneUrl: `${origin(c)}/${row.owner}/${row.name}.git`, defaultBranch: row.defaultBranch };
}

app.post("/api/repos", async (c) => createRepo(c, await body<NewRepo>(c)));

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

/** Things anyone who can read a repository may do to it: star or unstar it, and fork it. Exact routes only. */
const READER_ACTIONS: Record<string, string[]> = { "/star": ["PUT", "DELETE"], "/forks": ["POST"] };

/**
 * Whether a write is one a reader may make: starring and forking, and opening and discussing issues
 * (whose routes check authorship themselves).
 */
function readerAction(rest: string, method: string): boolean {
	if (READER_ACTIONS[rest]?.includes(method)) return true;
	if (rest === "/issues") return method === "POST";
	if (/^\/issues\/\d+$/.test(rest)) return method === "PATCH";
	if (/^\/issues\/\d+\/comments$/.test(rest)) return method === "POST";
	if (/^\/issues\/\d+\/comments\/[^/]+$/.test(rest)) return method === "PATCH" || method === "DELETE";
	return false;
}
/** Changes the owner can still make to an archived repository: its settings (unarchiving included), deleting it, and handing it on. */
const ARCHIVED_ACTIONS: Record<string, string[]> = { "/": ["PATCH", "DELETE"], "/transfer": ["POST", "DELETE"] };

/**
 * Resolves the repository and checks access: reads (and starring or forking) need read access,
 * anything else (and the live socket's credentials, task changes, settings) needs write access.
 * Private repositories the caller can't read answer 404, so their names don't leak.
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
	const write = !["GET", "HEAD"].includes(c.req.method) && !readerAction(routeRest(c, ""), c.req.method);
	if (write && !canWrite(p, row)) throw new HttpError(p.kind === "anonymous" ? 401 : 403, "FORBIDDEN", "You can't change this repository");
	if (write && row.archivedAt && !ARCHIVED_ACTIONS[routeRest(c, "")]?.includes(c.req.method)) {
		throw new HttpError(403, "ARCHIVED", "This repository is archived, so it's read-only. Its owner can unarchive it in Settings.");
	}
	c.set("projectId", row.id);
	c.set("repo", row);
	return next();
});

repo.get("/", async (c) => {
	const row = c.var.repo;
	const p = c.var.principal;
	const listing = row ? await getListing(db(c.env), row.id, viewerId(p)) : null;
	const info: RepoInfo | null = row ? toRepoInfo(listing ?? row, origin(c), canWrite(p, row), viewerId(p)) : null;
	const state = await project(c).getProject();
	// People reach user repositories through megit's own git URL; the storage remote stays internal.
	return c.json({ project: info ? { ...state, name: info.fullName, remote: info.cloneUrl } : state, repo: info });
});

repo.patch("/", async (c) => {
	const row = c.var.repo;
	if (!row) throw new HttpError(400, "INVALID_INPUT", "Only user repositories have settings");
	const input = await body<{ visibility?: Visibility; description?: string | null; name?: string; archived?: boolean }>(c);
	if (input.visibility !== undefined && input.visibility !== "public" && input.visibility !== "private") {
		throw new HttpError(400, "INVALID_INPUT", "visibility is public or private");
	}
	if (input.archived !== undefined && typeof input.archived !== "boolean") throw new HttpError(400, "INVALID_INPUT", "archived is true or false");
	if (input.name !== undefined && typeof input.name !== "string") throw new HttpError(400, "INVALID_INPUT", "name is a string");
	// While archived, only unarchiving (and deleting or transferring, elsewhere) is allowed.
	if (row.archivedAt && input.archived !== false && (input.visibility !== undefined || input.description !== undefined || input.name !== undefined)) {
		throw new HttpError(403, "ARCHIVED", "Unarchive the repository before changing its settings");
	}
	if (input.name !== undefined) {
		const name = assertRepoName(input.name.trim());
		if (name !== row.name) {
			await renameRepo(db(c.env), row, name);
			row.name = name;
		}
	}
	if (input.archived !== undefined && input.archived !== Boolean(row.archivedAt)) {
		// The coordinator refuses first if agent tasks are still active, and from then on refuses writes.
		await project(c).setArchived(input.archived);
		await setArchived(db(c.env), row.id, input.archived);
	}
	await updateRepo(db(c.env), row.id, { visibility: input.visibility, description: input.description === undefined ? undefined : input.description?.trim() || null });
	// Live sockets were authorized when they connected; after a visibility change they reconnect and are checked again.
	if (input.visibility !== undefined && input.visibility !== row.visibility) await project(c).disconnectAll("Visibility changed");
	if (input.name !== undefined) await project(c).setRepository(repositoryRef(c, row));
	const updated = (await getListing(db(c.env), row.id, viewerId(c.var.principal))) as RepoListing;
	return c.json({ repo: toRepoInfo(updated, origin(c), true, viewerId(c.var.principal)) });
});

/** The repository behind a user-facing route; admin project routes have none. */
function userRepo(c: Context<App>): RepoRow {
	if (!c.var.repo) throw new HttpError(400, "INVALID_INPUT", "Only user repositories have this");
	return c.var.repo;
}

for (const [method, starred] of [["put", true], ["delete", false]] as const) {
	repo[method]("/star", async (c) => {
		const user = requireUser(c);
		const row = userRepo(c);
		const changed = await setStar(db(c.env), user.id, row.id, starred);
		if (changed && starred && user.id !== row.ownerId && !(await notifiedRecently(db(c.env), row.ownerId, "star", row.id, user.username))) {
			c.executionCtx.waitUntil(
				notifyUser(db(c.env), { userId: row.ownerId, kind: "star", repoId: row.id, title: `${user.username} starred ${row.owner}/${row.name}`, url: `/${row.owner}/${row.name}`, actor: user.username }),
			);
		}
		const listing = (await getListing(db(c.env), row.id, user.id)) as RepoListing;
		return c.json({ starred, stars: listing.stars });
	});
}

repo.get("/forks", async (c) => {
	const p = c.var.principal;
	const rows = await listRepos(db(c.env), { forksOf: userRepo(c).id, viewerId: viewerId(p), limit: intParam(c.req.query("limit"), 100, 500) });
	return c.json({ repos: rows.map((r) => toRepoInfo(r, origin(c), canWrite(p, r), viewerId(p))) });
});

// Forks into the caller's account; the name defaults to the source's.
repo.post("/forks", async (c) => {
	const source = userRepo(c);
	const input = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
	return createRepo(c, { name: input.name?.trim() || source.name, description: input.description }, source);
});

// ── Transfers: the owner offers the repository to another user, who accepts it from /transfers ─

repo.get("/transfer", async (c) => {
	const row = userRepo(c);
	if (!canWrite(c.var.principal, row)) throw new HttpError(404, "NOT_FOUND", "Not found");
	return c.json({ transfer: await getTransfer(db(c.env), row.id) });
});

repo.post("/transfer", async (c) => {
	const user = requireUser(c);
	const row = userRepo(c);
	const { to } = await body<{ to?: string }>(c);
	const name = to?.trim().toLowerCase() ?? "";
	const recipient = name ? await db(c.env).prepare(`select "id", "username" from "user" where "username" = ?`).bind(name).first<{ id: string; username: string }>() : null;
	if (!recipient) throw new HttpError(404, "NOT_FOUND", `There's no user called ${to?.trim() || "that"}`);
	if (recipient.id === row.ownerId) throw new HttpError(400, "INVALID_INPUT", "You already own this repository");
	await offerTransfer(db(c.env), row.id, user.id, recipient.id);
	// The offer names the repository even if it's private: the recipient has to know what they're accepting.
	c.executionCtx.waitUntil(
		notifyUser(db(c.env), {
			userId: recipient.id,
			kind: "transfer",
			repoId: null,
			title: `${user.username} wants to transfer ${row.owner}/${row.name} to you`,
			url: "/transfers",
			actor: user.username,
		}),
	);
	return c.json({ transfer: await getTransfer(db(c.env), row.id) }, 201);
});

repo.delete("/transfer", async (c) => {
	const row = userRepo(c);
	if (!(await cancelTransfer(db(c.env), row.id))) throw new HttpError(404, "NOT_FOUND", "There's no transfer to cancel");
	return c.json({ deleted: true });
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

// Every file path at a ref, for the file finder ("Go to file"). Capped like archives, but truncated rather than refused.
repo.get("/paths", async (c) => {
	const ref = c.req.query("ref");
	const at = await project(c)
		.locate(ref)
		.catch((err) => {
			// An empty repository has nothing to list.
			if (toHttpError(err).status === 404 && !ref) return null;
			throw err;
		});
	if (!at) return c.json({ commit: null, paths: [], truncated: false } satisfies FileList);
	using store = await repoStore(c.env).get(at.repo);
	const { files, truncated } = await listFiles(store, at.treeHash, { truncate: true });
	const paths = files.map((f) => f.path).sort();
	return c.json({ commit: at.commit, paths, truncated } satisfies FileList, 200, {
		"cache-control": ref === at.commit ? "private, max-age=31536000, immutable" : "private, no-cache",
	});
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
		const { files } = await listFiles(repo, at.treeHash);
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

// Commits from the web editor: write, create or delete files on a branch (or a new one). Text only.
const MAX_EDIT_BYTES = 1024 * 1024;

repo.post("/contents", async (c) => {
	// Up to 20 files of 1 MB, JSON-escaped; anything far bigger isn't read at all.
	if (Number(c.req.header("content-length") ?? 0) > 50 * MAX_EDIT_BYTES) throw new HttpError(413, "TOO_LARGE", "That's too much for one web commit");
	const row = c.var.repo;
	const p = c.var.principal;
	requireVerified(c.env, p);
	if (row) {
		const blocked = await pushBlocked(c.env, db(c.env), row);
		if (blocked) throw new HttpError(403, "QUOTA_EXCEEDED", blocked);
	}
	const input = await body<{
		branch?: string;
		baseCommit?: string | null;
		newBranch?: string;
		message?: string;
		files?: { path?: string; content?: string | null; previousPath?: string }[];
	}>(c);
	const message = input.message?.trim();
	if (!message) throw new HttpError(400, "INVALID_INPUT", "A commit message is required");
	if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 20) throw new HttpError(400, "INVALID_INPUT", "Give 1 to 20 files");
	const encoder = new TextEncoder();
	const seen = new Set<string>();
	const changes = input.files.map((f) => {
		const path = normalizeRepoPath(f.path ?? "");
		if (seen.has(path)) throw new HttpError(400, "INVALID_INPUT", `${path} is listed twice`);
		seen.add(path);
		if (f.content !== null && typeof f.content !== "string") throw new HttpError(400, "INVALID_INPUT", `Content for ${path} must be a string, or null to delete it`);
		const content = f.content === null ? null : encoder.encode(f.content);
		if (content && content.length > MAX_EDIT_BYTES) throw new HttpError(413, "TOO_LARGE", `${path} is over 1 MB; push it with git instead`);
		// A rename keeps the file's mode (an executable stays executable).
		return { path, content, modeFrom: f.previousPath ? normalizeRepoPath(f.previousPath) : undefined };
	});
	const who =
		p.kind === "user"
			? { name: p.username, email: `${p.username}@users.noreply.${new URL(c.req.url).hostname}` }
			: { name: "megit", email: "admin@megit.dev" };
	const branch = input.branch?.trim() || (await project(c).getProject()).defaultBranch;
	// A web commit is a push: it has the push size limit, and has to fit what the repository and its
	// owner have left.
	const limits = policy(c.env);
	let maxPackBytes = limits.pushBytes;
	if (row) {
		const used = await usage(db(c.env), row.ownerId);
		maxPackBytes = Math.min(maxPackBytes, limits.repoBytes - row.bytes, limits.userBytes - used.bytes);
	}
	const result = await project(c).commitFiles({
		maxPackBytes,
		branch,
		baseCommit: input.baseCommit,
		newBranch: input.newBranch?.trim() || undefined,
		changes,
		message: message.slice(0, 10_000),
		author: who,
	});
	if (row) c.executionCtx.waitUntil(addRepoBytes(db(c.env), row.id, result.packBytes));
	return c.json(result, 201);
});

/**
 * A repository path from a form: no leading or trailing slash, no empty, "." or ".." segments, and
 * nothing git refuses to check out (".git" in any spelling Windows or macOS treat as ".git").
 */
function normalizeRepoPath(raw: string): string {
	const parts = raw.trim().replace(/^\/+|\/+$/g, "").split("/");
	if (raw.length > 4096 || parts.length > 64 || parts.some((part) => part === "" || part === "." || part === ".." || /[\\\0]/.test(part) || isDotGit(part))) {
		throw new HttpError(400, "INVALID_PATH", `${raw || "An empty path"} isn't a valid file path`);
	}
	return parts.join("/");
}

/** Git's own check (verify_path): HFS+ ignores some zero-width characters, NTFS trailing dots and spaces, alternate streams and 8.3 names. */
function isDotGit(part: string): boolean {
	const name = part
		.replace(/[\u200b-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
		.toLowerCase()
		.replace(/:.*$/, "")
		.replace(/[. ]+$/, "");
	return name === ".git" || /^git~\d+$/.test(name);
}

// ── Code search ──────────────────────────────────────────────────────────────

repo.get("/search", async (c) => {
	const q = c.req.query("q") ?? "";
	if (q.length > MAX_QUERY_LENGTH) throw new HttpError(400, "INVALID_INPUT", `Search for at most ${MAX_QUERY_LENGTH} characters`);
	if (/[\u0000-\u0008\u000b-\u001f]/.test(q)) throw new HttpError(400, "INVALID_INPUT", "Search text can't contain control characters");
	// Searches cost the repository's coordinator real work, so they're limited even for signed-in reads.
	const p = c.var.principal;
	if (p.kind !== "admin") await limit(c.env, p.kind === "user" ? `user:${p.id}` : `ip:${clientIp(c.req.raw)}`, rules.search(policy(c.env)), "Too many searches");
	return c.json(await project(c).searchCode(q));
});

// ── Tags and releases ────────────────────────────────────────────────────────

repo.get("/tags", async (c) => c.json({ tags: await project(c).tags() }));

repo.post("/tags", async (c) => {
	const { name, target } = await body<{ name?: string; target?: string }>(c);
	if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "INVALID_INPUT", "name is required");
	return c.json({ tag: await project(c).createTag(name.trim(), typeof target === "string" ? target : undefined) }, 201);
});

repo.delete("/tags/*", async (c) => {
	const name = routeRest(c, "/tags/");
	if (!name) throw new HttpError(400, "INVALID_INPUT", "Tag name is required");
	await project(c).deleteTag(name);
	return c.json({ deleted: true });
});

repo.get("/releases", async (c) => c.json({ releases: await project(c).releases() }));

repo.post("/releases", async (c) => {
	const input = await body<{ tag?: string; target?: string; name?: string; notes?: string; prerelease?: boolean }>(c);
	if (typeof input.tag !== "string" || !input.tag.trim()) throw new HttpError(400, "INVALID_INPUT", "tag is required");
	const p = c.var.principal;
	const release = await project(c).createRelease({
		tag: input.tag,
		target: typeof input.target === "string" ? input.target : undefined,
		name: typeof input.name === "string" ? input.name : undefined,
		notes: typeof input.notes === "string" ? input.notes : undefined,
		prerelease: input.prerelease === true,
		author: p.kind === "user" ? p.username : null,
	});
	return c.json({ release }, 201);
});

repo.patch("/releases/:id", async (c) => {
	const input = await body<{ name?: string; notes?: string; prerelease?: boolean }>(c);
	return c.json({
		release: await project(c).updateRelease(c.req.param("id"), {
			name: typeof input.name === "string" ? input.name : undefined,
			notes: typeof input.notes === "string" ? input.notes : undefined,
			prerelease: typeof input.prerelease === "boolean" ? input.prerelease : undefined,
		}),
	});
});

repo.delete("/releases/:id", async (c) => {
	await project(c).deleteRelease(c.req.param("id"), c.req.query("deleteTag") !== undefined);
	return c.json({ deleted: true });
});

// ── Commit graph ─────────────────────────────────────────────────────────────

repo.get("/graph", async (c) => c.json(await project(c).graph(intParam(c.req.query("limit"), 150, 400, 10))));

// ── Branch protection (anyone who can read sees the rules; the owner sets them) ─

repo.get("/protection", async (c) => c.json({ rules: await project(c).getBranchRules() }));

repo.put("/protection", async (c) => {
	const input = await body<{ pattern?: string; blockDeletions?: boolean; blockForcePushes?: boolean; requireMergeQueue?: boolean }>(c);
	if (typeof input.pattern !== "string") throw new HttpError(400, "INVALID_INPUT", "pattern is required");
	const rules = await project(c).setBranchRule({
		pattern: input.pattern.trim(),
		blockDeletions: input.blockDeletions === true,
		blockForcePushes: input.blockForcePushes === true,
		requireMergeQueue: input.requireMergeQueue === true,
	});
	return c.json({ rules });
});

repo.delete("/protection", async (c) => {
	const pattern = c.req.query("pattern");
	if (!pattern) throw new HttpError(400, "INVALID_INPUT", "pattern is required");
	return c.json({ rules: await project(c).deleteBranchRule(pattern) });
});

// ── Issues (anyone signed in who can read the repository opens and comments; authors and the owner edit) ─

function issueNumber(c: Context<App>): number {
	const n = Number(c.req.param("number"));
	if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "NOT_FOUND", "No such issue");
	return n;
}

async function loadIssue(c: Context<App>): Promise<IssueRow> {
	const issue = await getIssue(db(c.env), userRepo(c).id, issueNumber(c));
	if (!issue) throw new HttpError(404, "NOT_FOUND", `Issue #${c.req.param("number")} not found`);
	return issue;
}

function issueText(input: { title?: unknown; body?: unknown }, creating: boolean): { title?: string; body?: string } {
	if (input.title !== undefined || creating) {
		if (typeof input.title !== "string" || !input.title.trim()) throw new HttpError(400, "INVALID_INPUT", "An issue needs a title");
		if (input.title.trim().length > MAX_ISSUE_TITLE) throw new HttpError(400, "INVALID_INPUT", `Titles are up to ${MAX_ISSUE_TITLE} characters`);
	}
	if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > MAX_ISSUE_BODY)) {
		throw new HttpError(400, "INVALID_INPUT", `The text is up to ${MAX_ISSUE_BODY / 1024} KB`);
	}
	return { title: typeof input.title === "string" ? input.title.trim() : undefined, body: typeof input.body === "string" ? input.body : undefined };
}

/** Issues and comments cost a write each and count against the poster's hourly budget. */
async function canPost(c: Context<App>) {
	const user = requireUser(c);
	requireVerified(c.env, user);
	await limit(c.env, `user:${user.id}`, rules.post(policy(c.env)), "You're posting too fast; try again later");
	return user;
}

const issueUrl = (c: Context<App>, row: RepoRow, number: number) => `${origin(c)}/${row.owner}/${row.name}/issues/${number}`;

/** Tells everyone involved (except whoever did it) and records the event for the feed and webhooks. */
function announceIssue(
	c: Context<App>,
	row: RepoRow,
	issue: IssueRow,
	action: "opened" | "closed" | "reopened" | "commented",
	actor: { id: string; username: string },
	extra: Record<string, unknown> = {},
) {
	c.executionCtx.waitUntil(
		(async () => {
			const people = new Set([row.ownerId, ...(action === "opened" ? [] : await issueParticipants(db(c.env), issue.id))]);
			people.delete(actor.id);
			const verb = { opened: "opened", closed: "closed", reopened: "reopened", commented: "commented on" }[action];
			await Promise.all(
				[...people].map((userId) =>
					notifyUser(db(c.env), {
						userId,
						kind: "issue",
						repoId: row.id,
						title: `${actor.username} ${verb} #${issue.number}: ${issue.title}`,
						url: `/${row.owner}/${row.name}/issues/${issue.number}`,
						actor: actor.username,
					}),
				),
			);
			await project(c).recordEvent(`issue.${action}`, {
				issue: { number: issue.number, title: issue.title, state: issue.state, url: issueUrl(c, row, issue.number) },
				sender: actor.username,
				...extra,
			});
		})().catch((err) => console.error("announcing issue activity failed", err)),
	);
}

repo.get("/issues", async (c) => {
	const state = c.req.query("state");
	const q = c.req.query("q")?.trim().slice(0, 100) || undefined;
	return c.json(
		await listIssues(db(c.env), userRepo(c).id, {
			state: state === "closed" || state === "all" ? state : "open",
			query: q,
			label: c.req.query("label")?.slice(0, 50) || undefined,
			limit: intParam(c.req.query("limit"), 50, 200),
		}),
	);
});

repo.post("/issues", async (c) => {
	const row = userRepo(c);
	const user = await canPost(c);
	const input = await body<{ title?: string; body?: string; labels?: unknown }>(c);
	const text = issueText(input, true);
	// Only the owner labels issues.
	const labels = input.labels !== undefined && canWrite(user, row) ? cleanLabels(input.labels) : [];
	const issue = await createIssue(db(c.env), row.id, user.id, text.title as string, text.body ?? "", labels);
	announceIssue(c, row, issue, "opened", user);
	return c.json({ issue: toIssue(issue, true, canWrite(user, row)) }, 201);
});

repo.get("/issues/:number", async (c) => {
	const row = userRepo(c);
	const issue = await loadIssue(c);
	const p = c.var.principal;
	const owner = canWrite(p, row);
	const me = viewerId(p);
	return c.json({
		issue: toIssue(issue, owner || (me !== null && me === issue.authorId), owner),
		comments: await listComments(db(c.env), issue.id, { id: me, owner }),
	});
});

repo.patch("/issues/:number", async (c) => {
	const row = userRepo(c);
	const user = requireUser(c);
	const issue = await loadIssue(c);
	const owner = canWrite(user, row);
	if (!owner && user.id !== issue.authorId) throw new HttpError(403, "FORBIDDEN", "Only the issue's author and the repository's owner can change it");
	const input = await body<{ title?: string; body?: string; state?: IssueState; labels?: unknown }>(c);
	if (input.state !== undefined && input.state !== "open" && input.state !== "closed") throw new HttpError(400, "INVALID_INPUT", "state is open or closed");
	if (input.labels !== undefined && !owner) throw new HttpError(403, "FORBIDDEN", "Only the repository's owner can label issues");
	const updated = await updateIssue(db(c.env), issue, {
		...issueText(input, false),
		state: input.state,
		labels: input.labels === undefined ? undefined : cleanLabels(input.labels),
		by: user.id,
	});
	if (input.state && input.state !== issue.state) announceIssue(c, row, updated, input.state === "closed" ? "closed" : "reopened", user);
	return c.json({ issue: toIssue(updated, true, owner) });
});

repo.post("/issues/:number/comments", async (c) => {
	const row = userRepo(c);
	const user = await canPost(c);
	const issue = await loadIssue(c);
	const input = await body<{ body?: string }>(c);
	const text = typeof input.body === "string" ? input.body.trim() : "";
	if (!text) throw new HttpError(400, "INVALID_INPUT", "A comment needs some text");
	if (text.length > MAX_ISSUE_BODY) throw new HttpError(400, "INVALID_INPUT", `Comments are up to ${MAX_ISSUE_BODY / 1024} KB`);
	const comment = await addComment(db(c.env), issue, user.id, text, { id: user.id, owner: canWrite(user, row) });
	announceIssue(c, row, issue, "commented", user, { comment: { id: comment.id, body: text.slice(0, 2000) } });
	return c.json({ comment }, 201);
});

repo.patch("/issues/:number/comments/:id", async (c) => {
	const row = userRepo(c);
	const user = requireUser(c);
	const issue = await loadIssue(c);
	const comment = await getComment(db(c.env), issue.id, c.req.param("id"));
	if (!comment) throw new HttpError(404, "NOT_FOUND", "No such comment");
	// Only its author edits a comment; the owner can delete it but not put words in someone's mouth.
	if (comment.authorId !== user.id) throw new HttpError(403, "FORBIDDEN", "Only a comment's author can edit it");
	const input = await body<{ body?: string }>(c);
	const text = typeof input.body === "string" ? input.body.trim() : "";
	if (!text || text.length > MAX_ISSUE_BODY) throw new HttpError(400, "INVALID_INPUT", `A comment is 1 character to ${MAX_ISSUE_BODY / 1024} KB`);
	return c.json({ comment: await editComment(db(c.env), comment, text, { id: user.id, owner: canWrite(user, row) }) });
});

repo.delete("/issues/:number/comments/:id", async (c) => {
	const row = userRepo(c);
	const user = requireUser(c);
	const issue = await loadIssue(c);
	const comment = await getComment(db(c.env), issue.id, c.req.param("id"));
	if (!comment) throw new HttpError(404, "NOT_FOUND", "No such comment");
	if (comment.authorId !== user.id && !canWrite(user, row)) throw new HttpError(403, "FORBIDDEN", "Only a comment's author and the repository's owner can delete it");
	await deleteComment(db(c.env), issue.id, comment.id);
	return c.json({ deleted: true });
});

// ── Webhooks (owner only, reads included: they show URLs and payloads) ─────────

repo.use("/hooks/*", async (c, next) => {
	if (c.var.repo && !canWrite(c.var.principal, c.var.repo)) throw new HttpError(404, "NOT_FOUND", "Not found");
	return next();
});
repo.use("/hooks", async (c, next) => {
	if (c.var.repo && !canWrite(c.var.principal, c.var.repo)) throw new HttpError(404, "NOT_FOUND", "Not found");
	return next();
});

/** Local development may point webhooks at http://localhost; production needs https to a public host. */
const allowHttpHooks = (env: Env) => Boolean((env as { LOCAL_ARTIFACTS_URL?: string }).LOCAL_ARTIFACTS_URL);

function hookInput(c: Context<App>, input: { url?: string; secret?: string; events?: WebhookEvent[]; active?: boolean }, creating: boolean) {
	if (creating && !input.url) throw new HttpError(400, "INVALID_INPUT", "url is required");
	if ((creating || input.secret !== undefined) && (typeof input.secret !== "string" || input.secret.length < 8 || input.secret.length > 200)) {
		throw new HttpError(400, "INVALID_INPUT", "The secret is 8 to 200 characters; receivers use it to check each payload's signature");
	}
	return {
		url: input.url === undefined ? undefined : validateHookUrl(input.url, allowHttpHooks(c.env)),
		secret: input.secret,
		events: input.events === undefined ? undefined : Array.isArray(input.events) ? input.events : [],
		active: input.active === undefined ? undefined : Boolean(input.active),
	};
}

repo.get("/hooks", async (c) => c.json({ hooks: await project(c).listHooks() }));

repo.post("/hooks", async (c) => {
	const input = hookInput(c, await body(c), true);
	if (c.var.repo) await project(c).setRepository(repositoryRef(c, c.var.repo));
	const hook = await project(c).createHook({ url: input.url as string, secret: input.secret as string, events: input.events ?? ["push"] });
	return c.json({ hook }, 201);
});

repo.patch("/hooks/:id", async (c) => c.json({ hook: await project(c).updateHook(c.req.param("id"), hookInput(c, await body(c), false)) }));

repo.delete("/hooks/:id", async (c) => {
	await project(c).deleteHook(c.req.param("id"));
	return c.json({ deleted: true });
});

repo.get("/hooks/:id/deliveries", async (c) => c.json({ deliveries: await project(c).hookDeliveries(c.req.param("id")) }));

repo.post("/hooks/:id/ping", async (c) => c.json({ delivery: await project(c).pingHook(c.req.param("id")) }, 202));

repo.post("/hooks/:id/deliveries/:delivery/redeliver", async (c) =>
	c.json({ delivery: await project(c).redeliverHook(c.req.param("id"), c.req.param("delivery")) }, 202),
);

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
