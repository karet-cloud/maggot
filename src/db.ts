// D1: Better Auth's tables (users, sessions, accounts), repository records and personal access tokens.
// The schema is created idempotently on first use in each isolate, so deploys need no migration step.
import type { Notification, NotificationKind, RepoInfo, Visibility } from "./api.ts";
import { HttpError } from "./errors.ts";

// Generated from Better Auth 1.7 (email/password + username plugin) with getMigrations().compileMigrations().
const AUTH_SCHEMA = [
	`create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "username" text unique, "displayUsername" text)`,
	`create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
	`create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
	`create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
	`create index if not exists "session_userId_idx" on "session" ("userId")`,
	`create index if not exists "account_userId_idx" on "account" ("userId")`,
	`create index if not exists "verification_identifier_idx" on "verification" ("identifier")`,
];

const APP_SCHEMA = [
	// `id` is the internal project name: the coordinator Durable Object and the Artifacts repo use it,
	// so owner/name can change later without moving any Git data.
	`create table if not exists "repo" ("id" text not null primary key, "ownerId" text not null references "user" ("id") on delete cascade, "owner" text not null, "name" text not null collate nocase, "description" text, "visibility" text not null check ("visibility" in ('public', 'private')), "defaultBranch" text not null, "createdAt" text not null, unique ("owner", "name"))`,
	`create index if not exists "repo_public_idx" on "repo" ("visibility", "createdAt")`,
	`create index if not exists "repo_owner_idx" on "repo" ("ownerId")`,
	`create table if not exists "token" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "name" text not null, "hash" text not null unique, "prefix" text not null, "createdAt" text not null, "lastUsedAt" text)`,
	`create index if not exists "token_userId_idx" on "token" ("userId")`,
	`create table if not exists "star" ("userId" text not null references "user" ("id") on delete cascade, "repoId" text not null references "repo" ("id") on delete cascade, "createdAt" text not null, primary key ("userId", "repoId"))`,
	`create index if not exists "star_repoId_idx" on "star" ("repoId")`,
	`create table if not exists "notification" ("id" text not null primary key, "userId" text not null references "user" ("id") on delete cascade, "kind" text not null, "repoId" text references "repo" ("id") on delete cascade, "title" text not null, "url" text not null, "actor" text, "createdAt" text not null, "readAt" text)`,
	`create index if not exists "notification_user_idx" on "notification" ("userId", "createdAt")`,
];

/** Columns added after a table was first created; adding one that exists fails harmlessly. */
const COLUMNS = [
	// Bytes pushed to the repository, which quotas are checked against.
	`alter table "repo" add column "bytes" integer not null default 0`,
	`alter table "repo" add column "forkOf" text references "repo" ("id") on delete set null`,
];

/** Indexes on added columns, created once the columns exist. */
const LATE_INDEXES = [`create index if not exists "repo_forkOf_idx" on "repo" ("forkOf")`];

const ready = new WeakMap<D1Database, Promise<void>>();

export function db(env: Env): D1Database {
	const database = (env as { DB?: D1Database }).DB;
	if (!database) throw new HttpError(500, "MISCONFIGURED", "No DB binding configured");
	return database;
}

/** Creates any missing tables. Cheap after the first call in an isolate. */
export function ensureSchema(database: D1Database): Promise<void> {
	let pending = ready.get(database);
	if (!pending) {
		pending = database
			.batch([...AUTH_SCHEMA, ...APP_SCHEMA].map((sql) => database.prepare(sql)))
			.then(() => Promise.all(COLUMNS.map((sql) => database.prepare(sql).run().catch(ignoreDuplicateColumn))))
			.then(() => database.batch(LATE_INDEXES.map((sql) => database.prepare(sql))))
			.then(() => undefined)
			.catch((err) => {
				ready.delete(database);
				throw err;
			});
		ready.set(database, pending);
	}
	return pending;
}

function ignoreDuplicateColumn(err: unknown) {
	if (!/duplicate column/i.test(String(err))) throw err;
}

// ── Repositories ─────────────────────────────────────────────────────────────

export interface RepoRow {
	id: string;
	ownerId: string;
	owner: string;
	name: string;
	description: string | null;
	visibility: Visibility;
	defaultBranch: string;
	createdAt: string;
	bytes: number;
	/** The repository this one was forked from; null if it wasn't, or the source was deleted. */
	forkOf: string | null;
}

/** A repository with what lists and its page show: star and fork counts, and the fork's source. */
export interface RepoListing extends RepoRow {
	stars: number;
	forks: number;
	/** Whether the viewer has starred it (0 or 1). */
	starred: number;
	parentOwner: string | null;
	parentName: string | null;
	parentVisibility: Visibility | null;
	parentOwnerId: string | null;
}

/** GitHub's rule: letters, digits, '.', '-', '_'; not "." or "..", and not ending in ".git". */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function assertRepoName(name: string): string {
	if (!REPO_NAME.test(name) || name === "." || name === ".." || name.toLowerCase().endsWith(".git")) {
		throw new HttpError(400, "INVALID_NAME", "Repository names are 1-100 letters, digits, '.', '-' or '_', and can't end in .git.");
	}
	return name;
}

export async function findRepo(database: D1Database, owner: string, name: string): Promise<RepoRow | null> {
	return database.prepare(`select * from "repo" where "owner" = ? and "name" = ?`).bind(owner.toLowerCase(), name).first<RepoRow>();
}

/**
 * Records a new repository, unless its owner already has `maxRepos`. The count and the insert are one
 * statement, so concurrent creates can't both take the last slot.
 */
export async function insertRepo(database: D1Database, row: RepoRow, maxRepos: number, maxBytes: number): Promise<void> {
	let inserted: boolean;
	try {
		const result = await database
			.prepare(
				`insert into "repo" ("id", "ownerId", "owner", "name", "description", "visibility", "defaultBranch", "createdAt", "bytes", "forkOf")
				 select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 where (select count(*) from "repo" where "ownerId" = ?) < ?
				 and (select coalesce(sum("bytes"), 0) from "repo" where "ownerId" = ?) + ? <= ?`,
			)
			.bind(
				row.id, row.ownerId, row.owner, row.name, row.description, row.visibility, row.defaultBranch, row.createdAt, row.bytes, row.forkOf,
				row.ownerId, maxRepos,
				row.ownerId, row.bytes, maxBytes,
			)
			.run();
		inserted = result.meta.changes > 0;
	} catch (err) {
		if (/unique/i.test(String(err))) throw new HttpError(409, "ALREADY_EXISTS", `${row.owner}/${row.name} already exists`);
		throw err;
	}
	if (!inserted) {
		throw new HttpError(403, "QUOTA_EXCEEDED", `That would take you past ${maxRepos} repositories or your storage quota. Delete a repository to make room.`);
	}
}

/** Sets a repository's recorded size (after an import is measured). */
export async function setRepoBytes(database: D1Database, id: string, bytes: number): Promise<void> {
	await database.prepare(`update "repo" set "bytes" = ? where "id" = ?`).bind(bytes, id).run();
}

export async function updateRepo(database: D1Database, id: string, patch: { visibility?: Visibility; description?: string | null }): Promise<void> {
	if (patch.visibility !== undefined) await database.prepare(`update "repo" set "visibility" = ? where "id" = ?`).bind(patch.visibility, id).run();
	if (patch.description !== undefined) await database.prepare(`update "repo" set "description" = ? where "id" = ?`).bind(patch.description, id).run();
}

/** Adds a push's size to the repository's total. */
export async function addRepoBytes(database: D1Database, id: string, bytes: number): Promise<void> {
	await database.prepare(`update "repo" set "bytes" = "bytes" + ? where "id" = ?`).bind(bytes, id).run();
}

export async function deleteRepo(database: D1Database, id: string): Promise<void> {
	await database.prepare(`delete from "repo" where "id" = ?`).bind(id).run();
}

/** Repository columns plus counts; the one placeholder is the viewer's user id (for `starred`). */
const LISTING = `select r.*,
	(select count(*) from "star" s where s."repoId" = r."id") as "stars",
	(select count(*) from "repo" f where f."forkOf" = r."id" and (f."visibility" = 'public' or f."ownerId" = ?1)) as "forks",
	exists (select 1 from "star" s where s."repoId" = r."id" and s."userId" = ?1) as "starred",
	p."owner" as "parentOwner", p."name" as "parentName", p."visibility" as "parentVisibility", p."ownerId" as "parentOwnerId"
	from "repo" r left join "repo" p on p."id" = r."forkOf"`;

export async function getListing(database: D1Database, id: string, viewerId: string | null): Promise<RepoListing | null> {
	return database.prepare(`${LISTING} where r."id" = ?`).bind(viewerId ?? "", id).first<RepoListing>();
}

export interface ListOptions {
	owner?: string;
	viewerId?: string | null;
	/** Only repositories this user id has starred, most recently starred first. */
	starredBy?: string;
	/** Only forks of this repository id. */
	forksOf?: string;
	/** Matches owner, name or description (case-insensitive substring). */
	query?: string;
	sort?: "created" | "stars";
	limit?: number;
}

/** Public repositories plus, when `viewerId` is given, that user's private ones. Newest first unless sorted. */
export async function listRepos(database: D1Database, opts: ListOptions): Promise<RepoListing[]> {
	const where: string[] = [];
	const args: unknown[] = [opts.viewerId ?? ""];
	let join = "";
	if (opts.owner) {
		where.push(`r."owner" = ?`);
		args.push(opts.owner.toLowerCase());
	}
	if (opts.starredBy) {
		join = ` join "star" mine on mine."repoId" = r."id" and mine."userId" = ?`;
		args.splice(1, 0, opts.starredBy);
	}
	if (opts.forksOf) {
		where.push(`r."forkOf" = ?`);
		args.push(opts.forksOf);
	}
	if (opts.query) {
		where.push(`(r."owner" || '/' || r."name" || ' ' || coalesce(r."description", '')) like ? escape '\\'`);
		args.push(`%${opts.query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
	}
	where.push(`(r."visibility" = 'public' or r."ownerId" = ?)`);
	args.push(opts.viewerId ?? "");
	const order = opts.starredBy ? `mine."createdAt" desc` : opts.sort === "stars" ? `"stars" desc, r."createdAt" desc` : `r."createdAt" desc`;
	const listing = LISTING.replace(`left join "repo" p`, `${join} left join "repo" p`);
	const { results } = await database
		.prepare(`${listing} where ${where.join(" and ")} order by ${order} limit ?`)
		.bind(...args, opts.limit ?? 100)
		.all<RepoListing>();
	return results;
}

