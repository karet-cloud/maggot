import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ApiError, PullChecks, Comparison, FileList, IssueState, MergeMethod, OrgRole, Project, RepoInfo, ReviewState, SshInfo, TaskStatus, Visibility, WebhookEvent } from "./api.ts";
import { protectionFor } from "./branch-rules.ts";
import { archiveStream, listFiles, type ArchiveFormat } from "./archive.ts";
import { auth, canAdmin, canRead, canWrite, issueLink, requireVerified, resolvePrincipal, type Principal } from "./auth.ts";
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
	addReview,
	approvedAt,
	getPull,
	listPulls,
	listReviews,
	markPullMerged,
	MAX_REVIEW_COMMENTS,
	toPull,
	closeIssuesByCommits,
	type IssueRow,
	type PullRow,
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
import { assertProjectName, wikiRepoName } from "./names.ts";
import { WIKI_BRANCH } from "./wiki-pages.ts";
import { measureRepository } from "./git/protocol.ts";
import { validateHookUrl } from "./hooks.ts";
import { MAX_QUERY_LENGTH } from "./search.ts";
import jobApi from "./ci/job-api.ts";
import actions from "./ci/routes.ts";
import { assertCanCreateRepo, clientIp, formatBytes, guardCredentials, limit, pushBlocked, policy, RateLimited, rules, usage, verificationRequired } from "./policy.ts";
import type { ProjectCoordinator, Registry } from "./project.ts";
import { repoStore } from "./store.ts";
import { hostKey, parsePublicKey, SSH_PATH } from "./ssh/keys.ts";
import {
	answerInvitation,
	assertPermission,
	createOrg,
	createTeam,
	deleteOrg,
	deleteTeam,
	describeOrg,
	findOrg,
	invitationsFor,
	inviteMember,
	listCollaborators,
	orgsOf,
	removeCollaborator,
	removeMember,
	roleIn,
	setCollaborator,
	setMemberRole,
	setTeamMember,
	setTeamRepo,
} from "./orgs.ts";

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
	// Jobs' own API: authorized by the job's token (src/ci/job-api.ts), not a person's credentials.
	if (c.req.path.startsWith("/api/ci/")) return next();
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

app.get("/api", (c) => c.json({ name: "maggot", description: "A Git platform for people and many concurrent agents, on Cloudflare Artifacts." }));

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

/** Who receives a transfer the user may answer: themselves, or an organization they own. */
async function transferRecipient(c: Context<App>, toUserId: string, userId: string): Promise<{ id: string; username: string } | null> {
	const to = await db(c.env).prepare(`select "id", "username", "kind" from "user" where "id" = ?`).bind(toUserId).first<{ id: string; username: string; kind: string }>();
	if (!to) return null;
	if (to.id === userId) return to;
	return to.kind === "org" && (await roleIn(db(c.env), to.id, userId)) === "owner" ? to : null;
}

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
	const recipient = transfer && (await transferRecipient(c, transfer.toUserId, user.id));
	if (!transfer || !recipient) throw new HttpError(404, "NOT_FOUND", `No transfer offer for you with that id (they expire after ${TRANSFER_DAYS} days)`);
	const before = (await db(c.env).prepare(`select * from "repo" where "id" = ?`).bind(transfer.id).first<RepoRow>()) as RepoRow;
	const name = assertRepoName((typeof input.name === "string" && input.name.trim()) || before.name);
	const p = policy(c.env);
	await completeTransfer(db(c.env), transfer, recipient, name, { maxRepos: p.reposPerUser, maxBytes: p.userBytes });
	const after: RepoRow = { ...before, ownerId: recipient.id, owner: recipient.username, name };
	const coordinator = projects(c.env).getByName(after.id);
	await coordinator.setRepository(repositoryRef(c, after));
	// Live views were authorized for the old owner, and webhooks point at the old owner's endpoints.
	await coordinator.disconnectAll("Ownership changed");
	await coordinator.pauseHooks();
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
	return c.json({ repo: toRepoInfo(listing ?? after, origin(c), true, user.id, true, true) });
});

app.post("/api/transfers/:id/decline", async (c) => {
	const user = requireUser(c);
	const transfer = await getTransfer(db(c.env), c.req.param("id"));
	if (!transfer || !(await transferRecipient(c, transfer.toUserId, user.id))) throw new HttpError(404, "NOT_FOUND", "No transfer offer for you with that id");
	await cancelTransfer(db(c.env), transfer.id, transfer.toUserId);
	return c.json({ deleted: true });
});

// ── Organizations and teams ──────────────────────────────────────────────────

app.get("/api/orgs", async (c) => {
	const user = requireUser(c);
	await ensureSchema(db(c.env));
	return c.json({ orgs: await orgsOf(db(c.env), user.id) });
});

app.post("/api/orgs", async (c) => {
	const user = requireUser(c);
	requireVerified(c.env, user);
	const input = await body<{ name?: string; displayName?: string }>(c);
	if (typeof input.name !== "string") throw new HttpError(400, "INVALID_INPUT", "name is required");
	await limit(c.env, `user:${user.id}`, rules.repoCreate(policy(c.env)), "Too many created; try again later");
	await ensureSchema(db(c.env));
	const org = await createOrg(db(c.env), user.id, input.name, typeof input.displayName === "string" ? input.displayName : "");
	return c.json({ org: await describeOrg(db(c.env), org, user.id) }, 201);
});

/** The organization named in the route, and the caller's role in it; `need` checks the role. */
async function orgRoute(c: Context<App>, need?: "member" | "owner") {
	await ensureSchema(db(c.env));
	const org = await findOrg(db(c.env), c.req.param("org") ?? "");
	if (!org) throw new HttpError(404, "NOT_FOUND", "No such organization");
	const p = c.var.principal;
	const role = p.kind === "admin" ? "owner" : await roleIn(db(c.env), org.id, viewerId(p));
	if (need && !role) throw new HttpError(403, "FORBIDDEN", "Only the organization's members can do that");
	if (need === "owner" && role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only the organization's owners can do that");
	return { org, role };
}

app.get("/api/orgs/:org", async (c) => {
	const { org } = await orgRoute(c);
	return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) });
});

/**
 * Live views (and their sockets) were authorized with the access people had then; after a change to
 * who can reach these repositories, they reconnect and are checked again.
 */
function reauthorize(c: Context<App>, repoIds: string[]): void {
	if (repoIds.length === 0) return;
	c.executionCtx.waitUntil(Promise.allSettled(repoIds.map((id) => projects(c.env).getByName(id).disconnectAll("Access changed"))));
}

async function repoIdsWhere(c: Context<App>, sql: string, ...args: string[]): Promise<string[]> {
	const { results } = await db(c.env).prepare(sql).bind(...args).all<{ id: string }>();
	return results.map((r) => r.id);
}
const orgRepos = (c: Context<App>, orgId: string) => repoIdsWhere(c, `select "id" from "repo" where "ownerId" = ?`, orgId);
const teamRepos = (c: Context<App>, teamId: string) => repoIdsWhere(c, `select "repoId" as "id" from "team_repo" where "teamId" = ?`, teamId);

app.delete("/api/orgs/:org", async (c) => {
	const { org } = await orgRoute(c, "owner");
	await deleteOrg(db(c.env), org.id);
	return c.json({ deleted: true });
});

app.post("/api/orgs/:org/members", async (c) => {
	const { org } = await orgRoute(c, "owner");
	const user = requireUser(c);
	const input = await body<{ username?: string; role?: string }>(c);
	if (typeof input.username !== "string") throw new HttpError(400, "INVALID_INPUT", "username is required");
	const role = input.role === "owner" ? "owner" : "member";
	const invitee = await inviteMember(db(c.env), org.id, input.username, role, user.id);
	c.executionCtx.waitUntil(
		notifyUser(db(c.env), { userId: invitee, kind: "invitation", repoId: null, title: `${user.username} invited you to join ${org.username}`, url: "/transfers", actor: user.username }),
	);
	return c.json({ org: await describeOrg(db(c.env), org, user.id) }, 201);
});

app.patch("/api/orgs/:org/members/:username", async (c) => {
	const { org } = await orgRoute(c, "owner");
	const input = await body<{ role?: string }>(c);
	if (input.role !== "owner" && input.role !== "member") throw new HttpError(400, "INVALID_INPUT", "role is owner or member");
	await setMemberRole(db(c.env), org.id, c.req.param("username"), input.role);
	reauthorize(c, await orgRepos(c, org.id));
	return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) });
});

// Owners remove anyone; members can remove themselves (leave).
app.delete("/api/orgs/:org/members/:username", async (c) => {
	const user = requireUser(c);
	const leaving = c.req.param("username").toLowerCase() === user.username;
	const { org } = await orgRoute(c, leaving ? "member" : "owner");
	await removeMember(db(c.env), org.id, c.req.param("username"));
	reauthorize(c, await orgRepos(c, org.id));
	return c.json({ org: await describeOrg(db(c.env), org, user.id) });
});

app.post("/api/orgs/:org/teams", async (c) => {
	const { org } = await orgRoute(c, "owner");
	const input = await body<{ name?: string }>(c);
	await createTeam(db(c.env), org.id, typeof input.name === "string" ? input.name : "");
	return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) }, 201);
});

app.delete("/api/orgs/:org/teams/:team", async (c) => {
	const { org } = await orgRoute(c, "owner");
	const reach = await teamRepos(c, c.req.param("team"));
	await deleteTeam(db(c.env), org.id, c.req.param("team"));
	reauthorize(c, reach);
	return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) });
});

for (const [method, member] of [["put", true], ["delete", false]] as const) {
	app[method]("/api/orgs/:org/teams/:team/members/:username", async (c) => {
		const { org } = await orgRoute(c, "owner");
		await setTeamMember(db(c.env), org.id, c.req.param("team"), c.req.param("username"), member);
		reauthorize(c, await teamRepos(c, c.req.param("team")));
		return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) });
	});
}

app.put("/api/orgs/:org/teams/:team/repos/:repo", async (c) => {
	const { org } = await orgRoute(c, "owner");
	const input = await body<{ permission?: string }>(c);
	await setTeamRepo(db(c.env), org.id, c.req.param("team"), c.req.param("repo"), assertPermission(input.permission));
	reauthorize(c, await repoIdsWhere(c, `select "id" from "repo" where "ownerId" = ? and "name" = ?`, org.id, c.req.param("repo")));
	return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) });
});

app.delete("/api/orgs/:org/teams/:team/repos/:repo", async (c) => {
	const { org } = await orgRoute(c, "owner");
	await setTeamRepo(db(c.env), org.id, c.req.param("team"), c.req.param("repo"), null);
	reauthorize(c, await repoIdsWhere(c, `select "id" from "repo" where "ownerId" = ? and "name" = ?`, org.id, c.req.param("repo")));
	return c.json({ org: await describeOrg(db(c.env), org, viewerId(c.var.principal)) });
});

// ── Invitations to organizations and repositories ────────────────────────────

app.get("/api/invitations", async (c) => {
	const user = requireUser(c);
	await ensureSchema(db(c.env));
	return c.json({ invitations: await invitationsFor(db(c.env), user.id) });
});

for (const answer of ["accept", "decline"] as const) {
	app.post(`/api/invitations/:kind/:id/${answer}`, async (c) => {
		const user = requireUser(c);
		const kind = c.req.param("kind");
		if (kind !== "org" && kind !== "repo") throw new HttpError(404, "NOT_FOUND", "No such invitation");
		if (answer === "accept") requireVerified(c.env, user);
		await answerInvitation(db(c.env), user.id, kind, c.req.param("id"), answer === "accept");
		return c.json({ ok: true });
	});
}

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
	return c.json({ repos: rows.map((r) => toRepoInfo(r, origin(c), canWrite(p, r), viewerId(p), canAdmin(p, r))) });
});

interface NewRepo {
	name?: string;
	description?: string;
	visibility?: Visibility;
	defaultBranch?: string;
	importUrl?: string;
	importDepth?: number;
	importBranch?: string;
	readme?: boolean;
	/** An organization to create it in (the caller has to be a member); the caller's own account by default. */
	owner?: string;
}

/** Whose account a new repository (or fork) goes in: the caller's, or an organization they're a member of. */
async function newOwner(c: Context<App>, user: { id: string; username: string }, owner: unknown): Promise<{ id: string; username: string; role: OrgRole | null }> {
	if (owner === undefined || owner === null || owner === "" || owner === user.username) return { ...user, role: null };
	if (typeof owner !== "string") throw new HttpError(400, "INVALID_INPUT", "owner is an organization's name");
	const org = await findOrg(db(c.env), owner);
	const role = org ? await roleIn(db(c.env), org.id, user.id) : null;
	if (!org || !role) throw new HttpError(403, "FORBIDDEN", `You can't create repositories in ${owner}`);
	return { id: org.id, username: org.username, role };
}

/**
 * Creates a repository for the signed-in user (or in one of their organizations): empty, seeded with a README, imported from a URL, or
 * forked from `source` (all of its branches and tags).
 */