/** Stars or unstars; returns whether anything changed. */
export async function setStar(database: D1Database, userId: string, repoId: string, starred: boolean): Promise<boolean> {
	const result = starred
		? await database.prepare(`insert or ignore into "star" ("userId", "repoId", "createdAt") values (?, ?, ?)`).bind(userId, repoId, new Date().toISOString()).run()
		: await database.prepare(`delete from "star" where "userId" = ? and "repoId" = ?`).bind(userId, repoId).run();
	return result.meta.changes > 0;
}

export function toRepoInfo(row: RepoRow & Partial<RepoListing>, origin: string, canWrite: boolean, viewerId: string | null = null): RepoInfo {
	// Where a fork came from is shown only to people who can see the source.
	const parentVisible = row.parentOwner && (row.parentVisibility === "public" || row.parentOwnerId === viewerId);
	return {
		owner: row.owner,
		name: row.name,
		fullName: `${row.owner}/${row.name}`,
		description: row.description,
		visibility: row.visibility,
		defaultBranch: row.defaultBranch,
		createdAt: row.createdAt,
		cloneUrl: `${origin}/${row.owner}/${row.name}.git`,
		canWrite,
		stars: row.stars ?? 0,
		forks: row.forks ?? 0,
		starred: Boolean(row.starred),
		forkOf: parentVisible ? { owner: row.parentOwner as string, name: row.parentName as string } : null,
		sizeBytes: row.bytes,
	};
}