async function createRepo(c: Context<App>, input: NewRepo, source?: RepoRow) {
	const user = requireUser(c);
	requireVerified(c.env, user);
	if (input.importDepth !== undefined && (!Number.isInteger(input.importDepth) || input.importDepth < 1 || input.importDepth > 10_000)) throw new HttpError(400, "INVALID_INPUT", "importDepth must be an integer from 1 to 10000");
	const name = assertRepoName(input.name?.trim() ?? "");
	// A fork of a private repository stays private.
	const visibility = source?.visibility === "private" ? "private" : (input.visibility ?? source?.visibility ?? "public");
	if (visibility !== "public" && visibility !== "private") throw new HttpError(400, "INVALID_INPUT", "visibility is public or private");
	const defaultBranch = source?.defaultBranch ?? (input.defaultBranch?.trim() || "master");
	if (!/^[A-Za-z0-9._/-]{1,100}$/.test(defaultBranch) || defaultBranch.includes("..")) throw new HttpError(400, "INVALID_INPUT", "Invalid branch name");
	await ensureSchema(db(c.env));
	const owner = await newOwner(c, user, input.owner);
	const row: RepoRow = {
		id: `r${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`,
		ownerId: owner.id,
		owner: owner.username,
		name,
		description: input.description?.trim() || source?.description || null,
		visibility,
		defaultBranch,
		createdAt: new Date().toISOString(),
		// A fork starts out as big as its source, so forking can't get around the storage quota.
		bytes: source?.bytes ?? 0,
		forkOf: source?.id ?? null,
		archivedAt: null,
		// A fork starts with a wiki of its own, empty: like GitHub, forking doesn't copy the wiki.
		hasWiki: 1,
	};
	await assertCanCreateRepo(c.env, db(c.env), owner.id);
	if (source) {
		const room = policy(c.env).userBytes - (await usage(db(c.env), owner.id)).bytes;
		if (source.bytes > room) throw new HttpError(403, "QUOTA_EXCEEDED", `${source.owner}/${source.name} is bigger than the ${formatBytes(Math.max(room, 0))} you have room for.`);
	}
	await limit(c.env, `user:${user.id}`, rules.repoCreate(policy(c.env)), "Too many repositories created");
	// Claim owner/name first, so two creates of the same name can't both make a repository.
	await insertRepo(db(c.env), row, policy(c.env).reposPerUser, policy(c.env).userBytes);
	// A member who creates a repository in an organization administers it, as on GitHub; members alone only read.
	if (owner.role === "member") {
		await db(c.env)
			.prepare(`insert into "repo_collaborator" ("repoId", "userId", "permission", "state", "invitedBy", "createdAt") values (?, ?, 'admin', 'active', ?, ?)`)
			.bind(row.id, user.id, user.id, row.createdAt)
			.run();
	}
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
			importDepth: source ? undefined : input.importDepth,
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
		const used = await usage(db(c.env), owner.id);
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
	// Independent of each other, so one round trip instead of two.
	const [, listing] = await Promise.all([projects(c.env).getByName(row.id).setRepository(repositoryRef(c, row)), getListing(db(c.env), row.id, user.id)]);
	if (source && source.ownerId !== owner.id) {
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
	// newOwner already looked up the caller's role in an organization owner.
	return c.json({ repo: toRepoInfo(listing ?? row, origin(c), true, user.id, true, owner.id === user.id || owner.role === "owner"), project: created }, 201);
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
	importDepth?: number;
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

/** Repository settings, collaborators, webhooks, transfers, archiving and deletion: admins only. */
function adminAction(rest: string, method: string): boolean {
	if (rest === "/") return method === "PATCH" || method === "DELETE";
	if (rest === "/transfer" || rest === "/hooks" || rest.startsWith("/hooks/") || rest === "/collaborators" || rest.startsWith("/collaborators/")) return true;
	if (rest === "/protection") return method !== "GET";
	// Actions settings name the secrets and the Depot organization; reads are admins' too.
	if (rest === "/actions/settings" || rest === "/actions/depot" || rest.startsWith("/actions/secrets/")) return true;
	return false;
}

/** Transferring and deleting: the owner's (or, for an organization's repository, its owners'), not every admin's. */
function ownerAction(rest: string, method: string): boolean {
	if (rest === "/") return method === "DELETE";
	return rest === "/transfer" && (method === "POST" || method === "DELETE");
}

async function ownsRepo(c: Context<App>, row: RepoRow): Promise<boolean> {
	const p = c.var.principal;
	if (p.kind === "admin") return true;
	if (p.kind !== "user") return false;
	return p.id === row.ownerId || (await roleIn(db(c.env), row.ownerId, p.id)) === "owner";
}

/**
 * Whether a write is one a reader may make: starring and forking, and opening and discussing issues
 * (whose routes check authorship themselves).
 */
function readerAction(rest: string, method: string): boolean {
	if (READER_ACTIONS[rest]?.includes(method)) return true;
	if (rest === "/issues" || rest === "/pulls") return method === "POST";
	if (/^\/pulls\/\d+\/reviews$/.test(rest)) return method === "POST";
	if (/^\/issues\/\d+$/.test(rest)) return method === "PATCH";
	if (/^\/issues\/\d+\/comments$/.test(rest)) return method === "POST";
	if (/^\/issues\/\d+\/comments\/[^/]+$/.test(rest)) return method === "PATCH" || method === "DELETE";
	return false;
}
/**
 * Changes the owner can still make to an archived repository: its settings (unarchiving included),
 * deleting it, handing it on, and pausing or removing webhooks (a leaked secret shouldn't wait).
 */
function archivedAction(rest: string, method: string): boolean {
	if (rest === "/") return method === "PATCH" || method === "DELETE";
	if (rest === "/transfer") return method === "POST" || method === "DELETE";
	// Likewise Actions credentials can be removed, and runs cancelled (archiving cancels them, but one may slip through).
	if (method === "DELETE" && (rest === "/actions/depot" || /^\/actions\/secrets\/[^/]+$/.test(rest))) return true;
	if (method === "POST" && /^\/actions\/runs\/\d+\/cancel$/.test(rest)) return true;
	return /^\/hooks\/[^/]+$/.test(rest) && (method === "PATCH" || method === "DELETE");
}

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
	const p = c.var.principal;
	const row = await findRepo(db(c.env), owner, c.req.param("repo") ?? "", viewerId(p));
	if (!row || !canRead(p, row)) throw new HttpError(404, "NOT_FOUND", `${owner}/${c.req.param("repo")} not found`);
	const rest = routeRest(c, "");
	// Settings and the like belong to admins; their pages don't exist for anyone else.
	if (adminAction(rest, c.req.method) && !canAdmin(p, row)) {
		if (c.req.method === "GET") throw new HttpError(404, "NOT_FOUND", "Not found");
		throw new HttpError(p.kind === "anonymous" ? 401 : 403, "FORBIDDEN", "Only the repository's admins can do that");
	}
	// Handing a repository on or deleting it is for whoever owns it, not every admin (collaborators and teams included).
	if (ownerAction(rest, c.req.method) && !(await ownsRepo(c, row))) {
		throw new HttpError(403, "FORBIDDEN", `Only ${row.owner} (or its owners, for an organization) can transfer or delete ${row.owner}/${row.name}`);
	}
	const write = !["GET", "HEAD"].includes(c.req.method) && !readerAction(rest, c.req.method);
	if (write && !canWrite(p, row)) throw new HttpError(p.kind === "anonymous" ? 401 : 403, "FORBIDDEN", "You can't change this repository");
	// Archived means read-only for everyone: issues and comments too, but starring and forking still work.
	const mutating = !["GET", "HEAD"].includes(c.req.method) && !READER_ACTIONS[routeRest(c, "")]?.includes(c.req.method);
	if (mutating && row.archivedAt && !archivedAction(routeRest(c, ""), c.req.method)) {
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
	const info: RepoInfo | null = row ? toRepoInfo(listing ?? row, origin(c), canWrite(p, row), viewerId(p), canAdmin(p, row), await ownsRepo(c, row)) : null;
	const state = await project(c).getProject();
	// People reach user repositories through maggot's own git URL; the storage remote stays internal.
	return c.json({ project: info ? { ...state, name: info.fullName, remote: info.cloneUrl } : state, repo: info });
});

repo.patch("/", async (c) => {
	const row = c.var.repo;
	if (!row) throw new HttpError(400, "INVALID_INPUT", "Only user repositories have settings");
	const input = await body<{ visibility?: Visibility; description?: string | null; name?: string; archived?: boolean; hasWiki?: boolean }>(c);
	if (input.hasWiki !== undefined && typeof input.hasWiki !== "boolean") throw new HttpError(400, "INVALID_INPUT", "hasWiki is true or false");
	if (input.visibility !== undefined && input.visibility !== "public" && input.visibility !== "private") {
		throw new HttpError(400, "INVALID_INPUT", "visibility is public or private");
	}
	if (input.archived !== undefined && typeof input.archived !== "boolean") throw new HttpError(400, "INVALID_INPUT", "archived is true or false");
	if (input.name !== undefined && typeof input.name !== "string") throw new HttpError(400, "INVALID_INPUT", "name is a string");
	// While archived, only unarchiving (and deleting or transferring, elsewhere) is allowed.
	if (row.archivedAt && input.archived !== false && (input.visibility !== undefined || input.description !== undefined || input.name !== undefined || input.hasWiki !== undefined)) {
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
	await updateRepo(db(c.env), row.id, {
		visibility: input.visibility,
		description: input.description === undefined ? undefined : input.description?.trim() || null,
		hasWiki: input.hasWiki,
	});
	// Live sockets were authorized when they connected; after a visibility change they reconnect and are checked again.
	if (input.visibility !== undefined && input.visibility !== row.visibility) await project(c).disconnectAll("Visibility changed");
	if (input.name !== undefined) await project(c).setRepository(repositoryRef(c, row));
	const updated = (await getListing(db(c.env), row.id, viewerId(c.var.principal))) as RepoListing;
	return c.json({ repo: toRepoInfo(updated, origin(c), true, viewerId(c.var.principal), true, await ownsRepo(c, row)) });
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
	return c.json({ repos: rows.map((r) => toRepoInfo(r, origin(c), canWrite(p, r), viewerId(p), canAdmin(p, r))) });
});

// Forks into the caller's account; the name defaults to the source's.
repo.post("/forks", async (c) => {
	const source = userRepo(c);
	const input = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string; owner?: string };
	return createRepo(c, { name: input.name?.trim() || source.name, description: input.description, owner: input.owner }, source);
});

// ── Collaborators (admins only; see adminAction) ─────────────────────────────

repo.get("/collaborators", async (c) => c.json({ collaborators: await listCollaborators(db(c.env), userRepo(c).id) }));

repo.put("/collaborators/:username", async (c) => {
	const row = userRepo(c);
	const user = requireUser(c);
	const input = await body<{ permission?: string }>(c);
	const permission = assertPermission(input.permission);
	const result = await setCollaborator(db(c.env), row, c.req.param("username"), permission, user.id);
	// A changed grant (a downgrade, say) applies to views already open too.
	if (!result.invited) reauthorize(c, [row.id]);
	if (result.invited) {
		c.executionCtx.waitUntil(
			notifyUser(db(c.env), {
				userId: result.id,
				kind: "invitation",
				repoId: null,
				title: `${user.username} invited you to ${row.owner}/${row.name} (${permission})`,
				url: "/transfers",
				actor: user.username,
			}),
		);
	}
	return c.json({ collaborators: await listCollaborators(db(c.env), row.id) });
});

repo.delete("/collaborators/:username", async (c) => {
	const row = userRepo(c);
	await removeCollaborator(db(c.env), row.id, c.req.param("username"));
	reauthorize(c, [row.id]);
	return c.json({ collaborators: await listCollaborators(db(c.env), row.id) });
});

// ── Transfers: the owner offers the repository to another user, who accepts it from /transfers ─

repo.get("/transfer", async (c) => {
	const row = userRepo(c);
	return c.json({ transfer: await getTransfer(db(c.env), row.id) });
});

repo.post("/transfer", async (c) => {
	const user = requireUser(c);
	const row = userRepo(c);
	const { to } = await body<{ to?: string }>(c);
	const name = to?.trim().toLowerCase() ?? "";
	const recipient = name ? await db(c.env).prepare(`select "id", "username" from "user" where "username" = ?`).bind(name).first<{ id: string; username: string }>() : null;
	if (!recipient) throw new HttpError(404, "NOT_FOUND", `There's no user or organization called ${to?.trim() || "that"}`);
	if (recipient.id === row.ownerId) throw new HttpError(400, "INVALID_INPUT", "It already belongs there");
	// The offer is from the repository's owner (a person or an organization); an organization's owners accept for it.
	await offerTransfer(db(c.env), row.id, row.ownerId, recipient.id);
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
// Admin only: these are the storage backend's own credentials, so pushes with them skip maggot's limits.
repo.post("/credentials", async (c) => {
	requireAdmin(c);
	const { scope, ttlSeconds } = (await c.req.json().catch(() => ({}))) as { scope?: "read" | "write"; ttlSeconds?: number };
	if (scope !== undefined && scope !== "read" && scope !== "write") throw new HttpError(400, "INVALID_INPUT", "scope is read or write");
	if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 30 * 24 * 3600)) throw new HttpError(400, "INVALID_INPUT", "ttlSeconds is an integer from 1 to 2592000");
	return c.json(await project(c).repoAccess(scope, ttlSeconds));
});


// After an instance administrator pushes directly to storage, restore quota accounting and refresh views.
repo.post("/storage/recount", async (c) => {
	requireAdmin(c);
	const row = userRepo(c);
	const limits = policy(c.env);
	const used = await usage(db(c.env), row.ownerId);
	const room = Math.max(0, Math.min(limits.repoBytes, limits.userBytes - used.bytes + row.bytes));
	let size = await measureRepository(await project(c).gitRemote("read"), room);
	// Code and wiki uploads share the same quota, including a wiki that is currently hidden.
	const wiki = await project(c).wikiRemote("read");
	if (wiki && size <= room) size += await measureRepository(wiki, room - size);
	await setRepoBytes(db(c.env), row.id, size);
	if (size > room) throw new HttpError(403, "QUOTA_EXCEEDED", "The repository exceeds its storage quota");
	await project(c).pushed();
	return c.json({ bytes: size });
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

// The commits that changed one file: ?path=&ref=, and ?from=<commit> for older ones.
repo.get("/history", async (c) => {
	const path = c.req.query("path")?.replace(/^\/+|\/+$/g, "");
	if (!path) throw new HttpError(400, "INVALID_INPUT", "path is required");
	return c.json(await project(c).fileHistory(c.req.query("ref"), path, c.req.query("from")));
});

// Who last changed each line of a file: ?path=&ref=.
repo.get("/blame", async (c) => {
	const path = c.req.query("path")?.replace(/^\/+|\/+$/g, "");
	if (!path) throw new HttpError(400, "INVALID_INPUT", "path is required");
	// Blame reads every version of a file, so it's limited like search.
	const p = c.var.principal;
	if (p.kind !== "admin") await limit(c.env, p.kind === "user" ? `user:${p.id}` : `ip:${clientIp(c.req.raw)}`, rules.search(policy(c.env)), "Too many blame requests");
	return c.json(await project(c).blame(c.req.query("ref"), path));
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
		const label = ref && !ref.startsWith("task:") && ref !== at.commit ? ref.replace(/^refs\/(tags|heads)\//, "").replaceAll("/", "-") : at.commit.slice(0, 7);
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
/** Uploaded files (base64) may be bigger than edited text, and binary. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_COMMIT_BYTES = 25 * 1024 * 1024;

repo.post("/contents", async (c) => {
	// Up to 25 MB of files, base64 in JSON; anything far bigger isn't read at all.
	if (Number(c.req.header("content-length") ?? 0) > 40 * 1024 * 1024) throw new HttpError(413, "TOO_LARGE", "That's too much for one web commit");
	const row = c.var.repo;
	await requireCanCommit(c);
	const input = await body<{
		branch?: string;
		baseCommit?: string | null;
		newBranch?: string;
		message?: string;
		/** `encoding: "base64"` for uploaded (possibly binary) files; text otherwise. */
		files?: { path?: string; content?: string | null; previousPath?: string; encoding?: "base64" }[];
	}>(c);
	const message = input.message?.trim();
	if (!message) throw new HttpError(400, "INVALID_INPUT", "A commit message is required");
	if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100) throw new HttpError(400, "INVALID_INPUT", "Give 1 to 100 files");
	const encoder = new TextEncoder();
	const seen = new Set<string>();
	let total = 0;
	const changes = input.files.map((f) => {
		const path = normalizeRepoPath(f.path ?? "");
		if (seen.has(path)) throw new HttpError(400, "INVALID_INPUT", `${path} is listed twice`);
		seen.add(path);
		if (f.content !== null && typeof f.content !== "string") throw new HttpError(400, "INVALID_INPUT", `Content for ${path} must be a string, or null to delete it`);
		if (f.encoding !== undefined && f.encoding !== "base64") throw new HttpError(400, "INVALID_INPUT", "encoding is base64, or left out for text");
		const content = f.content === null ? null : f.encoding === "base64" ? decodeBase64(f.content, path) : encoder.encode(f.content);
		const max = f.encoding === "base64" ? MAX_UPLOAD_BYTES : MAX_EDIT_BYTES;
		if (content && content.length > max) {
			throw new HttpError(413, "TOO_LARGE", `${path} is over ${formatBytes(max)}; push it with git instead`);
		}
		total += content?.length ?? 0;
		if (total > MAX_COMMIT_BYTES) throw new HttpError(413, "TOO_LARGE", `One web commit can add at most ${formatBytes(MAX_COMMIT_BYTES)}; push the rest with git`);
		// A rename keeps the file's mode (an executable stays executable).
		return { path, content, modeFrom: f.previousPath ? normalizeRepoPath(f.previousPath) : undefined };
	});
	const branch = input.branch?.trim() || (await project(c).getProject()).defaultBranch;
	const result = await project(c).commitFiles({
		maxPackBytes: await webCommitRoom(c),
		branch,
		baseCommit: input.baseCommit,
		newBranch: input.newBranch?.trim() || undefined,
		changes,
		message: message.slice(0, 10_000),
		author: webAuthor(c),
	});
	if (row) c.executionCtx.waitUntil(addRepoBytes(db(c.env), row.id, result.packBytes));
	return c.json(result, 201);
});

/** Who a web commit (to the code or the wiki) is by: the signed-in user, with a no-reply address. */
function webAuthor(c: Context<App>): { name: string; email: string } {
	const p = c.var.principal;
	return p.kind === "user" ? { name: p.username, email: `${p.username}@users.noreply.${new URL(c.req.url).hostname}` } : { name: "maggot", email: "admin@maggot.dev" };
}

/**
 * How big a web commit's pack may be. A web commit is a push: it has the push size limit, and has to
 * fit what the repository and its owner have left.
 */
async function webCommitRoom(c: Context<App>): Promise<number> {
	const row = c.var.repo;
	const limits = policy(c.env);
	if (!row) return limits.pushBytes;
	const used = await usage(db(c.env), row.ownerId);
	return Math.min(limits.pushBytes, limits.repoBytes - row.bytes, limits.userBytes - used.bytes);
}

/** What a web commit needs before it starts: a verified email, and the repository not over its quota. */
async function requireCanCommit(c: Context<App>) {
	requireVerified(c.env, c.var.principal);
	const row = c.var.repo;
	if (!row) return;
	const blocked = await pushBlocked(c.env, db(c.env), row);
	if (blocked) throw new HttpError(403, "QUOTA_EXCEEDED", blocked);
}

function decodeBase64(data: string, path: string): Uint8Array {
	try {
		const binary = atob(data);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		throw new HttpError(400, "INVALID_INPUT", `The content of ${path} isn't valid base64`);
	}
}

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

// ── Wiki: Markdown pages in a repository of their own (see src/wiki.ts) ───────
// Reads need read access and writes write access (the middleware above); archived repositories'
// wikis are read-only. A wiki its admins turned off answers 404, but its pages are kept.

const wiki = new Hono<App>();

wiki.use("*", async (c, next) => {
	if (c.var.repo && !c.var.repo.hasWiki) throw new HttpError(404, "NOT_FOUND", "This repository's wiki is turned off");
	return next();
});

/** A page's text from a request: Markdown, at most the size the file editor takes. */
function pageContent(content: unknown): string | undefined {
	if (content === undefined) return undefined;
	if (typeof content !== "string") throw new HttpError(400, "INVALID_INPUT", "content is the page's Markdown");
	if (new TextEncoder().encode(content).length > MAX_EDIT_BYTES) throw new HttpError(413, "TOO_LARGE", `Pages are at most ${formatBytes(MAX_EDIT_BYTES)}; push bigger ones with git`);
	return content;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new HttpError(400, "INVALID_INPUT", `${name} is a string`);
	return value.slice(0, max);
}

function baseCommitOf(value: unknown): string | null | undefined {
	if (value === undefined || value === null || (typeof value === "string" && /^[0-9a-f]{40}$/.test(value))) return value as string | null | undefined;
	throw new HttpError(400, "INVALID_INPUT", "baseCommit is the wiki head the edit started from, or null");
}

/** A wiki change counts toward the repository's size like any other push. */
function countWikiCommit(c: Context<App>, packBytes: number) {
	if (c.var.repo) c.executionCtx.waitUntil(addRepoBytes(db(c.env), c.var.repo.id, packBytes));
}

wiki.get("/", async (c) => {
	c.header("cache-control", "no-store");
	return c.json(await project(c).wikiIndex());
});

wiki.get("/pages/:page", async (c) => {
	c.header("cache-control", "no-store");
	return c.json({ page: await project(c).wikiPage(c.req.param("page")) });
});

wiki.get("/pages/:page/history", async (c) => c.json(await project(c).wikiHistory(c.req.param("page"), c.req.query("from"))));

// Creates a page: { title, content, message? }.
wiki.post("/pages", async (c) => {
	await requireCanCommit(c);
	const input = await body<{ title?: unknown; content?: unknown; message?: unknown; baseCommit?: unknown }>(c);
	if (typeof input.title !== "string") throw new HttpError(400, "INVALID_INPUT", "title is required");
	const result = await project(c).wikiSave({
		title: input.title,
		content: pageContent(input.content ?? ""),
		message: optionalText(input.message, "message", 10_000),
		baseCommit: baseCommitOf(input.baseCommit),
		author: webAuthor(c),
		maxPackBytes: await webCommitRoom(c),
	});
	countWikiCommit(c, result.packBytes);
	return c.json({ page: result.page, commit: result.commit }, 201);
});

// Edits a page, renames it (a new title), or both: { title?, content?, message?, baseCommit }.
wiki.patch("/pages/:page", async (c) => {
	await requireCanCommit(c);
	const input = await body<{ title?: unknown; content?: unknown; message?: unknown; baseCommit?: unknown }>(c);
	const result = await project(c).wikiSave({
		page: c.req.param("page"),
		title: optionalText(input.title, "title", 1000),
		content: pageContent(input.content),
		message: optionalText(input.message, "message", 10_000),
		baseCommit: baseCommitOf(input.baseCommit),
		author: webAuthor(c),
		maxPackBytes: await webCommitRoom(c),
	});
	countWikiCommit(c, result.packBytes);
	return c.json({ page: result.page, commit: result.commit });
});

// Deletes a page: an optional body { message?, baseCommit? }.
wiki.delete("/pages/:page", async (c) => {
	await requireCanCommit(c);
	const input = (await c.req.json().catch(() => ({}))) as { message?: unknown; baseCommit?: unknown };
	const result = await project(c).wikiDelete({
		page: c.req.param("page"),
		message: optionalText(input.message, "message", 10_000),
		baseCommit: baseCommitOf(input.baseCommit),
		author: webAuthor(c),
		maxPackBytes: await webCommitRoom(c),
	});
	countWikiCommit(c, result.packBytes);
	return c.json({ deleted: true, commit: result.commit });
});

// Raw bytes of a file in the wiki (images pages show), sandboxed like /raw.
wiki.get("/raw", async (c) => {
	const path = c.req.query("path")?.replace(/^\/+/, "");
	if (!path) throw new HttpError(400, "INVALID_INPUT", "path is required");
	const missing = () => new HttpError(404, "NOT_FOUND", `${path} not found`);
	using store = await repoStore(c.env)
		.get(wikiRepoName(c.var.projectId))
		.catch((err) => {
			throw toHttpError(err).status === 404 ? missing() : err;
		});
	const blob = await store.readFile({ ref: WIKI_BRANCH, path });
	if (!blob) throw missing();
	return c.body(blob.stream(), 200, {
		"content-type": blob.type || "application/octet-stream",
		"content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.split("/").pop() ?? "file")}`,
		...INERT,
		"cache-control": "private, no-cache",
	});
});

repo.route("/wiki", wiki);

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

// ?summary=0 leaves out each tag's commit summary, for pickers that only need names.
repo.get("/tags", async (c) => c.json({ tags: await project(c).tags(c.req.query("summary") !== "0") }));

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

// Newest first, `limit` at a time (default 20); `more` says there are older ones.
repo.get("/releases", async (c) => c.json(await project(c).releases(intParam(c.req.query("limit"), 20, 200))));

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
	const input = await body<{ pattern?: string; blockDeletions?: boolean; blockForcePushes?: boolean; requireMergeQueue?: boolean; requireReview?: boolean; requireChecks?: boolean }>(c);
	if (typeof input.pattern !== "string") throw new HttpError(400, "INVALID_INPUT", "pattern is required");
	const rules = await project(c).setBranchRule({
		pattern: input.pattern.trim(),
		blockDeletions: input.blockDeletions === true,
		blockForcePushes: input.blockForcePushes === true,
		requireMergeQueue: input.requireMergeQueue === true,
		requireReview: input.requireReview === true,
		requireChecks: input.requireChecks === true,
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
	requireUser(c);
	const input = await body<{ title?: string; body?: string; labels?: unknown }>(c);
	const text = issueText(input, true);
	// Only the owner labels issues.
	const labels = input.labels !== undefined && canWrite(c.var.principal, row) ? cleanLabels(input.labels) : [];
	const user = await canPost(c);
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
	const { comments, earlier } = await listComments(db(c.env), issue.id, { id: me, owner });
	return c.json({ issue: toIssue(issue, owner || (me !== null && me === issue.authorId), owner), comments, earlier });
});

// Earlier comments, a page at a time: ?before=<comment id>.
repo.get("/issues/:number/comments", async (c) => {
	const row = userRepo(c);
	const issue = await loadIssue(c);
	const before = c.req.query("before");
	if (!before) throw new HttpError(400, "INVALID_INPUT", "before is required");
	return c.json(await listComments(db(c.env), issue.id, { id: viewerId(c.var.principal), owner: canWrite(c.var.principal, row) }, before));
});

/** A merged pull request stays merged: closing or reopening it would leave it counted as open but unmergeable. */
async function assertNotMerged(c: Context<App>, issueId: string): Promise<void> {
	const merged = await db(c.env).prepare(`select 1 from "pull" where "issueId" = ? and "mergedAt" is not null`).bind(issueId).first();
	if (merged) throw new HttpError(409, "ALREADY_MERGED", "This pull request is merged, so it can't be closed or reopened");
}

repo.patch("/issues/:number", async (c) => {
	const row = userRepo(c);
	const user = requireUser(c);
	const issue = await loadIssue(c);
	const owner = canWrite(user, row);
	if (!owner && user.id !== issue.authorId) throw new HttpError(403, "FORBIDDEN", "Only the issue's author and the repository's owner can change it");
	const input = await body<{ title?: string; body?: string; state?: IssueState; labels?: unknown }>(c);
	if (input.state !== undefined && input.state !== "open" && input.state !== "closed") throw new HttpError(400, "INVALID_INPUT", "state is open or closed");
	if (input.labels !== undefined && !owner) throw new HttpError(403, "FORBIDDEN", "Only the repository's owner can label issues");
	if (input.state !== undefined && input.state !== issue.state) await assertNotMerged(c, issue.id);
	const updated = await updateIssue(db(c.env), issue, {
		...issueText(input, false),
		state: input.state,
		labels: input.labels === undefined ? undefined : cleanLabels(input.labels),
		by: user.id,
	});
	if (input.state && input.state !== issue.state) announceIssue(c, row, updated, input.state === "closed" ? "closed" : "reopened", user);
	if (input.state === "open" && issue.state !== "open") reopenedPull(c, row, issue.number);
	if (input.state === "closed" && issue.state !== "closed") closedPull(c, row, issue.number, false);
	return c.json({ issue: toIssue(updated, true, owner) });
});

// A comment, optionally closing or reopening the issue in the same request ("Close with comment").
repo.post("/issues/:number/comments", async (c) => {
	const row = userRepo(c);
	requireUser(c);
	const issue = await loadIssue(c);
	const input = await body<{ body?: string; state?: IssueState }>(c);
	const text = typeof input.body === "string" ? input.body.trim() : "";
	if (!text) throw new HttpError(400, "INVALID_INPUT", "A comment needs some text");
	if (text.length > MAX_ISSUE_BODY) throw new HttpError(400, "INVALID_INPUT", `Comments are up to ${MAX_ISSUE_BODY / 1024} KB`);
	if (input.state !== undefined && input.state !== "open" && input.state !== "closed") throw new HttpError(400, "INVALID_INPUT", "state is open or closed");
	const owner = canWrite(c.var.principal, row);
	const changing = input.state !== undefined && input.state !== issue.state;
	if (changing && !owner && c.var.principal.kind === "user" && c.var.principal.id !== issue.authorId) {
		throw new HttpError(403, "FORBIDDEN", "Only the issue's author and the repository's owner can close or reopen it");
	}
	if (changing) await assertNotMerged(c, issue.id);
	const user = await canPost(c);
	const comment = await addComment(db(c.env), issue, user.id, text, { id: user.id, owner });
	announceIssue(c, row, issue, "commented", user, { comment: { id: comment.id, body: text.slice(0, 2000) } });
	let updated = issue;
	if (changing) {
		updated = await updateIssue(db(c.env), issue, { state: input.state, by: user.id });
		announceIssue(c, row, updated, input.state === "closed" ? "closed" : "reopened", user);
		if (input.state === "open") reopenedPull(c, row, issue.number);
		else closedPull(c, row, issue.number, false);
	}
	return c.json({ comment, issue: toIssue(updated, true, owner) }, 201);
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

// ── Pull requests and code review ────────────────────────────────────────────

/**
 * Where a pull request's changes come from: a branch of this repository, or of `headRepo`
 * ("owner/name"), which has to be a fork of it that the caller can read.
 */
async function pullHead(c: Context<App>, headRepo: unknown): Promise<RepoRow | null> {
	const row = userRepo(c);
	if (headRepo === undefined || headRepo === null || headRepo === "" || headRepo === `${row.owner}/${row.name}`) return null;
	if (typeof headRepo !== "string" || !headRepo.includes("/")) throw new HttpError(400, "INVALID_INPUT", "headRepo is owner/name");
	const [owner, name] = headRepo.split("/");
	const fork = await findRepo(db(c.env), owner, name, viewerId(c.var.principal));
	if (!fork || !canRead(c.var.principal, fork)) throw new HttpError(404, "NOT_FOUND", `${headRepo} not found`);
	if (fork.forkOf !== row.id) throw new HttpError(400, "INVALID_INPUT", `${headRepo} isn't a fork of ${row.owner}/${row.name}`);
	return fork;
}

function pullBranch(name: unknown, what: string): string {
	if (typeof name !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes("..")) throw new HttpError(400, "INVALID_INPUT", `${what} is a branch name`);
	return name;
}

async function loadPull(c: Context<App>): Promise<PullRow> {
	const pull = await getPull(db(c.env), userRepo(c).id, issueNumber(c));
	if (!pull) throw new HttpError(404, "NOT_FOUND", `Pull request #${c.req.param("number")} not found`);
	return pull;
}

/**
 * The repository a pull request's changes are read from (null for this one), checked again on every read:
 * a fork that's private, or went private, shows its branch only to people who can read the fork.
 */
async function liveHead(c: Context<App>, pull: PullRow): Promise<string | null> {
	// Same-repository pull requests record this repository as the head; null means the fork was deleted.
	if (pull.headRepoId === null) throw new HttpError(410, "HEAD_GONE", "The fork this pull request came from has been deleted");
	if (pull.headRepoId === pull.repoId) return null;
	const fork = pull.headOwner && pull.headName ? await findRepo(db(c.env), pull.headOwner, pull.headName, viewerId(c.var.principal)) : null;
	if (!fork || fork.id !== pull.headRepoId || !canRead(c.var.principal, fork)) {
		throw new HttpError(403, "HEAD_PRIVATE", "The changes are in a private fork; only people who can read it see them");
	}
	return pull.headRepoId;
}

/** What branch rules on `base` want before a pull request merges into it. */
async function mergeRequirements(c: Context<App>, base: string): Promise<{ review: boolean; checks: boolean }> {
	const rule = protectionFor(await project(c).getBranchRules(), base);
	return { review: rule.requireReview, checks: rule.requireChecks };
}

/** Tells the people involved and records the event (feed and pull_request webhooks). */
function announcePull(c: Context<App>, row: RepoRow, pull: PullRow, type: "pull.opened" | "pull.reviewed" | "pull.merged", actor: { id: string; username: string }, extra: Record<string, unknown> = {}) {
	c.executionCtx.waitUntil(
		(async () => {
			const people = new Set([row.ownerId, ...(type === "pull.opened" ? [] : await issueParticipants(db(c.env), pull.id))]);
			people.delete(actor.id);
			const verb = type === "pull.opened" ? "opened" : type === "pull.merged" ? "merged" : extra.state === "approved" ? "approved" : extra.state === "changes_requested" ? "requested changes on" : "reviewed";
			await Promise.all(
				[...people].map((userId) =>
					notifyUser(db(c.env), {
						userId,
						kind: "issue",
						repoId: row.id,
						title: `${actor.username} ${verb} pull request #${pull.number}: ${pull.title}`,
						url: `/${row.owner}/${row.name}/pull/${pull.number}`,
						actor: actor.username,
					}),
				),
			);
			await project(c).recordPullEvent(type, {
				pull: { number: pull.number, title: pull.title, base: pull.baseBranch, head: pull.headBranch, url: `${origin(c)}/${row.owner}/${row.name}/pull/${pull.number}` },
				sender: actor.username,
				...extra,
			});
		})().catch((err) => console.error("announcing pull request activity failed", err)),
	);
}

/** What starts a pull request's runs: where its head is, and whether whoever caused it can write here (else they wait for approval). */
function pullTrigger(c: Context<App>, row: RepoRow, pull: PullRow, head: string) {
	const fork = pull.headRepoId !== null && pull.headRepoId !== row.id;
	const owner = fork ? pull.headOwner : row.owner;
	const name = fork ? pull.headName : row.name;
	if (pull.headRepoId === null || !owner || !name) return null;
	const user = c.var.principal;
	return {
		number: pull.number,
		headRepo: fork ? pull.headRepoId : null,
		cloneUrl: `${origin(c)}/${owner}/${name}.git`,
		branch: pull.headBranch,
		sha: head,
		baseBranch: pull.baseBranch,
		fromFork: fork,
		actor: user.kind === "user" ? user.username : null,
		author: pull.author,
	};
}

/**
 * Starts a pull request's pull_request workflows for its head commit, in the background. They wait for
 * approval unless whoever opened (or reopened) it can merge, whether it's from a fork or a branch here.
 * If this doesn't get through, the pull request's checks show them missing, for a writer to start.
 */
function startPullChecks(c: Context<App>, row: RepoRow, pull: PullRow, head: string, action: "opened" | "reopened") {
	const trigger = pullTrigger(c, row, pull, head);
	if (!trigger) return;
	c.executionCtx.waitUntil(
		project(c)
			.ciPull({ ...trigger, action, approved: canWrite(c.var.principal, row) })
			.catch((err) => console.error("starting pull request Actions failed", err)),
	);
}

/** A pull request closed or merged: its runs waiting for approval (and, if closed, the running ones) are cancelled. */
function closedPull(c: Context<App>, row: RepoRow, number: number, merged: boolean) {
	c.executionCtx.waitUntil(
		(async () => {
			if (!merged && !(await getPull(db(c.env), row.id, number))) return;
			await project(c).ciClosePull(number, merged);
		})().catch((err) => console.error("stopping pull request Actions failed", err)),
	);
}

/** A pull request reopened: its head may have moved while it was closed, so its Actions start again (idempotently). */
function reopenedPull(c: Context<App>, row: RepoRow, number: number) {
	c.executionCtx.waitUntil(
		(async () => {
			const pull = await getPull(db(c.env), row.id, number);
			if (!pull || pull.headRepoId === null || pull.mergedAt) return;
			const head = (await project(c).pullCompare(pull.baseBranch, pull.headRepoId === row.id ? null : pull.headRepoId, pull.headBranch)).head;
			startPullChecks(c, row, pull, head, "reopened");
		})().catch((err) => console.error("starting pull request Actions failed", err)),
	);
}

repo.get("/pulls", async (c) => {
	const state = c.req.query("state");
	return c.json(
		await listPulls(db(c.env), userRepo(c).id, {
			state: state === "closed" || state === "all" ? state : "open",
			query: c.req.query("q")?.trim().slice(0, 100) || undefined,
			limit: intParam(c.req.query("limit"), 50, 200),
		}),
	);
});

// What a pull request from `head` (of `headRepo`) into `base` would bring, before opening it.
repo.get("/pulls/compare", async (c) => {
	userRepo(c);
	const base = pullBranch(c.req.query("base"), "base");
	const head = pullBranch(c.req.query("head"), "head");
	const fork = await pullHead(c, c.req.query("headRepo"));
	return c.json({ comparison: await project(c).pullCompare(base, fork?.id ?? null, head) });
});

repo.post("/pulls", async (c) => {
	const row = userRepo(c);
	requireUser(c);
	const input = await body<{ title?: string; body?: string; base?: string; head?: string; headRepo?: string }>(c);
	const text = issueText(input, true);
	const base = pullBranch(input.base, "base");
	const head = pullBranch(input.head, "head");
	const fork = await pullHead(c, input.headRepo);
	if (!fork && base === head) throw new HttpError(400, "INVALID_INPUT", "The head and base branches are the same");
	const comparison = await project(c).pullCompare(base, fork?.id ?? null, head);
	if (comparison.commits.length === 0) throw new HttpError(422, "NOTHING_TO_COMPARE", `${head} has nothing that ${base} doesn't`);
	const open = await db(c.env)
		.prepare(`select i."number" from "pull" p join "issue" i on i."id" = p."issueId" where p."repoId" = ? and p."headRepoId" is ? and p."headBranch" = ? and p."baseBranch" = ? and i."state" = 'open'`)
		.bind(row.id, fork?.id ?? row.id, head, base)
		.first<{ number: number }>();
	if (open) throw new HttpError(409, "ALREADY_EXISTS", `Pull request #${open.number} is already open for ${head}`);
	const user = await canPost(c);
	const issue = await createIssue(db(c.env), row.id, user.id, text.title as string, text.body ?? "", [], { headRepoId: fork?.id ?? row.id, headBranch: head, baseBranch: base });
	const pull = (await getPull(db(c.env), row.id, issue.number)) as PullRow;
	announcePull(c, row, pull, "pull.opened", user);
	startPullChecks(c, row, pull, comparison.head, "opened");
	return c.json({ pull: toPull(pull, { edit: true, label: canWrite(user, row), merge: canWrite(user, row) }, await mergeRequirements(c, base)) }, 201);
});

repo.get("/pulls/:number", async (c) => {
	const row = userRepo(c);
	const pull = await loadPull(c);
	const p = c.var.principal;
	const owner = canWrite(p, row);
	const me = viewerId(p);
	const [{ comments, earlier }, review, required] = await Promise.all([
		listComments(db(c.env), pull.id, { id: me, owner }),
		listReviews(db(c.env), pull.id),
		mergeRequirements(c, pull.baseBranch),
	]);
	return c.json({
		pull: toPull(pull, { edit: owner || (me !== null && me === pull.authorId), label: owner, merge: owner && !row.archivedAt }, required),
		comments,
		earlier,
		reviews: review.reviews,
		reviewComments: review.comments,
	});
});

// The changes: live from the branches while open, or what the merge brought in once merged.
repo.get("/pulls/:number/files", async (c) => {
	const pull = await loadPull(c);
	// Once merged, the branches may be gone or moved on; what landed is the merge (or squashed) commit.
	if (pull.mergedAt && pull.mergeCommit) {
		const { commit, diff } = await project(c).commit(pull.mergeCommit);
		const comparison: Comparison = { base: commit.parents[0] ?? commit.hash, head: commit.hash, mergeBase: commit.parents[0] ?? null, commits: [commit], capped: false, diff };
		return c.json({ comparison });
	}
	return c.json({ comparison: await project(c).pullCompare(pull.baseBranch, await liveHead(c, pull), pull.headBranch) });
});

// The checks on an open pull request's head, judged as its merge would be.
async function pullChecks(c: Context<App>, pull: PullRow): Promise<PullChecks> {
	if (pull.state !== "open" || pull.mergedAt) throw new HttpError(409, "PULL_CLOSED", "Only an open pull request's checks are shown");
	const row = userRepo(c);
	const checks = await project(c).ciPullChecks({ number: pull.number, base: pull.baseBranch, headRepo: await liveHead(c, pull), branch: pull.headBranch });
	return { ...checks, canStart: canWrite(c.var.principal, row) && !row.archivedAt };
}

repo.get("/pulls/:number/checks", async (c) => c.json(await pullChecks(c, await loadPull(c))));

// Creates the runs the checks list as missing, and nothing else (write access). Where the pull request's
// runs wait for approval (a fork's, or one a reader opened), these wait too, for Approve.
repo.post("/pulls/:number/checks", async (c) => {
	const row = userRepo(c);
	requireVerified(c.env, c.var.principal);
	const pull = await loadPull(c);
	const before = await pullChecks(c, pull);
	const trigger = pullTrigger(c, row, pull, before.head);
	if (!trigger) throw new HttpError(410, "HEAD_GONE", "The fork this pull request came from has been deleted");
	await project(c).ciStartPull(trigger, before.missing);
	return c.json(await pullChecks(c, pull));
});

repo.post("/pulls/:number/reviews", async (c) => {
	const row = userRepo(c);
	requireUser(c);
	const pull = await loadPull(c);
	if (pull.state !== "open") throw new HttpError(409, "PULL_CLOSED", "This pull request is closed");
	const input = await body<{ state?: ReviewState; body?: string; commit?: string; comments?: { path?: unknown; line?: unknown; side?: unknown; body?: unknown }[] }>(c);
	const state = input.state ?? "commented";
	if (state !== "approved" && state !== "changes_requested" && state !== "commented") throw new HttpError(400, "INVALID_INPUT", "state is approved, changes_requested or commented");
	const p = c.var.principal as Extract<Principal, { kind: "user" }>;
	if (state !== "commented") {
		if (!canWrite(p, row)) throw new HttpError(403, "FORBIDDEN", "Only people who can merge can approve or request changes; leave a comment instead");
		if (p.id === pull.authorId) throw new HttpError(403, "FORBIDDEN", "You can't approve or request changes on your own pull request");
	}
	const text = typeof input.body === "string" ? input.body.trim() : "";
	if (text.length > MAX_ISSUE_BODY) throw new HttpError(400, "INVALID_INPUT", `A review is up to ${MAX_ISSUE_BODY / 1024} KB`);
	const raw = Array.isArray(input.comments) ? input.comments : [];
	if (raw.length > MAX_REVIEW_COMMENTS) throw new HttpError(400, "INVALID_INPUT", `A review can have up to ${MAX_REVIEW_COMMENTS} line comments`);
	const comments = raw.map((k) => {
		if (typeof k.path !== "string" || !k.path || k.path.length > 4096) throw new HttpError(400, "INVALID_INPUT", "Each comment needs a path");
		if (!Number.isInteger(k.line) || (k.line as number) < 1) throw new HttpError(400, "INVALID_INPUT", "Each comment needs a line number");
		if (k.side !== "new" && k.side !== "old") throw new HttpError(400, "INVALID_INPUT", "side is new or old");
		if (typeof k.body !== "string" || !k.body.trim() || k.body.length > MAX_ISSUE_BODY) throw new HttpError(400, "INVALID_INPUT", "Each comment needs some text");
		return { path: k.path, line: k.line as number, side: k.side as "new" | "old", body: k.body.trim() };
	});
	if (state === "commented" && !text && comments.length === 0) throw new HttpError(400, "INVALID_INPUT", "A review needs a comment, line comments, or an approval");
	const user = await canPost(c);
	let commit = typeof input.commit === "string" && /^[0-9a-f]{40}$/.test(input.commit) ? input.commit : null;
	if (state !== "commented") {
		// A verdict is about the branch as it is now: recorded against its head, and refused if the reviewer saw an older one.
		const head = (await project(c).pullCompare(pull.baseBranch, await liveHead(c, pull), pull.headBranch)).head;
		if (commit && commit !== head) throw new HttpError(409, "HEAD_MOVED", `${pull.headBranch} has new commits since you looked; review them first`);
		commit = head;
	}
	const id = await addReview(db(c.env), pull, user.id, { state, body: text, commit, comments });
	announcePull(c, row, pull, "pull.reviewed", user, { state, review: { id, body: text.slice(0, 2000), comments: comments.length } });
	return c.json({ review: id }, 201);
});

repo.post("/pulls/:number/merge", async (c) => {
	const row = userRepo(c);
	const user = requireUser(c);
	requireVerified(c.env, user);
	const pull = await loadPull(c);
	if (pull.mergedAt) throw new HttpError(409, "ALREADY_MERGED", "This pull request is already merged");
	if (pull.state !== "open") throw new HttpError(409, "PULL_CLOSED", "Reopen the pull request to merge it");
	const input = (await c.req.json().catch(() => ({}))) as { method?: MergeMethod; expectedHead?: string };
	const method = input.method ?? "merge";
	if (method !== "merge" && method !== "squash") throw new HttpError(400, "INVALID_INPUT", "method is merge or squash");
	if (input.expectedHead !== undefined && (typeof input.expectedHead !== "string" || !/^[0-9a-f]{40}$/.test(input.expectedHead))) {
		throw new HttpError(400, "INVALID_INPUT", "expectedHead is a commit hash");
	}
	// Whoever merges has to be able to see what they're merging.
	const headRepo = await liveHead(c, pull);
	let expectedHead = input.expectedHead;
	const required = await mergeRequirements(c, pull.baseBranch);
	if (required.review) {
		// The approval has to be of the commit that merges, not of an earlier one.
		const head = expectedHead ?? (await project(c).pullCompare(pull.baseBranch, headRepo, pull.headBranch)).head;
		if (pull.decision !== "approved" || !(await approvedAt(db(c.env), pull, head))) {
			throw new HttpError(403, "REVIEW_REQUIRED", `${pull.baseBranch} needs an approving review of the latest commit before pull requests merge into it`);
		}
		expectedHead = head;
	}
	// Actions have to have passed on the very commit that merges. Only asked when the branch wants them:
	// judging the checks reads the base's workflow files from storage.
	if (required.checks) {
		const checks = await project(c).ciPullChecks({ number: pull.number, base: pull.baseBranch, headRepo, branch: pull.headBranch, sha: expectedHead });
		if (checks.required) {
			if (checks.reason) throw new HttpError(403, "CHECKS_REQUIRED", `${pull.baseBranch} requires Actions to pass. ${checks.reason}`);
			expectedHead = checks.head;
		}
	}
	const from = pull.headOwner && headRepo ? `${pull.headOwner}:${pull.headBranch}` : pull.headBranch;
	const message = method === "squash" ? `${pull.title} (#${pull.number})\n\n${pull.body}`.trim() : `Merge pull request #${pull.number} from ${from}\n\n${pull.title}`;
	const result = await project(c).mergePull({
		base: pull.baseBranch,
		headRepo,
		headBranch: pull.headBranch,
		method,
		message,
		author: { name: user.username, email: `${user.username}@users.noreply.${new URL(c.req.url).hostname}` },
		expectedHead,
		// The coordinator checks the branch's rules again right before pushing: they may change while this waits its turn.
		pull: pull.number,
	});
	await markPullMerged(db(c.env), pull, user.id, result.commit);
	closedPull(c, row, pull.number, true);
	// "Fixes #n" in the description closes those issues too, as GitHub does.
	const fixes = [...new Set([...`${pull.title}\n${pull.body}`.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)].map((m) => Number(m[1])))];
	// The row's default branch is the coordinator's (it's set once, at creation), without a trip to storage for the head.
	if (fixes.length > 0 && pull.baseBranch === row.defaultBranch) {
		c.executionCtx.waitUntil(closeIssuesByCommits(c.env, row.id, fixes.filter((n) => n !== pull.number).slice(0, 50).map((n) => [n, result.commit])).catch(() => []));
	}
	announcePull(c, row, pull, "pull.merged", user, { method, commit: result.commit });
	const merged = (await getPull(db(c.env), row.id, pull.number)) as PullRow;
	return c.json({ pull: toPull(merged, { edit: true, label: true, merge: true }, { review: false, checks: false }), commit: result.commit });
});

// ── Webhooks (owner only, reads included: they show URLs and payloads) ─────────


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


repo.route("/actions", actions);
app.route("/api/ci", jobApi);

app.route("/api/repos/:owner/:repo", repo);
app.route("/api/projects/:project", repo);

export default app satisfies ExportedHandler<Env>;