// ── Notifications ────────────────────────────────────────────────────────────

/** How many notifications a user keeps; older ones are dropped as new ones arrive. */
const KEEP_NOTIFICATIONS = 200;

/** Adds a notification for a user, about one of their repositories. */
export async function notifyUser(
	database: D1Database,
	n: { userId: string; kind: NotificationKind; repoId: string | null; title: string; url: string; actor: string | null },
): Promise<void> {
	await database.batch([
		database
			.prepare(`insert into "notification" ("id", "userId", "kind", "repoId", "title", "url", "actor", "createdAt") values (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(crypto.randomUUID(), n.userId, n.kind, n.repoId, n.title.slice(0, 300), n.url, n.actor, new Date().toISOString()),
		database
			.prepare(
				`delete from "notification" where "userId" = ? and "id" not in (select "id" from "notification" where "userId" = ? order by "createdAt" desc limit ?)`,
			)
			.bind(n.userId, n.userId, KEEP_NOTIFICATIONS),
	]);
}

/** From a repository's coordinator (which knows only the internal id): tells its owner. Admin projects have no owner. */
export async function notify(env: Env, repoId: string, n: { kind: NotificationKind; title: string; path: string }): Promise<void> {
	const database = db(env);
	await ensureSchema(database);
	const repo = await database.prepare(`select "ownerId", "owner", "name" from "repo" where "id" = ?`).bind(repoId).first<{ ownerId: string; owner: string; name: string }>();
	if (!repo) return;
	await notifyUser(database, { userId: repo.ownerId, kind: n.kind, repoId, title: n.title, url: `/${repo.owner}/${repo.name}/${n.path}`, actor: null });
}

/** Whether `actor` already caused this kind of notification about this repository in the last day (star, unstar, star again). */
export async function notifiedRecently(database: D1Database, userId: string, kind: NotificationKind, repoId: string, actor: string): Promise<boolean> {
	const since = new Date(Date.now() - 24 * 3600_000).toISOString();
	const row = await database
		.prepare(`select 1 from "notification" where "userId" = ? and "kind" = ? and "repoId" = ? and "actor" = ? and "createdAt" > ? limit 1`)
		.bind(userId, kind, repoId, actor, since)
		.first();
	return row !== null;
}

export async function listNotifications(database: D1Database, userId: string, unreadOnly: boolean): Promise<{ notifications: Notification[]; unread: number }> {
	const [list, count] = await database.batch<Record<string, unknown>>([
		database
			.prepare(
				`select n."id", n."kind", n."title", n."url", n."actor", n."createdAt", n."readAt", r."owner" || '/' || r."name" as "repo"
				 from "notification" n left join "repo" r on r."id" = n."repoId"
				 where n."userId" = ? ${unreadOnly ? `and n."readAt" is null` : ""} order by n."createdAt" desc limit 100`,
			)
			.bind(userId),
		database.prepare(`select count(*) as "n" from "notification" where "userId" = ? and "readAt" is null`).bind(userId),
	]);
	return { notifications: list.results as unknown as Notification[], unread: Number((count.results[0] as { n: number } | undefined)?.n ?? 0) };
}

/** Marks some (or, with no ids, all) of a user's notifications read. */
export async function markRead(database: D1Database, userId: string, ids?: string[]): Promise<void> {
	const now = new Date().toISOString();
	if (!ids) {
		await database.prepare(`update "notification" set "readAt" = ? where "userId" = ? and "readAt" is null`).bind(now, userId).run();
		return;
	}
	if (ids.length === 0) return;
	await database
		.prepare(`update "notification" set "readAt" = ? where "userId" = ? and "readAt" is null and "id" in (${ids.map(() => "?").join(", ")})`)
		.bind(now, userId, ...ids)
		.run();
}

// ── Personal access tokens ───────────────────────────────────────────────────

export const TOKEN_PREFIX = "megit_pat_";

export interface TokenInfo {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mints a token. Only its hash is stored; the plaintext is returned once. */
export async function createToken(database: D1Database, userId: string, name: string): Promise<{ token: string; info: TokenInfo }> {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const token = TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	const info: TokenInfo = { id: crypto.randomUUID(), name, prefix: token.slice(0, TOKEN_PREFIX.length + 4), createdAt: new Date().toISOString(), lastUsedAt: null };
	await database
		.prepare(`insert into "token" ("id", "userId", "name", "hash", "prefix", "createdAt") values (?, ?, ?, ?, ?, ?)`)
		.bind(info.id, userId, name, await sha256(token), info.prefix, info.createdAt)
		.run();
	return { token, info };
}

export async function listTokens(database: D1Database, userId: string): Promise<TokenInfo[]> {
	const { results } = await database
		.prepare(`select "id", "name", "prefix", "createdAt", "lastUsedAt" from "token" where "userId" = ? order by "createdAt" desc`)
		.bind(userId)
		.all<TokenInfo>();
	return results;
}

export async function revokeToken(database: D1Database, userId: string, id: string): Promise<boolean> {
	const result = await database.prepare(`delete from "token" where "id" = ? and "userId" = ?`).bind(id, userId).run();
	return result.meta.changes > 0;
}

/** The user a token belongs to, or null. Records when it was last used (at most once a minute). */
export async function userForToken(database: D1Database, token: string): Promise<{ id: string; username: string; verified: boolean } | null> {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const row = await database
		.prepare(`select "token"."id" as "tokenId", "token"."lastUsedAt", "user"."id", "user"."username", "user"."emailVerified" from "token" join "user" on "user"."id" = "token"."userId" where "token"."hash" = ?`)
		.bind(await sha256(token))
		.first<{ tokenId: string; lastUsedAt: string | null; id: string; username: string | null; emailVerified: number }>();
	if (!row?.username) return null;
	if (!row.lastUsedAt || Date.parse(row.lastUsedAt) < Date.now() - 60_000) {
		await database.prepare(`update "token" set "lastUsedAt" = ? where "id" = ?`).bind(new Date().toISOString(), row.tokenId).run();
	}
	return { id: row.id, username: row.username, verified: Boolean(row.emailVerified) };
}
